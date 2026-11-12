import { color } from '../vector/scene';
import { flatten, parsePath, pathLength, pointAtLength } from '../vector/path';
import { parseTransform } from '../vector/math';
/** Deterministic clock driven by the Render Graph frame, never wall-clock time. */
export function clock(value: string): number {
    value = value.trim();
    if (value === 'indefinite')
        return Infinity;
    if (/^\d+(?::\d+){1,2}(?:\.\d+)?$/.test(value))
        return value.split(':').reduce((n, v) => n * 60 + Number(v), 0);
    const m = /^([+-]?(?:\d*\.\d+|\d+\.?\d*))(ms|s|min|h)?$/.exec(value);
    if (!m)
        throw new Error(`Unsupported SVG animation clock: ${value}`);
    return Number(m[1]) * ({ ms: .001, s: 1, min: 60, h: 3600 }[m[2] ?? 's'] ?? 1);
}
function spline(t: number, values: number[]): number {
    if (values.length !== 4)
        throw new Error('keySplines requires four values per interval');
    const [x1, y1, x2, y2] = values;
    const bez = (u: number, a: number, b: number) => 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
        const u = (lo + hi) / 2;
        if (bez(u, x1, x2) < t)
            lo = u;
        else
            hi = u;
    }
    return bez((lo + hi) / 2, y1, y2);
}
export function interpolate(a: string, b: string, t: number): string {
    if (a === b)
        return a;
    if (/^(#|rgb|hsl|[a-z]+$)/i.test(a) && /^(#|rgb|hsl|[a-z]+$)/i.test(b)) {
        try {
            const x = color(a), y = color(b), c = x.map((v, i) => v + (y[i] - v) * t);
            return `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})`;
        }
        catch { /* Non-color keywords use discrete interpolation. */
        }
    }
    const re = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi, x = a.match(re)?.map(Number), y = b.match(re)?.map(Number);
    if (!x || !y || x.length !== y.length || a.replace(re, '@').replace(/[\s,]+/g, '') !== b.replace(re, '@').replace(/[\s,]+/g, ''))
        return t < 1 ? a : b;
    let at = 0;
    return a.replace(re, () => String(x[at] + (y[at] - x[at++]) * t));
}
export interface AnimationValue {
    target: Element;
    attribute: string;
    value: string;
}
export function evaluateAnimation(element: Element, time: number, lookup: (id: string) => Element | undefined): AnimationValue | undefined {
    const href = element.getAttribute('href') ?? element.getAttribute('xlink:href'), target = href?.startsWith('#') ? lookup(href.slice(1)) : element.parentElement;
    if (!target)
        throw new Error('SVG animation target does not exist');
    const begin = Math.min(...(element.getAttribute('begin') ?? '0s').split(';').map(clock));
    if (time < begin)
        return undefined;
    const duration = element.localName === 'set' ? clock(element.getAttribute('dur') ?? 'indefinite') : clock(element.getAttribute('dur') ?? '0s');
    if (duration <= 0)
        return undefined;
    const repeats = element.getAttribute('repeatCount') ?? '1', repeatCount = repeats === 'indefinite' ? Infinity : Number(repeats);
    if (!(repeatCount > 0))
        throw new Error('Invalid repeatCount');
    const repeatDuration = clock(element.getAttribute('repeatDur') ?? 'indefinite'), end = clock(element.getAttribute('end') ?? 'indefinite'), active = Math.min(duration * repeatCount, repeatDuration, end - begin);
    let elapsed = time - begin;
    if (elapsed >= active) {
        if (element.getAttribute('fill') !== 'freeze')
            return undefined;
        elapsed = Math.max(0, active - 1e-10);
    }
    let progress = Number.isFinite(duration) ? (elapsed % duration) / duration : 0;
    const name = element.localName, attribute = name === 'animateTransform' || name === 'animateMotion' ? 'transform' : element.getAttribute('attributeName');
    if (!attribute)
        throw new Error('SVG animate requires attributeName');
    if (name === 'animateMotion') {
        let d = element.getAttribute('path');
        const mpath = element.querySelector('mpath');
        if (mpath) {
            const href = mpath.getAttribute('href') ?? mpath.getAttribute('xlink:href');
            d = href?.startsWith('#') ? lookup(href.slice(1))?.getAttribute('d') ?? null : null;
        }
        if (!d)
            throw new Error('animateMotion requires a path');
        const contours = flatten(parsePath(d)), point = pointAtLength(contours, pathLength(contours) * progress), rotate = element.getAttribute('rotate') ?? '0';
        let angle = rotate.startsWith('auto') ? Math.atan2(point.tangent[1], point.tangent[0]) * 180 / Math.PI : Number(rotate);
        if (rotate === 'auto-reverse')
            angle += 180;
        return { target, attribute, value: `${target.getAttribute('transform') ?? ''} translate(${point.point.join(' ')}) rotate(${angle})` };
    }
    const base = target.getAttribute(attribute) ?? '', from = element.getAttribute('from') ?? base, to = element.getAttribute('to'), by = element.getAttribute('by');
    let values = (element.getAttribute('values') ?? '').split(';').map(v => v.trim()).filter(Boolean);
    if (name === 'set')
        values = [element.getAttribute('to') ?? base];
    if (!values.length) {
        if (to !== null)
            values = [from, to];
        else if (by !== null) {
            const n = Number(from || 0), delta = Number(by);
            if (!Number.isFinite(n + delta))
                throw new Error('SVG by animation requires numeric values');
            values = [String(n), String(n + delta)];
        }
        else
            throw new Error('SVG animate requires values, to or by');
    }
    const times = (element.getAttribute('keyTimes') ?? '').split(';').filter(Boolean).map(Number);
    if (element.getAttribute('calcMode') === 'paced' && values.length > 1) {
        const distances = [0];
        let total = 0;
        for (let i = 1; i < values.length; i++) {
            const x = values[i - 1].match(/[+-]?(?:\d*\.\d+|\d+\.?\d*)/g)?.map(Number) ?? [], y = values[i].match(/[+-]?(?:\d*\.\d+|\d+\.?\d*)/g)?.map(Number) ?? [];
            total += x.length === y.length && x.length ? Math.hypot(...x.map((v, j) => y[j] - v)) : 1;
            distances.push(total);
        }
        times.splice(0, times.length, ...distances.map((d, i) => total ? d / total : i / (values.length - 1)));
    }
    if (times.length && times.length !== values.length)
        throw new Error('keyTimes must match values');
    if (!times.length)
        values.forEach((_, i) => times.push(values.length > 1 ? i / (element.getAttribute('calcMode') === 'discrete' ? values.length : values.length - 1) : 0));
    if (times.some((t, i) => t < 0 || t > 1 || i > 0 && t < times[i - 1]))
        throw new Error('Invalid SVG keyTimes');
    let interval = 0;
    while (interval < times.length - 1 && progress >= times[interval + 1])
        interval++;
    const mode = element.getAttribute('calcMode') ?? 'linear', span = (times[interval + 1] ?? 1) - times[interval], local = span ? (progress - times[interval]) / span : 0;
    progress = mode === 'discrete' ? 0 : Math.max(0, Math.min(1, local));
    if (mode === 'spline') {
        const splines = (element.getAttribute('keySplines') ?? '').split(';');
        progress = spline(progress, (splines[interval] ?? '').trim().split(/[\s,]+/).map(Number));
    }
    else if (mode !== 'linear' && mode !== 'discrete' && mode !== 'paced')
        throw new Error(`Invalid SVG calcMode: ${mode}`);
    let value = interpolate(values[interval], values[Math.min(interval + 1, values.length - 1)], progress);
    if (name === 'animateTransform') {
        const type = element.getAttribute('type') ?? 'translate';
        value = `${type}(${value})`;
        parseTransform(value);
        if (element.getAttribute('additive') === 'sum')
            value = `${base} ${value}`;
    }
    else if (element.getAttribute('additive') === 'sum') {
        const n = Number(base) + Number(value);
        if (!Number.isFinite(n))
            throw new Error('Additive SVG animation requires numeric values');
        value = String(n);
    }
    return { target, attribute, value };
}

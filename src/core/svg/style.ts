export type Style = Record<string, string>;
export const defaults: Style = {
    fill: 'black', stroke: 'none', color: 'black', 'fill-rule': 'nonzero', 'clip-rule': 'nonzero', 'fill-opacity': '1', 'stroke-opacity': '1', 'stroke-width': '1', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter', 'stroke-miterlimit': '4', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0', visibility: 'visible', 'font-size': '16', 'font-family': 'sans-serif', 'font-weight': 'normal', 'font-style': 'normal', 'text-anchor': 'start', 'letter-spacing': '0', 'color-interpolation': 'sRGB', 'color-interpolation-filters': 'linearRGB', 'paint-order': 'normal', 'vector-effect': 'none', 'mask-type': 'luminance', 'marker-start': 'none', 'marker-mid': 'none', 'marker-end': 'none', 'lighting-color': 'white', 'dominant-baseline': 'auto', 'alignment-baseline': 'baseline', 'baseline-shift': 'baseline', 'font-synthesis': 'weight style', 'font-variation-settings': 'normal', 'font-stretch': 'normal', 'font-optical-sizing': 'auto', 'font-feature-settings': 'normal', 'font-kerning': 'auto', 'font-variant-ligatures': 'normal', 'white-space': 'normal', 'writing-mode': 'horizontal-tb', 'text-orientation': 'mixed', direction: 'ltr', 'unicode-bidi': 'normal'
};
const local: Style = {
    opacity: '1', display: 'inline', overflow: 'hidden', 'clip-path': 'none', mask: 'none', filter: 'none', 'mix-blend-mode': 'normal', isolation: 'auto', transform: '', 'transform-origin': '0 0', 'transform-box': 'view-box', 'vector-effect': 'none'
};
export interface CssRule {
    selector: string;
    declarations: Array<[
        string,
        string,
        boolean
    ]>;
    specificity: number;
    order: number;
}
export function declarations(source: string): Array<[
    string,
    string,
    boolean
]> {
    const parts: string[] = [];
    let start = 0, depth = 0, quote = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (quote) {
            if (c === quote && source[i - 1] !== String.fromCharCode(92))
                quote = '';
        }
        else if (c === '"' || c === "'")
            quote = c;
        else if (c === '(')
            depth++;
        else if (c === ')')
            depth--;
        else if (c === ';' && depth === 0) {
            parts.push(source.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(source.slice(start));
    return parts.flatMap(part => {
        const at = part.indexOf(':');
        if (at < 0)
            return [];
        const rawKey = part.slice(0, at).trim(), key = rawKey.startsWith('--') ? rawKey : rawKey.toLowerCase(), raw = part.slice(at + 1).trim(), important = /\s*!important\s*$/i.test(raw);
        return key ? [[key, raw.replace(/\s*!important\s*$/i, ''), important] as [
                string,
                string,
                boolean
            ]] : [];
    });
}
export interface SvgFontSource {
    family: string;
    weight: string;
    style: string;
    source: string;
}
export function extractFontFaces(source: string): {
    css: string;
    fonts: SvgFontSource[];
} {
    const fonts: SvgFontSource[] = [];
    const css = source.replace(/@font-face\s*\{([^{}]*)\}/gi, (_, body: string) => {
        const d = Object.fromEntries(declarations(body).map(([k, v]) => [k, v]));
        const candidates = [...(d.src ?? '').matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)], match = candidates.find((m, i) => {
            const url = m[1] ?? m[2] ?? m[3].trim(), suffix = (d.src ?? '').slice(m.index! + m[0].length, candidates[i + 1]?.index);
            return !/\.woff2(?:[?#]|$)|^data:[^;,]*woff2/i.test(url) && !/format\(\s*["']?woff2/i.test(suffix);
        }) ?? candidates[0];
        if (!match && !/local\(/i.test(d.src ?? ''))
            throw new Error('SVG @font-face requires a font URL or registered local face');
        const family = (d['font-family'] ?? '').trim().replace(/^["']|["']$/g, '');
        if (!family)
            throw new Error('SVG @font-face requires font-family');
        const raw = d['font-weight'] ?? '400';
        fonts.push({ family, weight: raw === 'normal' ? '400' : raw === 'bold' ? '700' : raw, style: d['font-style'] ?? 'normal', source: match ? (match[1] ?? match[2] ?? match[3].trim()) : '' });
        return '';
    }).replace(/@namespace[^;]+;/gi, '');
    if (fonts.length > 64)
        throw new Error('SVG font-face budget exceeded');
    return { css, fonts };
}
export function parseCss(source: string): CssRule[] {
    source = source.replace(/\/\*[\s\S]*?\*\//g, '');
    if (source.includes('@'))
        throw new Error('SVG CSS at-rules are not supported');
    const rules: CssRule[] = [];
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of match[1].split(',')) {
            const s = selector.trim();
            const ids = (s.match(/#[\w-]+/g) ?? []).length, classes = (s.match(/[.\[:]/g) ?? []).length, tags = (s.match(/(^|[\s>+~])\s*[a-zA-Z][\w-]*/g) ?? []).length;
            rules.push({ selector: s, declarations: declarations(match[2]), specificity: ids * 10000 + classes * 100 + tags, order: rules.length });
        }
    }
    return rules;
}
export function computeStyle(element: Element, parent: Style, rules: CssRule[]): Style {
    const result: Style = { ...defaults, ...parent, ...local };
    const geometry = ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'd'];
    for (const key of geometry)
        delete result[key];
    const ranks = new Map<string, [
        number,
        number
    ]>();
    const assign = (key: string, value: string, important: boolean, specificity: number, order: number) => {
        const score = specificity + (important ? 1e8 : 0), rank = ranks.get(key);
        if (rank && (rank[0] > score || (rank[0] === score && rank[1] > order)))
            return;
        ranks.set(key, [score, order]);
        result[key] = value;
    };
    for (const name of [...Object.keys(defaults), ...Object.keys(local), 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'transform', ...geometry])
        if (element.hasAttribute(name))
            assign(name, element.getAttribute(name)!, false, 0, -1);
    for (const rule of rules) {
        let matches = false;
        try {
            matches = element.matches(rule.selector);
        }
        catch {
            throw new Error(`Invalid SVG CSS selector: ${rule.selector}`);
        }
        if (matches)
            for (const [k, v, i] of rule.declarations)
                assign(k, v, i, rule.specificity, rule.order);
    }
    for (const [k, v, i] of declarations(element.getAttribute('style') ?? ''))
        assign(k, v, i, 1000000, rules.length);
    for (const [k, v] of Object.entries(result)) {
        if (v === 'inherit')
            result[k] = parent[k] ?? defaults[k] ?? local[k] ?? '';
        else if (v === 'initial' || v === 'unset')
            result[k] = v === 'unset' && k in defaults ? (parent[k] ?? defaults[k]) : defaults[k] ?? local[k] ?? '';
    }
    if (result['font-weight'] === 'bolder' || result['font-weight'] === 'lighter') {
        const raw = parent['font-weight'] ?? '400', weight = raw === 'normal' ? 400 : raw === 'bold' ? 700 : Number(raw);
        result['font-weight'] = String(result['font-weight'] === 'bolder' ? weight < 350 ? 400 : weight < 550 ? 700 : 900 : weight < 550 ? 100 : weight < 750 ? 400 : 700);
    }
    const resolve = (value: string, seen = new Set<string>()): string => {
        let output = '', at = 0;
        for (;;) {
            const index = value.indexOf('var(', at);
            if (index < 0)
                return output + value.slice(at);
            output += value.slice(at, index);
            let end = index + 4, depth = 1;
            for (; end < value.length && depth; end++) {
                if (value[end] === '(')
                    depth++;
                if (value[end] === ')')
                    depth--;
            }
            if (depth)
                throw new Error('Unclosed CSS var()');
            const body = value.slice(index + 4, end - 1);
            let comma = -1, nested = 0;
            for (let i = 0; i < body.length; i++) {
                if (body[i] === '(')
                    nested++;
                if (body[i] === ')')
                    nested--;
                if (body[i] === ',' && !nested) {
                    comma = i;
                    break;
                }
            }
            const key = (comma < 0 ? body : body.slice(0, comma)).trim(), fallback = comma < 0 ? undefined : body.slice(comma + 1).trim();
            const next = result[key];
            if (seen.has(key) || next === undefined) {
                if (fallback === undefined)
                    throw new Error(`Unresolved CSS custom property ${key}`);
                output += resolve(fallback, seen);
            }
            else
                output += resolve(next, new Set([...seen, key]));
            at = end;
        }
    };
    for (const [key, value] of Object.entries(result))
        if (!key.startsWith('--'))
            result[key] = resolve(value);
    return result;
}
/** Unit resolution is explicit: percentages use the property-specific reference. */
export function length(value: string | undefined, reference: number, fontSize = 16, fallback = 0): number {
    if (value === undefined || value === '')
        return fallback;
    if (/^(calc|min|max|clamp)\(/.test(value.trim())) {
        const source = value.trim();
        let at = 0, depth = 0;
        const skip = () => {
            while (/\s/.test(source[at] ?? '') && at < source.length)
                at++;
        };
        const atom = (): number => {
            skip();
            if (++depth > 64)
                throw new Error('CSS math nesting exceeded');
            let result: number;
            if (source[at] === '+' || source[at] === '-') {
                const sign = source[at++];
                result = (sign === '-' ? -1 : 1) * atom();
            }
            else {
                const fn = /^(calc|min|max|clamp)\(/.exec(source.slice(at));
                if (fn) {
                    at += fn[0].length;
                    const args = [sum()];
                    skip();
                    while (source[at] === ',') {
                        at++;
                        args.push(sum());
                        skip();
                    }
                    if (source[at++] !== ')')
                        throw new Error('Unclosed CSS math function');
                    if (fn[1] === 'calc') {
                        if (args.length !== 1)
                            throw new Error('calc requires one expression');
                        result = args[0];
                    }
                    else if (fn[1] === 'min')
                        result = Math.min(...args);
                    else if (fn[1] === 'max')
                        result = Math.max(...args);
                    else {
                        if (args.length !== 3)
                            throw new Error('clamp requires three values');
                        result = Math.max(args[0], Math.min(args[1], args[2]));
                    }
                }
                else if (source[at] === '(') {
                    at++;
                    result = sum();
                    skip();
                    if (source[at++] !== ')')
                        throw new Error('Unclosed CSS math expression');
                }
                else {
                    const token = /^(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(?:%|px|pt|pc|mm|cm|in|em|ex)?/i.exec(source.slice(at));
                    if (!token)
                        throw new Error(`Invalid CSS math at ${at}`);
                    at += token[0].length;
                    result = length(token[0], reference, fontSize);
                }
            }
            depth--;
            return result;
        };
        const product = (): number => {
            let n = atom();
            for (;;) {
                skip();
                const op = source[at];
                if (op !== '*' && op !== '/')
                    return n;
                at++;
                const right = atom();
                n = op === '*' ? n * right : n / right;
            }
        };
        const sum = (): number => {
            let n = product();
            for (;;) {
                skip();
                const op = source[at];
                if (op !== '+' && op !== '-')
                    return n;
                at++;
                const right = product();
                n = op === '+' ? n + right : n - right;
            }
        };
        const result = sum();
        skip();
        if (at !== source.length || !Number.isFinite(result))
            throw new Error('Invalid CSS math result');
        return result;
    }
    const m = /^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)\s*(%|px|pt|pc|mm|cm|in|em|ex)?$/i.exec(value.trim());
    if (!m)
        throw new Error(`Invalid SVG length: ${value}`);
    const units: Record<string, number> = {
        '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: fontSize, ex: fontSize * .5, '%': reference / 100
    };
    const n = Number(m[1]) * units[(m[2] ?? '').toLowerCase()];
    if (!Number.isFinite(n))
        throw new Error('Non-finite SVG length');
    return n;
}
export function opacity(value: string | undefined): number {
    return Math.max(0, Math.min(1, length(value, 1, 16, 1)));
}

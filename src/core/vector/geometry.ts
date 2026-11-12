export const unitQuad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
import type { Point } from './math';
import type { Contour } from './path';
export type FillRule = 'nonzero' | 'evenodd';
interface Edge {
    a: Point;
    b: Point;
    min: number;
    max: number;
    winding: number;
}
const EPS = 1e-9;
const xAt = (edge: Edge, y: number) => edge.a[0] + (y - edge.a[1]) * (edge.b[0] - edge.a[0]) / (edge.b[1] - edge.a[1]);
/** Scan bands are split at every vertex and proper intersection. Within a band,
 * sorted edge order is constant, so winding intervals form disjoint trapezoids.
 * This handles concavity, holes and self intersections without contour guessing. */
export function tessellate(contours: Contour[], rule: FillRule = 'nonzero'): Float32Array {
    const edges: Edge[] = [], events: number[] = [];
    if (contours.some(c => c.points.some(p => !p.every(Number.isFinite))))
        throw new Error("Non-finite path geometry");
    for (const contour of contours) {
        const p = contour.points;
        for (let i = 0; i < p.length; i++) {
            const a = p[i], b = p[(i + 1) % p.length];
            events.push(a[1]);
            if (Math.abs(a[1] - b[1]) > EPS)
                edges.push({
                    a, b, min: Math.min(a[1], b[1]), max: Math.max(a[1], b[1]), winding: b[1] > a[1] ? 1 : -1
                });
        }
    }
    if (edges.length > 12000)
        throw new Error('Vector fill exceeds 12000 nonhorizontal edges');
    const sorted = [...edges].sort((a, b) => a.min - b.min);
    let comparisons = 0;
    for (let i = 0; i < sorted.length; i++)
        for (let j = i + 1; j < sorted.length && sorted[j].min < sorted[i].max; j++) {
            if (++comparisons > 16000000)
                throw new Error('Vector intersection budget exceeded');
            const a = sorted[i], b = sorted[j], lo = Math.max(a.min, b.min), hi = Math.min(a.max, b.max);
            if (hi - lo <= EPS)
                continue;
            const d0 = xAt(a, lo) - xAt(b, lo), d1 = xAt(a, hi) - xAt(b, hi);
            if (d0 * d1 < 0) {
                const y = lo + (hi - lo) * d0 / (d0 - d1);
                if (Number.isFinite(y))
                    events.push(y);
            }
        }
    events.sort((a, b) => a - b);
    const ys = events.filter((y, i) => !i || y - events[i - 1] > EPS), vertices: number[] = [];
    for (let i = 1; i < ys.length; i++) {
        const top = ys[i - 1], bottom = ys[i], mid = (top + bottom) / 2;
        const active = edges.filter(e => e.min < mid && e.max > mid).sort((a, b) => xAt(a, mid) - xAt(b, mid));
        let winding = 0, left: Edge | undefined;
        for (let j = 0; j < active.length;) {
            const edge = active[j], x = xAt(edge, mid);
            let delta = 0, count = 0;
            do {
                delta += active[j].winding;
                count++;
                j++;
            } while (j < active.length && Math.abs(xAt(active[j], mid) - x) < EPS);
            const was = rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0;
            winding += rule === 'evenodd' ? count : delta;
            const inside = rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0;
            if (!was && inside)
                left = edge;
            if (was && !inside && left) {
                const a = xAt(left, top), b = xAt(edge, top), c = xAt(left, bottom), d = xAt(edge, bottom);
                vertices.push(a, top, b, top, c, bottom, c, bottom, b, top, d, bottom);
                left = undefined;
            }
        }
        if (vertices.length > 6000000)
            throw new Error('Vector triangle budget exceeded');
    }
    const result = new Float32Array(vertices);
    if (!result.every(Number.isFinite))
        throw new Error("Vector coordinates exceed float32 range");
    return result;
}
export function contains(contours: Contour[], point: Point, rule: FillRule = 'nonzero'): boolean {
    let winding = 0;
    for (const c of contours)
        for (let i = 0; i < c.points.length; i++) {
            const a = c.points[i], b = c.points[(i + 1) % c.points.length];
            if ((a[1] <= point[1] && b[1] > point[1]) || (b[1] <= point[1] && a[1] > point[1])) {
                const x = a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
                if (x > point[0])
                    winding += b[1] > a[1] ? 1 : -1;
            }
        }
    return rule === 'evenodd' ? Math.abs(winding) % 2 === 1 : winding !== 0;
}
export interface StrokeStyle {
    width: number;
    cap: 'butt' | 'round' | 'square';
    join: 'miter' | 'round' | 'bevel';
    miterLimit: number;
    dash: number[];
    dashOffset: number;
}
function polygon(points: Point[]): Contour {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        area += a[0] * b[1] - b[0] * a[1];
    }
    return { points: area < 0 ? points.reverse() : points, closed: true };
}
function dashed(c: Contour, pattern: number[], offset: number): Contour[] {
    if (!pattern.length)
        return [c];
    if (pattern.some(n => n < 0 || !Number.isFinite(n)))
        throw new Error('Invalid stroke dash array');
    if (pattern.length % 2)
        pattern = [...pattern, ...pattern];
    const sum = pattern.reduce((a, b) => a + b, 0);
    if (!sum)
        return [c];
    offset = ((offset % sum) + sum) % sum;
    let index = 0;
    while (offset >= pattern[index]) {
        offset -= pattern[index];
        index = (index + 1) % pattern.length;
    }
    let remaining = pattern[index] - offset, current: Point[] = [], out: Contour[] = [];
    const pts = c.closed ? [...c.points, c.points[0]] : c.points;
    const flush = () => {
        if (current.length > 1)
            out.push({ points: current, closed: false });
        current = [];
    };
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (!len)
            continue;
        let at = 0;
        while (at < len - EPS) {
            if (remaining <= EPS) {
                if (index % 2 === 0)
                    flush();
                index = (index + 1) % pattern.length;
                remaining = pattern[index];
                continue;
            }
            const take = Math.min(remaining, len - at), p: Point = [a[0] + dx * at / len, a[1] + dy * at / len];
            at += take;
            const q: Point = [a[0] + dx * at / len, a[1] + dy * at / len];
            if (index % 2 === 0) {
                if (!current.length)
                    current.push(p);
                current.push(q);
            }
            remaining -= take;
            if (out.length > 100000)
                throw new Error('Stroke dash budget exceeded');
        }
    }
    flush();
    if (c.closed && out.length > 1) {
        const first = out[0], last = out.at(-1)!;
        if (Math.hypot(first.points[0][0] - last.points.at(-1)![0], first.points[0][1] - last.points.at(-1)![1]) < EPS) {
            last.points.push(...first.points.slice(1));
            out.shift();
        }
    }
    if (c.closed && out.length === 1) {
        const p = out[0].points;
        if (Math.hypot(p[0][0] - p.at(-1)![0], p[0][1] - p.at(-1)![1]) < EPS) {
            p.pop();
            out[0].closed = true;
        }
    }
    return out;
}
/** Stroke pieces share winding; tessellating their union prevents alpha build-up. */
export function strokeContours(contours: Contour[], style: StrokeStyle, tolerance = .25): Contour[] {
    if (style.width <= 0)
        return [];
    const out: Contour[] = [], r = style.width / 2;
    const disk = (p: Point) => {
        const n = Math.max(12, Math.min(1024, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - Math.min(tolerance, r) / r)))));
        out.push(polygon(Array.from({ length: n }, (_, i) => [p[0] + r * Math.cos(i * 2 * Math.PI / n), p[1] + r * Math.sin(i * 2 * Math.PI / n)])));
    };
    for (const source of contours)
        for (const c of dashed(source, style.dash, style.dashOffset)) {
            const p = c.points;
            if (!p.length)
                continue;
            if (p.length === 1) {
                if (style.cap === 'round')
                    disk(p[0]);
                else if (style.cap === 'square')
                    out.push(polygon([[p[0][0] - r, p[0][1] - r], [p[0][0] + r, p[0][1] - r], [p[0][0] + r, p[0][1] + r], [p[0][0] - r, p[0][1] + r]]));
                continue;
            }
            const dirs: Point[] = [], normals: Point[] = [];
            const count = c.closed ? p.length : p.length - 1;
            for (let i = 0; i < count; i++) {
                const a = p[i], b = p[(i + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const d: Point = l ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0];
                dirs.push(d);
                normals.push([-d[1] * r, d[0] * r]);
                const n = normals[i], start = !c.closed && i === 0 && style.cap === 'square' ? -r : 0, end = !c.closed && i === count - 1 && style.cap === 'square' ? r : 0;
                out.push(polygon([[a[0] + n[0] + d[0] * start, a[1] + n[1] + d[1] * start], [b[0] + n[0] + d[0] * end, b[1] + n[1] + d[1] * end], [b[0] - n[0] + d[0] * end, b[1] - n[1] + d[1] * end], [a[0] - n[0] + d[0] * start, a[1] - n[1] + d[1] * start]]));
            }
            for (let i = c.closed ? 0 : 1; i < (c.closed ? p.length : p.length - 1); i++) {
                const prev = (i - 1 + count) % count, next = i % count, a = normals[prev], b = normals[next], d = dirs[prev], e = dirs[next], cross = d[0] * e[1] - d[1] * e[0], q = p[i];
                if (Math.abs(cross) < EPS)
                    continue;
                if (style.join === 'round') {
                    disk(q);
                    continue;
                }
                const side = cross > 0 ? -1 : 1, v: Point = [q[0] + a[0] * side, q[1] + a[1] * side], w: Point = [q[0] + b[0] * side, q[1] + b[1] * side];
                let corner: Point = q;
                if (style.join === 'miter') {
                    const t = ((w[0] - v[0]) * e[1] - (w[1] - v[1]) * e[0]) / cross, m: Point = [v[0] + t * d[0], v[1] + t * d[1]];
                    if (Math.hypot(m[0] - q[0], m[1] - q[1]) <= style.miterLimit * r)
                        corner = m;
                }
                out.push(polygon(corner === q ? [q, v, w] : [q, v, corner, w]));
            }
            if (!c.closed && style.cap === 'round') {
                disk(p[0]);
                disk(p.at(-1)!);
            }
        }
    return out;
}

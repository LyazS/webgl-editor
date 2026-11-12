import { type Matrix, type Point, identity, maxScale, transformPoint } from './math';
export type Segment = {
    op: 'M' | 'L';
    p: Point;
} | {
    op: 'C';
    a: Point;
    b: Point;
    p: Point;
} | {
    op: 'Q';
    a: Point;
    p: Point;
} | {
    op: 'Z';
};
export interface Contour {
    points: Point[];
    closed: boolean;
}
const same = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-10;
/** Strict SVG path scanner; arc flags are single characters, including compact 01 syntax. */
export function parsePath(source: string): Segment[] {
    let at = 0, command = '', current: Point = [0, 0], start: Point = [0, 0], control: Point = [0, 0], previous = '';
    const result: Segment[] = [];
    const skip = () => {
        while (/[\s,]/.test(source[at] ?? '') && at < source.length)
            at++;
    };
    const num = () => {
        skip();
        const m = /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/i.exec(source.slice(at));
        if (!m)
            throw new Error(`Path number expected at ${at}`);
        at += m[0].length;
        const n = Number(m[0]);
        if (!Number.isFinite(n))
            throw new Error('Non-finite path number');
        return n;
    };
    const flag = () => {
        skip();
        const c = source[at++];
        if (c !== '0' && c !== '1')
            throw new Error('Arc flags must be 0 or 1');
        return c === '1';
    };
    while (at < source.length) {
        skip();
        if (at === source.length)
            break;
        if (/[a-z]/i.test(source[at]))
            command = source[at++];
        if (!command || !'MmLlHhVvCcSsQqTtAaZz'.includes(command))
            throw new Error(`Invalid path command at ${at}`);
        const op = command.toUpperCase(), relative = command !== op, origin = current;
        const point = (): Point => {
            const x = num(), y = num();
            return [x + (relative ? origin[0] : 0), y + (relative ? origin[1] : 0)];
        };
        if (!result.length && op !== 'M')
            throw new Error('Path must begin with moveto');
        if (op === 'Z') {
            result.push({ op: 'Z' });
            current = [...start];
            command = '';
        }
        else if (op === 'M') {
            current = point();
            start = [...current];
            result.push({ op: 'M', p: current });
            command = relative ? 'l' : 'L';
        }
        else if (op === 'L') {
            current = point();
            result.push({ op: 'L', p: current });
        }
        else if (op === 'H') {
            current = [num() + (relative ? origin[0] : 0), origin[1]];
            result.push({ op: 'L', p: current });
        }
        else if (op === 'V') {
            current = [origin[0], num() + (relative ? origin[1] : 0)];
            result.push({ op: 'L', p: current });
        }
        else if (op === 'C' || op === 'S') {
            const a = op === 'C' ? point() : (previous === 'C' || previous === 'S' ? [2 * origin[0] - control[0], 2 * origin[1] - control[1]] : origin) as Point, b = point(), p = point();
            result.push({ op: 'C', a, b, p });
            control = b;
            current = p;
        }
        else if (op === 'Q' || op === 'T') {
            const a = op === 'Q' ? point() : (previous === 'Q' || previous === 'T' ? [2 * origin[0] - control[0], 2 * origin[1] - control[1]] : origin) as Point, p = point();
            result.push({ op: 'Q', a, p });
            control = a;
            current = p;
        }
        else if (op === 'A') {
            const rx = num(), ry = num(), angle = num(), large = flag(), sweep = flag(), p = point();
            result.push(...arc(origin, p, rx, ry, angle, large, sweep));
            current = p;
        }
        previous = op;
        if (result.length > 100000)
            throw new Error('Path segment budget exceeded');
    }
    return result;
}
/** Endpoint to center conversion from the SVG elliptical arc equations. */
function arc(from: Point, to: Point, rx: number, ry: number, degrees: number, large: boolean, sweep: boolean): Segment[] {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (same(from, to))
        return [];
    if (!rx || !ry)
        return [{ op: 'L', p: to }];
    const phi = degrees * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi), dx = (from[0] - to[0]) / 2, dy = (from[1] - to[1]) / 2;
    const x = c * dx + s * dy, y = -s * dx + c * dy, k = Math.sqrt(x * x / (rx * rx) + y * y / (ry * ry));
    if (k > 1) {
        rx *= k;
        ry *= k;
    }
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y * y - ry * ry * x * x) / (rx * rx * y * y + ry * ry * x * x)));
    const cxp = factor * rx * y / ry, cyp = -factor * ry * x / rx, cx = c * cxp - s * cyp + (from[0] + to[0]) / 2, cy = s * cxp + c * cyp + (from[1] + to[1]) / 2;
    const a = Math.atan2((y - cyp) / ry, (x - cxp) / rx);
    let delta = Math.atan2((-y - cyp) / ry, (-x - cxp) / rx) - a;
    if (sweep && delta < 0)
        delta += 2 * Math.PI;
    if (!sweep && delta > 0)
        delta -= 2 * Math.PI;
    const count = Math.ceil(Math.abs(delta) / (Math.PI / 2)), out: Segment[] = [];
    const p = (t: number): Point => [cx + c * rx * Math.cos(t) - s * ry * Math.sin(t), cy + s * rx * Math.cos(t) + c * ry * Math.sin(t)];
    const derivative = (t: number): Point => [-c * rx * Math.sin(t) - s * ry * Math.cos(t), -s * rx * Math.sin(t) + c * ry * Math.cos(t)];
    for (let i = 0; i < count; i++) {
        const t = a + delta * i / count, u = a + delta * (i + 1) / count, h = 4 / 3 * Math.tan((u - t) / 4), p0 = p(t), p1 = p(u), d0 = derivative(t), d1 = derivative(u);
        out.push({ op: 'C', a: [p0[0] + h * d0[0], p0[1] + h * d0[1]], b: [p1[0] - h * d1[0], p1[1] - h * d1[1]], p: i === count - 1 ? to : p1 });
    }
    return out;
}
export function flatten(segments: Segment[], matrix: Matrix = identity(), pixelTolerance = .25): Contour[] {
    let totalPoints = 0;
    const tolerance = pixelTolerance / Math.max(maxScale(matrix), 1e-10), result: Contour[] = [];
    let contour: Contour | undefined, p: Point = [0, 0];
    const add = (q: Point) => {
        if (++totalPoints > 200000)
            throw new Error("Flattened path budget exceeded");
        if (!contour) {
            contour = { points: [p], closed: false };
            result.push(contour);
        }
        if (!same(contour.points.at(-1)!, q))
            contour.points.push(q);
        p = q;
    };
    const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const distance = (a: Point, b: Point, q: Point) => {
        const x = b[0] - a[0], y = b[1] - a[1], l = x * x + y * y;
        const t = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * x + (q[1] - a[1]) * y) / l)) : 0;
        return Math.hypot(q[0] - a[0] - t * x, q[1] - a[1] - t * y);
    };
    const cubic = (a: Point, b: Point, c: Point, d: Point, depth = 0): void => {
        if (depth >= 20 || Math.max(distance(a, d, b), distance(a, d, c)) <= tolerance) {
            add(d);
            return;
        }
        const ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), m = mid(abc, bcd);
        cubic(a, ab, abc, m, depth + 1);
        cubic(m, bcd, cd, d, depth + 1);
    };
    for (const segment of segments) {
        if (segment.op === 'M') {
            contour = { points: [segment.p], closed: false };
            result.push(contour);
            p = segment.p;
        }
        else if (segment.op === 'L')
            add(segment.p);
        else if (segment.op === 'C')
            cubic(p, segment.a, segment.b, segment.p);
        else if (segment.op === 'Q') {
            const a = p, b = segment.a, c = segment.p;
            cubic(a, [a[0] + 2 / 3 * (b[0] - a[0]), a[1] + 2 / 3 * (b[1] - a[1])], [c[0] + 2 / 3 * (b[0] - c[0]), c[1] + 2 / 3 * (b[1] - c[1])], c);
        }
        else if (contour) {
            contour.closed = true;
            p = contour.points[0];
            if (contour.points.length > 1 && same(contour.points[0], contour.points.at(-1)!))
                contour.points.pop();
            contour = undefined;
        }
    }
    return result.map(c => ({ closed: c.closed, points: c.points.map(p => transformPoint(matrix, p)) }));
}
export function pathLength(contours: Contour[]): number {
    return contours.reduce((sum, c) => sum + c.points.reduce((n, p, i) => i ? n + Math.hypot(p[0] - c.points[i - 1][0], p[1] - c.points[i - 1][1]) : n, 0) + (c.closed && c.points.length > 1 ? Math.hypot(c.points[0][0] - c.points.at(-1)![0], c.points[0][1] - c.points.at(-1)![1]) : 0), 0);
}
export function pointAtLength(contours: Contour[], length: number): {
    point: Point;
    tangent: Point;
} {
    length = Math.max(0, length);
    let last: Point = [0, 0];
    for (const c of contours) {
        const pts = c.closed ? [...c.points, c.points[0]] : c.points;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
            if (d && length <= d)
                return { point: [a[0] + dx * length / d, a[1] + dy * length / d], tangent: [dx / d, dy / d] };
            length -= d;
            last = b;
        }
    }
    return { point: last, tangent: [1, 0] };
}

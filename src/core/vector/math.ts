export type Point = [
    number,
    number
];
/** SVG affine matrix [a,b,c,d,e,f], acting on column vectors. */
export type Matrix = [
    number,
    number,
    number,
    number,
    number,
    number
];
export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export const transformPoint = (m: Matrix, p: Point): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export function inverse(m: Matrix): Matrix | null {
    const d = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(d) < 1e-15)
        return null;
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
/** Largest singular value: safe flattening tolerance under nonuniform scale/shear. */
export function maxScale(m: Matrix): number {
    const a = m[0] * m[0] + m[1] * m[1], b = m[0] * m[2] + m[1] * m[3], c = m[2] * m[2] + m[3] * m[3];
    return Math.sqrt(Math.max(0, (a + c + Math.hypot(a - c, 2 * b)) / 2));
}
export function numbers(value: string): number[] {
    const tokens = value.match(/[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi) ?? [];
    if (value.replace(/[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi, '').replace(/[\s,]/g, ''))
        throw new Error(`Invalid numeric list: ${value}`);
    const result = tokens.map(Number);
    if (!result.every(Number.isFinite))
        throw new Error('Non-finite vector number');
    return result;
}
export function parseTransform(value: string, width = 0, height = 0): Matrix {
    if (value.trim() === 'none')
        return identity();
    let result = identity(), consumed = 0;
    const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
    for (const match of value.matchAll(re)) {
        if (value.slice(consumed, match.index).replace(/[\s,]/g, ''))
            throw new Error(`Invalid transform: ${value}`);
        consumed = match.index! + match[0].length;
        const name = match[1], pattern = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(?:deg|rad|grad|turn|px|%)?/gi, tokens = match[2].match(pattern) ?? [];
        if (match[2].replace(pattern, '').replace(/[\s,]/g, ''))
            throw new Error(`Invalid transform arguments: ${match[2]}`);
        const n = tokens.map((token, index) => {
            const value = parseFloat(token), unit = token.replace(/^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/i, '').toLowerCase();
            if (unit === '%') {
                if (!name.startsWith('translate'))
                    throw new Error('Percentage requires a translation');
                return value * (name === 'translateY' || index === 1 ? height : width) / 100;
            }
            if (unit === 'px') {
                if (!name.startsWith('translate'))
                    throw new Error('Length unit requires a translation');
                return value;
            }
            if (unit) {
                if (!/^(rotate|rotateZ|skew|skewX|skewY)$/.test(name))
                    throw new Error('Angle unit requires a rotation or skew');
                return value * ({ deg: 1, rad: 180 / Math.PI, grad: .9, turn: 360 }[unit] ?? NaN);
            }
            return value;
        });
        let m: Matrix;
        if (name === 'matrix' && n.length === 6)
            m = n as Matrix;
        else if (name === 'translate' && n.length >= 1 && n.length <= 2)
            m = [1, 0, 0, 1, n[0], n[1] ?? 0];
        else if (name === 'translateX' && n.length === 1)
            m = [1, 0, 0, 1, n[0], 0];
        else if (name === 'translateY' && n.length === 1)
            m = [1, 0, 0, 1, 0, n[0]];
        else if (name === 'scaleX' && n.length === 1)
            m = [n[0], 0, 0, 1, 0, 0];
        else if (name === 'scaleY' && n.length === 1)
            m = [1, 0, 0, n[0], 0, 0];
        else if (name === 'scale' && n.length >= 1 && n.length <= 2)
            m = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
        else if ((name === 'rotate' || name === 'rotateZ') && (n.length === 1 || n.length === 3)) {
            const r = n[0] * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), x = n[1] ?? 0, y = n[2] ?? 0;
            m = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
        }
        else if (name === 'skew' && n.length >= 1 && n.length <= 2)
            m = [1, Math.tan((n[1] ?? 0) * Math.PI / 180), Math.tan(n[0] * Math.PI / 180), 1, 0, 0];
        else if (name === 'skewX' && n.length === 1)
            m = [1, 0, Math.tan(n[0] * Math.PI / 180), 1, 0, 0];
        else if (name === 'skewY' && n.length === 1)
            m = [1, Math.tan(n[0] * Math.PI / 180), 0, 1, 0, 0];
        else
            throw new Error(`Invalid transform ${name}`);
        if (!m.every(Number.isFinite))
            throw new Error('Non-finite transform');
        result = multiply(result, m);
    }
    if (value.slice(consumed).trim())
        throw new Error(`Invalid transform: ${value}`);
    return result;
}
export type Bounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export function bounds(points: Point[]): Bounds {
    if (!points.length)
        return { x: 0, y: 0, width: 0, height: 0 };
    let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
    for (const p of points) {
        x = Math.min(x, p[0]);
        y = Math.min(y, p[1]);
        r = Math.max(r, p[0]);
        b = Math.max(b, p[1]);
    }
    return { x, y, width: r - x, height: b - y };
}
export function viewBoxMatrix(box: number[], width: number, height: number, aspect = 'xMidYMid meet'): Matrix {
    if (box.length !== 4 || box[2] <= 0 || box[3] <= 0)
        throw new Error('viewBox requires positive width and height');
    let sx = width / box[2], sy = height / box[3], x = 0, y = 0;
    if (aspect.trim() !== 'none') {
        const s = aspect.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy);
        sx = sy = s;
        x = (width - box[2] * s) * (aspect.includes('xMax') ? 1 : aspect.includes('xMin') ? 0 : .5);
        y = (height - box[3] * s) * (aspect.includes('YMax') ? 1 : aspect.includes('YMin') ? 0 : .5);
    }
    return [sx, 0, 0, sy, x - box[0] * sx, y - box[1] * sy];
}

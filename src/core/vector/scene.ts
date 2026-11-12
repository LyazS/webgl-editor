import type { Bounds, Matrix } from './math';
import type { FillRule, StrokeStyle } from './geometry';
import type { Segment } from './path';
export type Color = [
    number,
    number,
    number,
    number
];
export interface Gradient {
    kind: 'linear' | 'radial';
    matrix: Matrix;
    coordinates: number[];
    stops: Array<{
        offset: number;
        color: Color;
    }>;
    spread: 'pad' | 'repeat' | 'reflect';
    linearRGB: boolean;
}
export type Paint = {
    kind: 'solid';
    color: Color;
} | Gradient | {
    kind: 'pattern';
    matrix: Matrix;
    width: number;
    height: number;
    alpha: number;
    scene: VectorNode[];
};
export interface VectorNode {
    id: string;
    hitId?: string;
    paintVisible?: boolean;
    matrix: Matrix;
    opacity: number;
    children: VectorNode[];
    markers?: VectorNode[];
    path?: Segment[];
    syntheticBold?: number;
    fill?: Paint;
    stroke?: Paint;
    fillRule: FillRule;
    clipRule?: FillRule;
    isolated?: boolean;
    strokeStyle: StrokeStyle;
    nonScalingStroke: boolean;
    clip?: VectorNode[];
    mask?: {
        nodes: VectorNode[];
        luminance: boolean;
        region: Bounds;
    };
    filter?: FilterPrimitive[];
    filterPaints?: {
        fill?: Paint;
        stroke?: Paint;
    };
    filterRegion?: Bounds;
    filterMatrix?: Matrix;
    paintOrder?: string[];
    blend: string;
    visible: boolean;
    image?: {
        source: string;
        box: Bounds;
        aspect: string;
    };
}
export interface FilterPrimitive {
    region?: Bounds;
    scene?: VectorNode[];
    type: string;
    attributes: Record<string, string>;
    children: FilterPrimitive[];
}
export const defaultStroke = (): StrokeStyle => ({
    width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0
});
const named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', transparent: '#00000000', rebeccapurple: '#663399'
};
let colorContext: CanvasRenderingContext2D | null | undefined;
export function color(input: string, opacity: number | string = 1): Color {
    opacity = typeof opacity === 'string' ? (opacity.endsWith('%') ? parseFloat(opacity) / 100 : Number(opacity)) : opacity;
    if (!Number.isFinite(opacity))
        throw new Error('Color opacity must be finite');
    opacity = Math.max(0, Math.min(1, opacity));
    let value = input.trim().toLowerCase();
    value = named[value] ?? value;
    if (!value.startsWith('#') && !/^rgba?\(/.test(value) && typeof document !== 'undefined') {
        colorContext ??= document.createElement('canvas').getContext('2d');
        if (colorContext) {
            colorContext.fillStyle = '#010203';
            colorContext.fillStyle = value;
            const a = colorContext.fillStyle;
            colorContext.fillStyle = '#040506';
            colorContext.fillStyle = value;
            if (a !== colorContext.fillStyle)
                throw new Error(`Invalid color: ${input}`);
            value = String(a);
        }
    }
    if (/^#[\da-f]{3,8}$/i.test(value)) {
        let h = value.slice(1);
        if (h.length === 3 || h.length === 4)
            h = [...h].map(c => c + c).join('');
        if (h.length !== 6 && h.length !== 8)
            throw new Error(`Invalid color: ${input}`);
        return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, (h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1) * opacity];
    }
    const match = /^rgba?\((.*)\)$/.exec(value);
    if (match) {
        const p = match[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length < 3 || p.length > 4)
            throw new Error(`Invalid color: ${input}`);
        const n = p.map((v, i) => Math.max(0, Math.min(1, parseFloat(v) / (v.endsWith('%') ? 100 : i < 3 ? 255 : 1))));
        if (n.some(n => !Number.isFinite(n)))
            throw new Error(`Invalid color: ${input}`);
        return [n[0], n[1], n[2], (n[3] ?? 1) * opacity];
    }
    throw new Error(`Unsupported color: ${input}`);
}

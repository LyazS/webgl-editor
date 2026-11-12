import { bounds, identity, inverse, maxScale, multiply, transformPoint, type Bounds, type Matrix } from './math';
import { flatten, type Contour } from './path';
import { strokeContours, tessellate, unitQuad } from './geometry';
import type { Color, FilterPrimitive, Paint, VectorNode } from './scene';
export interface CompiledPaint {
    kind: 'solid' | 'linear' | 'radial' | 'texture';
    color?: Color;
    inverse?: Matrix;
    coordinates?: number[];
    stops?: Array<{
        offset: number;
        color: Color;
    }>;
    spread?: string;
    linearRGB?: boolean;
    texture?: string;
    tile?: [
        number,
        number
    ];
    alpha?: number;
    image?: {
        width: number;
        height: number;
        aspect: string;
    };
}
export interface VectorDraw {
    part?: 'fill' | 'stroke';
    kind: 'geometry';
    vertices: Float32Array;
    matrix: Matrix;
    paint: CompiledPaint;
}
export interface VectorComposite {
    kind: 'composite';
    input: string;
    mask?: string;
    luminance?: boolean;
    opacity: number;
    blend: string;
}
export interface VectorEffect {
    region?: Bounds;
    inputRegion?: Bounds;
    kind: 'effect';
    type: string;
    inputs: string[];
    attributes: Record<string, string>;
    children: FilterPrimitive[];
    matrix: Matrix;
}
export type VectorOperation = VectorDraw | VectorComposite | VectorEffect;
export interface VectorPass {
    id: string;
    width: number;
    height: number;
    pixelScale?: number;
    reads: string[];
    operations: VectorOperation[];
}
export interface VectorPlan {
    passes: VectorPass[];
    output: string;
}
/** Every generated layer/effect is an explicit node in this dependency graph.
 * No SVG feature can issue invisible framebuffer work from a paint shader. */
export class VectorCompiler {
    private geometry = new Map<string, Float32Array>();
    private bytes = 0;
    private passes: VectorPass[] = [];
    private sequence = 0;
    private ratio = 1;
    private baseRatio = 1;
    compile(nodes: VectorNode[], width: number, height: number, matrix = identity(), pixelRatio = 1, opacity = 1): VectorPlan {
        this.passes = [];
        this.sequence = 0;
        this.ratio = this.baseRatio = pixelRatio;
        const root = this.pass(width, height);
        this.nodes(nodes, matrix, root);
        let output = root.id;
        if (opacity !== 1) {
            const p = this.pass(width, height);
            this.composite(p, output, opacity);
            output = p.id;
        }
        const byId = new Map(this.passes.map(p => [p.id, p])), ordered: VectorPass[] = [], seen = new Set<string>(), active = new Set<string>();
        const visit = (id: string) => {
            if (seen.has(id))
                return;
            if (active.has(id))
                throw new Error('Cyclic vector render plan');
            active.add(id);
            const p = byId.get(id)!;
            for (const input of p.reads)
                visit(input);
            active.delete(id);
            seen.add(id);
            ordered.push(p);
        };
        visit(output);
        return { passes: ordered, output };
    }
    clear(): void {
        this.geometry.clear();
        this.passes = [];
        this.sequence = 0;
        this.bytes = 0;
    }
    private pass(width: number, height: number): VectorPass {
        if (this.passes.length >= 256)
            throw new Error('SVG intermediate pass budget exceeded (256)');
        const pass: VectorPass = {
            id: `vector:${++this.sequence}`, width, height, pixelScale: this.ratio / this.baseRatio, reads: [], operations: []
        };
        this.passes.push(pass);
        return pass;
    }
    private read(pass: VectorPass, id: string): void {
        if (!pass.reads.includes(id))
            pass.reads.push(id);
    }
    private composite(pass: VectorPass, input: string, opacity = 1, mask?: string, luminance = false, blend = 'normal'): void {
        if (blend !== 'normal') {
            const foreground = this.pass(pass.width, pass.height);
            this.composite(foreground, input, opacity, mask, luminance);
            const backdrop = this.pass(pass.width, pass.height);
            backdrop.operations = pass.operations;
            backdrop.reads = pass.reads;
            pass.operations = [];
            pass.reads = [];
            const result = this.pass(pass.width, pass.height);
            this.read(result, foreground.id);
            this.read(result, backdrop.id);
            result.operations.push({
                kind: 'effect', type: 'feBlend', inputs: [foreground.id, backdrop.id], attributes: { mode: blend, 'color-interpolation-filters': 'sRGB' }, children: [], matrix: identity()
            });
            this.composite(pass, result.id);
            return;
        }
        this.read(pass, input);
        if (mask)
            this.read(pass, mask);
        pass.operations.push({
            kind: 'composite', input, opacity, mask, luminance, blend
        });
    }
    private geometryFor(contours: Contour[], key: string, rule: 'nonzero' | 'evenodd'): Float32Array {
        const existing = this.geometry.get(key);
        if (existing) {
            this.geometry.delete(key);
            this.geometry.set(key, existing);
            return existing;
        }
        const vertices = tessellate(contours, rule);
        this.geometry.set(key, vertices);
        this.bytes += vertices.byteLength + key.length * 2;
        while (this.bytes > 32 * 1024 * 1024 || this.geometry.size > 1024) {
            const key = this.geometry.keys().next().value!, value = this.geometry.get(key)!;
            this.bytes -= value.byteLength + key.length * 2;
            this.geometry.delete(key);
        }
        return vertices;
    }
    private nodes(nodes: VectorNode[], parent: Matrix, target: VectorPass, depth = 0): void {
        if (depth > 64)
            throw new Error('Vector scene depth exceeded');
        for (const node of nodes) {
            if (!node.visible || node.opacity === 0)
                continue;
            const world = multiply(parent, node.matrix);
            if (!inverse(world))
                continue;
            const isolated = node.opacity !== 1 || !!node.clip?.length || !!node.mask || !!node.filter?.length || node.blend !== 'normal' || node.isolated;
            const layer = isolated ? this.pass(target.width, target.height) : target;
            const geometryStart = layer.operations.length;
            if (node.path) {
                const scale = maxScale(world) * this.ratio, bucket = 2 ** Math.ceil(Math.log2(Math.max(scale, 1e-4))), local = flatten(node.path, identity(), .2 / bucket), pathKey = JSON.stringify(node.path);
                if (node.fill) {
                    let contours = local;
                    if (node.syntheticBold) {
                        const area = (points: import('./math').Point[]) => points.reduce((sum, p, i) => {
                            const q = points[(i + 1) % points.length];
                            return sum + p[0] * q[1] - q[0] * p[1];
                        }, 0);
                        const largest = local.reduce((best, c) => Math.abs(area(c.points)) > Math.abs(best) ? area(c.points) : best, 0);
                        const base = largest < 0 ? local.map(c => ({ ...c, points: [...c.points].reverse() })) : local;
                        contours = [...base, ...strokeContours(local, {
                                width: node.syntheticBold, cap: 'round', join: 'round', miterLimit: 4, dash: [], dashOffset: 0
                            }, .2 / bucket)];
                    }
                    const vertices = this.geometryFor(contours, `${pathKey}:fill:${node.fillRule}:${bucket}:${node.syntheticBold ?? 0}`, node.fillRule);
                    if (vertices.length)
                        layer.operations.push({
                            kind: 'geometry', part: 'fill', vertices, matrix: world, paint: this.paint(node.fill, world, layer)
                        });
                }
                if (node.stroke && node.strokeStyle.width > 0) {
                    const matrix = node.nonScalingStroke ? identity() : world, contours = node.nonScalingStroke ? local.map(c => ({ ...c, points: c.points.map(p => transformPoint(world, p)) })) : local;
                    const key = `${pathKey}:stroke:${JSON.stringify(node.strokeStyle)}:${bucket}:${node.nonScalingStroke ? world.join(',') : ''}`;
                    const vertices = this.geometryFor(strokeContours(contours, node.strokeStyle, .2 / (node.nonScalingStroke ? this.ratio : bucket)), key, 'nonzero');
                    if (vertices.length)
                        layer.operations.push({
                            kind: 'geometry', part: 'stroke', vertices, matrix, paint: this.paint(node.stroke, world, layer)
                        });
                }
            }
            if (node.path) {
                const operations = layer.operations.splice(geometryStart);
                for (const part of node.paintOrder ?? ['fill', 'stroke', 'markers']) {
                    if (part === 'markers')
                        this.nodes(node.markers ?? [], world, layer, depth + 1);
                    else
                        layer.operations.push(...operations.filter(op => op.kind === 'geometry' && op.part === part));
                }
            }
            if (node.image) {
                const b = node.image.box, vertices = new Float32Array([b.x, b.y, b.x + b.width, b.y, b.x, b.y + b.height, b.x, b.y + b.height, b.x + b.width, b.y, b.x + b.width, b.y + b.height]);
                layer.operations.push({ kind: 'geometry', vertices, matrix: world, paint: {
                        kind: 'texture', texture: `image:${node.image.source}`, inverse: inverse(multiply(world, [b.width, 0, 0, b.height, b.x, b.y])) ?? identity(), tile: [1, 1], image: { width: b.width, height: b.height, aspect: node.image.aspect }
                    } });
            }
            this.nodes(node.children, world, layer, depth + 1);
            let output = layer.id;
            if (node.filter?.length) {
                output = this.filters(node.filter, output, layer, multiply(world, node.filterMatrix ?? identity()), node.filterPaints ?? { fill: node.fill, stroke: node.stroke }, world, node.filterRegion);
                if (node.filterRegion) {
                    const mask = this.pass(target.width, target.height);
                    this.rect(mask, node.filterRegion, world, { kind: 'solid', color: [1, 1, 1, 1] });
                    const p = this.pass(target.width, target.height);
                    this.composite(p, output, 1, mask.id);
                    output = p.id;
                }
            }
            if (node.clip?.length) {
                for (const clip of node.clip) {
                    const mask = this.pass(target.width, target.height);
                    this.nodes([clip], world, mask, depth + 1);
                    const p = this.pass(target.width, target.height);
                    this.composite(p, output, 1, mask.id);
                    output = p.id;
                }
            }
            if (node.mask) {
                const mask = this.pass(target.width, target.height);
                this.nodes(node.mask.nodes, world, mask, depth + 1);
                const region = this.pass(target.width, target.height);
                this.rect(region, node.mask.region, world, { kind: 'solid', color: [1, 1, 1, 1] });
                const clipped = this.pass(target.width, target.height);
                this.composite(clipped, mask.id, 1, region.id);
                const p = this.pass(target.width, target.height);
                this.composite(p, output, 1, clipped.id, node.mask.luminance);
                output = p.id;
            }
            if (isolated)
                this.composite(target, output, node.opacity, undefined, false, node.blend);
        }
    }
    private rect(pass: VectorPass, b: Bounds, matrix: Matrix, paint: CompiledPaint): void {
        pass.operations.push({ kind: 'geometry', vertices: unitQuad, matrix: multiply(matrix, [b.width, 0, 0, b.height, b.x, b.y]), paint });
    }
    private paint(paint: Paint, world: Matrix, target: VectorPass): CompiledPaint {
        if (paint.kind === 'solid')
            return paint;
        if (paint.kind === 'pattern') {
            const previousRatio = this.ratio;
            this.ratio *= Math.max(1, maxScale(multiply(world, paint.matrix)));
            const p = this.pass(paint.width, paint.height);
            try {
                this.nodes(paint.scene, identity(), p);
            }
            finally {
                this.ratio = previousRatio;
            }
            this.read(target, p.id);
            return {
                kind: 'texture', texture: p.id, inverse: inverse(multiply(world, paint.matrix)) ?? identity(), tile: [paint.width, paint.height], alpha: paint.alpha
            };
        }
        return { ...paint, inverse: inverse(multiply(world, paint.matrix)) ?? identity() };
    }
    private filterEffect(type: string, inputs: string[], attributes: Record<string, string>, children: FilterPrimitive[], matrix: Matrix, target: VectorPass, region?: Bounds, inputRegion?: Bounds): string {
        if ((type === 'feGaussianBlur' || type === 'feMorphology') && !attributes.__axis) {
            const x = this.filterEffect(type, inputs, { ...attributes, __axis: 'x' }, children, matrix, target, region, inputRegion);
            return this.filterEffect(type, [x], { ...attributes, __axis: 'y' }, children, matrix, target, region, inputRegion);
        }
        const p = this.pass(target.width, target.height);
        for (const input of inputs)
            this.read(p, input);
        p.operations.push({
            kind: 'effect', type, inputs, attributes, children, matrix, region, inputRegion
        });
        return p.id;
    }
    private filters(primitives: FilterPrimitive[], source: string, target: VectorPass, matrix: Matrix, paints: {
        fill?: Paint;
        stroke?: Paint;
    }, paintMatrix: Matrix, paintRegion?: Bounds): string {
        const named = new Map<string, string>([['SourceGraphic', source]]);
        let previous = source;
        const regions = new Map<string, Bounds>();
        const sourceAlpha = () => {
            let id = named.get('SourceAlpha');
            if (!id) {
                const p = this.pass(target.width, target.height);
                this.read(p, source);
                p.operations.push({
                    kind: 'effect', type: 'SourceAlpha', inputs: [source], attributes: {}, children: [], matrix
                });
                id = p.id;
                named.set('SourceAlpha', id);
            }
            return id;
        };
        const input = (name: string | undefined, fallback = previous) => {
            if (!name)
                return fallback;
            if (name === 'SourceAlpha')
                return sourceAlpha();
            if (name === 'FillPaint' || name === 'StrokePaint') {
                let id = named.get(name);
                if (!id) {
                    const p = this.pass(target.width, target.height), paint = name === 'FillPaint' ? paints.fill : paints.stroke;
                    if (paint)
                        this.rect(p, paintRegion ?? { x: 0, y: 0, width: target.width, height: target.height }, paintMatrix, this.paint(paint, paintMatrix, p));
                    id = p.id;
                    named.set(name, id);
                }
                return id;
            }
            const id = named.get(name);
            if (!id)
                throw new Error(`SVG filter input ${name} does not exist`);
            return id;
        };
        const outputRegion = (primitive: FilterPrimitive, inputs: string[]): Bounds | undefined => {
            if (!primitive.region)
                return undefined;
            let region = { ...primitive.region };
            if (primitive.type !== 'feTile' && inputs.length && inputs.every(id => regions.has(id))) {
                const boxes = inputs.map(id => regions.get(id)!), x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
                region = { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
                for (const key of ['x', 'y', 'width', 'height'] as const)
                    if (primitive.attributes[key] !== undefined)
                        region[key] = primitive.region[key];
            }
            return region;
        };
        for (const primitive of primitives) {
            const a = primitive.attributes;
            if (primitive.type === 'feDropShadow') {
                const original = input(a.in), region = outputRegion(primitive, [input(a.in)]);
                const effect = (type: string, inputs: string[], attributes: Record<string, string>) => this.filterEffect(type, inputs, attributes, [], matrix, target);
                const alpha = effect('SourceAlpha', [original], a), blur = effect('feGaussianBlur', [alpha], { ...a, stdDeviation: a.stdDeviation ?? '2' }), offset = effect('feOffset', [blur], { ...a, dx: a.dx ?? '2', dy: a.dy ?? '2' }), flood = effect('feFlood', [], a), shadow = effect('feComposite', [flood, offset], { ...a, operator: 'in' });
                previous = effect('feMerge', [shadow, original], a);
                if (region) {
                    const mask = this.pass(target.width, target.height);
                    this.rect(mask, region, matrix, { kind: 'solid', color: [1, 1, 1, 1] });
                    const cropped = this.pass(target.width, target.height);
                    this.composite(cropped, previous, 1, mask.id);
                    previous = cropped.id;
                    regions.set(previous, region);
                }
                if (a.result)
                    named.set(a.result, previous);
                continue;
            }
            let inputs = [input(a.in)];
            if (['feBlend', 'feComposite', 'feDisplacementMap'].includes(primitive.type))
                inputs.push(input(a.in2, source));
            if (primitive.type === 'feMerge')
                inputs = primitive.children.map(child => input(child.attributes.in));
            if (['feFlood', 'feTurbulence', 'feImage'].includes(primitive.type))
                inputs = [];
            const inputRegion = inputs.length ? regions.get(inputs[0]) : undefined, region = outputRegion(primitive, inputs);
            if (primitive.scene) {
                const p = this.pass(target.width, target.height);
                this.nodes(primitive.scene, matrix, p);
                previous = p.id;
            }
            else
                previous = this.filterEffect(primitive.type, inputs, a, primitive.children, matrix, target, region, inputRegion);
            if (region) {
                const mask = this.pass(target.width, target.height);
                this.rect(mask, region, matrix, { kind: 'solid', color: [1, 1, 1, 1] });
                const cropped = this.pass(target.width, target.height);
                this.composite(cropped, previous, 1, mask.id);
                previous = cropped.id;
                regions.set(previous, region);
            }
            if (a.result)
                named.set(a.result, previous);
        }
        return previous;
    }
}

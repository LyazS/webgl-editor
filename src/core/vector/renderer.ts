import { unitQuad } from "./geometry";
import { advancedFragment } from "./advanced-shaders";
import { turbulenceTable } from "./noise";
import { VectorGLState } from "./gl-state";
import { identity, inverse, multiply as multiplyMatrix, type Matrix } from './math';
import { VectorCompiler, type CompiledPaint, type VectorDraw, type VectorEffect, type VectorPlan, type VectorPass } from './compiler';
import type { VectorNode } from './scene';
import { color } from './scene';
import { geometryVertex, geometryFragment, quadVertex, compositeFragment, effectFragment } from './shaders';
import { numbers } from './math';
interface Surface {
    width: number;
    height: number;
    texture: WebGLTexture;
    framebuffer: WebGLFramebuffer;
    msaa?: WebGLFramebuffer;
    buffer?: WebGLRenderbuffer;
    bytes: number;
}
interface Geometry {
    buffer: WebGLBuffer;
    length: number;
}
export type ImageResolver = (source: string) => Promise<Blob>;
const mat3 = (m: Matrix) => new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
/** Own WebGL2 vector backend. Surface work is driven exclusively by VectorPlan. */
export class VectorRenderer {
    readonly compiler = new VectorCompiler();
    get lastPlan(): VectorPlan | undefined {
        return this.planCache?.plan;
    }
    private readonly paintProgram: WebGLProgram;
    private readonly compositeProgram: WebGLProgram;
    private readonly effectProgram: WebGLProgram;
    private readonly advancedProgram: WebGLProgram;
    private readonly advancedTables = new Map<string, WebGLTexture>();
    private readonly vao: WebGLVertexArrayObject;
    private readonly white: WebGLTexture;
    private readonly geometry = new Map<Float32Array, Geometry>();
    private geometryBytes = 0;
    private surfaceBytes = 0;
    private protectedImages = new Set<string>();
    private readonly stops = new Map<string, WebGLTexture>();
    private readonly transferTextures = new Map<string, WebGLTexture>();
    private readonly images = new Map<string, {
        texture: WebGLTexture;
        width: number;
        height: number;
    }>();
    private readonly imagePromises = new Map<string, Promise<void>>();
    private readonly pool: Surface[] = [];
    private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
    private readonly abort = new AbortController();
    private destroyed = false;
    private queue: Promise<void> = Promise.resolve();
    private planCache?: {
        nodes: VectorNode[];
        key: string;
        plan: VectorPlan;
    };
    constructor(private readonly gl: WebGL2RenderingContext, private readonly resolveImage: ImageResolver = async (source) => {
        const r = await fetch(source, { signal: this.abort.signal });
        if (!r.ok)
            throw new Error(`SVG image ${source}: ${r.status}`);
        return r.blob();
    }) {
        const initialState = new VectorGLState(gl);
        this.paintProgram = this.program(geometryVertex, geometryFragment);
        this.compositeProgram = this.program(quadVertex, compositeFragment);
        this.effectProgram = this.program(quadVertex, effectFragment);
        this.advancedProgram = this.program(quadVertex, advancedFragment);
        const vao = gl.createVertexArray();
        if (!vao)
            throw new Error('Unable to allocate vector VAO');
        this.vao = vao;
        gl.activeTexture(gl.TEXTURE0);
        this.white = this.texture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        initialState.restore();
    }
    render(nodes: VectorNode[], width: number, height: number, matrix: Matrix = identity(), opacity = 1): Promise<VectorPlan | undefined> {
        const pending = this.queue.then(() => this.renderNow(nodes, width, height, matrix, opacity));
        this.queue = pending.then(() => undefined, () => undefined);
        return pending;
    }
    private async renderNow(nodes: VectorNode[], width: number, height: number, matrix: Matrix, opacity: number): Promise<VectorPlan | undefined> {
        if (this.destroyed)
            throw new Error('Vector renderer has been destroyed');
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) || matrix.length !== 6 || !matrix.every(Number.isFinite) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
            throw new Error("Invalid vector viewport, transform or opacity");
        const state = new VectorGLState(this.gl);
        const gl = this.gl, framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        const ratio = Math.max(viewport[2] / width, viewport[3] / height), key = JSON.stringify([width, height, matrix, opacity, ratio]);
        let plan: VectorPlan;
        if (this.planCache?.nodes === nodes && this.planCache.key === key)
            plan = this.planCache.plan;
        else {
            plan = this.compiler.compile(nodes, width, height, matrix, ratio, opacity);
            this.planCache = { nodes, key, plan };
        }
        const sources = new Set(plan.passes.flatMap(p => p.operations.flatMap(op => op.kind === 'geometry' && op.paint.texture?.startsWith('image:') ? [op.paint.texture.slice(6)] : op.kind === 'effect' && op.type === 'feImage' ? [op.attributes.href ?? op.attributes['xlink:href']] : [])));
        gl.activeTexture(gl.TEXTURE0);
        this.protectedImages = sources;
        const loaded = await Promise.allSettled([...sources].map(source => this.loadImage(source)));
        if (this.destroyed)
            return;
        const failure = loaded.find(result => result.status === "rejected");
        if (failure?.status === "rejected") {
            state.restore();
            throw failure.reason;
        }
        if (this.destroyed)
            return;
        const depth = gl.isEnabled(gl.DEPTH_TEST), stencil = gl.isEnabled(gl.STENCIL_TEST), scissor = gl.isEnabled(gl.SCISSOR_TEST), cull = gl.isEnabled(gl.CULL_FACE), depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const live = new Map<string, Surface>(), remaining = new Map<string, number>();
        for (const p of plan.passes)
            for (const id of p.reads)
                remaining.set(id, (remaining.get(id) ?? 0) + 1);
        remaining.set(plan.output, (remaining.get(plan.output) ?? 0) + 1);
        try {
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            gl.disable(gl.STENCIL_TEST);
            gl.disable(gl.SCISSOR_TEST);
            gl.disable(gl.CULL_FACE);
            gl.colorMask(true, true, true, true);
            for (const p of plan.passes) {
                const width = Math.max(1, Math.ceil(p.width * ratio * (p.pixelScale ?? 1))), height = Math.max(1, Math.ceil(p.height * ratio * (p.pixelScale ?? 1)));
                const operation = p.operations.length === 1 && p.operations[0].kind === 'composite' ? p.operations[0] : undefined;
                const candidate = operation ? live.get(operation.input) : undefined;
                // A last-use composite can consume its input surface. Its old IR
                // resource dies here; only the newly produced resource owns it.
                const reuse = candidate && operation && remaining.get(operation.input) === 1 && candidate.width === width && candidate.height === height;
                const surface = reuse ? candidate : this.acquire(width, height);
                live.set(p.id, surface);
                gl.bindFramebuffer(gl.FRAMEBUFFER, surface.msaa ?? surface.framebuffer);
                gl.viewport(0, 0, surface.width, surface.height);
                if (reuse) {
                    if (operation.mask || operation.opacity !== 1)
                        this.applyMask(operation.mask ? live.get(operation.mask)!.texture : undefined, operation.opacity, operation.luminance);
                }
                else {
                    gl.clearColor(0, 0, 0, 0);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    this.drawPass(p, live);
                }
                this.resolve(surface);
                for (const id of p.reads) {
                    const left = remaining.get(id)! - 1;
                    remaining.set(id, left);
                    if (left === 0) {
                        const consumed = live.get(id)!;
                        if (consumed !== surface)
                            this.release(consumed);
                        live.delete(id);
                    }
                }
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.viewport(...viewport as unknown as [
                number,
                number,
                number,
                number
            ]);
            this.composite(live.get(plan.output)!.texture, 1);
        }
        finally {
            for (const surface of live.values())
                this.release(surface);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.viewport(...viewport as unknown as [
                number,
                number,
                number,
                number
            ]);
            gl.depthMask(depthMask);
            for (const [cap, enabled] of [[gl.DEPTH_TEST, depth], [gl.STENCIL_TEST, stencil], [gl.SCISSOR_TEST, scissor], [gl.CULL_FACE, cull]] as const)
                enabled ? gl.enable(cap) : gl.disable(cap);
            gl.bindVertexArray(null);
            this.trim();
            state.restore();
        }
        return plan;
    }
    private drawPass(pass: VectorPass, live: Map<string, Surface>): void {
        for (const op of pass.operations) {
            if (op.kind === 'geometry')
                this.drawGeometry(op, pass, live);
            else if (op.kind === 'composite')
                this.composite(live.get(op.input)!.texture, op.opacity, op.mask ? live.get(op.mask)!.texture : undefined, op.luminance);
            else
                this.effect(op, pass, live);
        }
    }
    private drawGeometry(draw: VectorDraw, pass: VectorPass, live: Map<string, Surface>): void {
        const gl = this.gl, p = this.paintProgram;
        gl.useProgram(p);
        gl.bindVertexArray(this.vao);
        let geometry = this.geometry.get(draw.vertices);
        if (!geometry) {
            const buffer = gl.createBuffer();
            if (!buffer)
                throw new Error('Unable to allocate vector geometry');
            geometry = { buffer, length: draw.vertices.length / 2 };
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, draw.vertices, gl.STATIC_DRAW);
            this.geometry.set(draw.vertices, geometry);
            this.geometryBytes += draw.vertices.byteLength;
        }
        else {
            this.geometry.delete(draw.vertices);
            this.geometry.set(draw.vertices, geometry);
            gl.bindBuffer(gl.ARRAY_BUFFER, geometry.buffer);
        }
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix3fv(this.u(p, 'u_matrix'), false, mat3(draw.matrix));
        gl.uniform2f(this.u(p, 'u_viewport'), pass.width, pass.height);
        this.bindPaint(draw.paint, live);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, geometry.length);
    }
    private bindPaint(paint: CompiledPaint, live: Map<string, Surface>): void {
        const gl = this.gl, p = this.paintProgram;
        this.bind(p, 'u_image', this.white, 0);
        this.bind(p, 'u_stops', this.white, 1);
        gl.uniform1i(this.u(p, 'u_kind'), paint.kind === 'solid' ? 0 : paint.kind === 'linear' ? 1 : paint.kind === 'radial' ? 2 : 3);
        gl.uniform4fv(this.u(p, 'u_color'), paint.color ?? [0, 0, 0, 0]);
        gl.uniform1f(this.u(p, 'u_alpha'), paint.alpha ?? 1);
        gl.uniform1i(this.u(p, 'u_isImage'), paint.image ? 1 : 0);
        gl.uniform2f(this.u(p, 'u_imageScale'), 1, 1);
        gl.uniform2f(this.u(p, 'u_imageOffset'), 0, 0);
        gl.uniformMatrix3fv(this.u(p, 'u_inverse'), false, mat3(paint.inverse ?? identity()));
        if (paint.kind === 'linear' || paint.kind === 'radial') {
            const c = paint.coordinates!;
            gl.uniform4fv(this.u(p, 'u_coordinates'), paint.kind === 'linear' ? c : [c[0], c[1], c[2], 0]);
            gl.uniform2f(this.u(p, 'u_focus'), c[3] ?? 0, c[4] ?? 0);
            gl.uniform1f(this.u(p, 'u_fr'), c[5] ?? 0);
            const key = JSON.stringify(paint.stops);
            let texture = this.stops.get(key);
            if (!texture) {
                const n = paint.stops!.length;
                if (n > gl.getParameter(gl.MAX_TEXTURE_SIZE))
                    throw new Error('Gradient stop count exceeds GPU limits');
                texture = this.texture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                const data = new Float32Array(n * 8);
                paint.stops!.forEach((s, i) => {
                    data.set(s.color, i * 4);
                    data[n * 4 + i * 4] = s.offset;
                });
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 2, 0, gl.RGBA, gl.FLOAT, data);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                this.stops.set(key, texture);
            }
            this.bind(p, 'u_stops', texture, 1);
            gl.uniform1i(this.u(p, 'u_count'), paint.stops!.length);
            gl.uniform1i(this.u(p, 'u_spread'), paint.spread === 'repeat' ? 1 : paint.spread === 'reflect' ? 2 : 0);
            gl.uniform1i(this.u(p, 'u_linear'), paint.linearRGB ? 1 : 0);
        }
        if (paint.kind === 'texture') {
            if (paint.image && paint.image.aspect !== 'none') {
                const image = this.images.get(paint.texture!.slice(6))!, box = paint.image, scale = box.aspect.includes('slice') ? Math.max(box.width / image.width, box.height / image.height) : Math.min(box.width / image.width, box.height / image.height), sx = image.width * scale / box.width, sy = image.height * scale / box.height;
                gl.uniform2f(this.u(p, 'u_imageScale'), sx, sy);
                gl.uniform2f(this.u(p, 'u_imageOffset'), (1 - sx) * (box.aspect.includes('xMax') ? 1 : box.aspect.includes('xMin') ? 0 : .5), (1 - sy) * (box.aspect.includes('YMax') ? 1 : box.aspect.includes('YMin') ? 0 : .5));
            }
            const texture = paint.texture!.startsWith('image:') ? this.images.get(paint.texture!.slice(6))?.texture : live.get(paint.texture!)?.texture;
            if (!texture)
                throw new Error(`Missing SVG paint texture: ${paint.texture}`);
            this.bind(p, 'u_image', texture, 0);
            gl.uniform2fv(this.u(p, 'u_tile'), paint.tile ?? [1, 1]);
        }
    }
    private composite(texture: WebGLTexture, opacity: number, mask?: WebGLTexture, luminance = false): void {
        const gl = this.gl, p = this.compositeProgram;
        gl.useProgram(p);
        gl.bindVertexArray(this.vao);
        this.bind(p, 'u_input', texture, 0);
        this.bind(p, 'u_mask', mask ?? texture, 1);
        gl.uniform1f(this.u(p, 'u_opacity'), opacity);
        gl.uniform1i(this.u(p, 'u_maskMode'), mask ? (luminance ? 2 : 1) : 0);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    private applyMask(mask: WebGLTexture | undefined, opacity: number, luminance = false): void {
        const gl = this.gl, program = this.compositeProgram;
        gl.useProgram(program);
        gl.bindVertexArray(this.vao);
        this.bind(program, 'u_input', this.white, 0);
        this.bind(program, 'u_mask', mask ?? this.white, 1);
        gl.uniform1f(this.u(program, 'u_opacity'), opacity);
        gl.uniform1i(this.u(program, 'u_maskMode'), mask ? luminance ? 2 : 1 : 0);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    private effect(effect: VectorEffect, pass: VectorPass, live: Map<string, Surface>): void {
        const gl = this.gl, p = this.effectProgram, a = effect.attributes, input = effect.inputs[0] ? live.get(effect.inputs[0])! : undefined;
        const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
        const setup = (mode: number, first = input?.texture, second = effect.inputs[1] ? live.get(effect.inputs[1])?.texture : first) => {
            gl.useProgram(p);
            gl.bindVertexArray(this.vao);
            gl.disable(gl.BLEND);
            gl.uniform1i(this.u(p, 'u_mode'), mode);
            gl.uniform1i(this.u(p, 'u_linearRGB'), a['color-interpolation-filters'] !== 'sRGB' ? 1 : 0);
            this.bind(p, 'u_functions', this.white, 2);
            this.bind(p, 'u_input', first ?? this.white, 0);
            this.bind(p, 'u_second', second ?? this.white, 1);
        };
        const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (effect.type === 'feMerge') {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            for (const id of effect.inputs)
                this.composite(live.get(id)!.texture, 1);
            return;
        }
        if (effect.type === 'SourceAlpha') {
            setup(7);
            draw();
            return;
        }
        if (effect.type === 'feFlood') {
            setup(3);
            gl.uniform4fv(this.u(p, 'u_color'), color(a['flood-color'] ?? 'black', a['flood-opacity'] ?? 1));
            draw();
            return;
        }
        if (effect.type === 'feGaussianBlur' || effect.type === 'feMorphology') {
            const blur = effect.type !== 'feMorphology', n = numbers(a[blur ? 'stdDeviation' : 'radius'] ?? '0'), m = effect.matrix, lx = Math.hypot(m[0], m[1]) || 1, ly = Math.hypot(m[2], m[3]) || 1, logicalX = Math.abs(n[0] ?? 0) * lx, logicalY = Math.abs(n[1] ?? n[0] ?? 0) * ly, x = logicalX * viewport[2] / pass.width, y = logicalY * viewport[3] / pass.height;
            if (n.length > 2 || n.some(value => value < 0))
                throw new Error('SVG filter radii must contain one or two nonnegative numbers');
            if (effect.type === 'feMorphology' && !['erode', 'dilate'].includes(a.operator ?? 'erode'))
                throw new Error('Invalid morphology operator');
            if (logicalX > 128 || logicalY > 128 || x > 512 || y > 512)
                throw new Error('SVG filter radius exceeds the supported 128 logical pixels');
            if (!x && !y) {
                this.composite(input!.texture, 1);
                return;
            }
            const horizontal = a.__axis === 'x', radius = horizontal ? x : y;
            if (!radius) {
                this.composite(input!.texture, 1);
                return;
            }
            setup(blur ? 1 : 8);
            gl.uniform1i(this.u(p, 'u_operator'), a.operator === 'dilate' ? 1 : 0);
            gl.uniform4fv(this.u(p, 'u_k'), [radius, 0, 0, 0]);
            gl.uniform2f(this.u(p, 'u_step'), horizontal ? m[0] / lx / viewport[2] : m[2] / ly / viewport[2], horizontal ? -m[1] / lx / viewport[3] : -m[3] / ly / viewport[3]);
            draw();
            return;
        }
        if (effect.type === 'feOffset') {
            setup(2);
            const dx = Number(a.dx ?? 0), dy = Number(a.dy ?? 0), m = effect.matrix;
            if (!Number.isFinite(dx) || !Number.isFinite(dy))
                throw new Error('Invalid SVG filter offset');
            gl.uniform2f(this.u(p, 'u_delta'), -(m[0] * dx + m[2] * dy) / pass.width, (m[1] * dx + m[3] * dy) / pass.height);
            draw();
            return;
        }
        if (effect.type === 'feBlend') {
            setup(5);
            const mode = ['normal', 'multiply', 'screen', 'darken', 'lighten', 'difference', 'exclusion', 'overlay', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'hue', 'saturation', 'color', 'luminosity'].indexOf(a.mode ?? 'normal');
            if (mode < 0)
                throw new Error(`Unsupported SVG blend mode: ${a.mode}`);
            gl.uniform1i(this.u(p, 'u_operator'), mode);
            draw();
            return;
        }
        if (effect.type === 'feComposite') {
            setup(6);
            const mode = ['over', 'in', 'out', 'atop', 'xor', 'arithmetic', 'lighter'].indexOf(a.operator ?? 'over');
            if (mode < 0)
                throw new Error(`Invalid SVG composite operator: ${a.operator}`);
            gl.uniform1i(this.u(p, 'u_operator'), mode);
            const coefficients = ['k1', 'k2', 'k3', 'k4'].map(k => Number(a[k] ?? 0));
            if (!coefficients.every(Number.isFinite))
                throw new Error('Invalid composite coefficients');
            gl.uniform4fv(this.u(p, 'u_k'), coefficients);
            draw();
            return;
        }
        if (effect.type === 'feColorMatrix') {
            setup(4);
            let values = numbers(a.values ?? '');
            const type = a.type ?? 'matrix';
            if (type === 'saturate') {
                const s = values[0] ?? 1;
                values = [.213 + .787 * s, .715 - .715 * s, .072 - .072 * s, 0, 0, .213 - .213 * s, .715 + .285 * s, .072 - .072 * s, 0, 0, .213 - .213 * s, .715 - .715 * s, .072 + .928 * s, 0, 0, 0, 0, 0, 1, 0];
            }
            else if (type === 'hueRotate') {
                const t = (values[0] ?? 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
                values = [.213 + .787 * c - .213 * s, .715 - .715 * c - .715 * s, .072 - .072 * c + .928 * s, 0, 0, .213 - .213 * c + .143 * s, .715 + .285 * c + .140 * s, .072 - .072 * c - .283 * s, 0, 0, .213 - .213 * c - .787 * s, .715 - .715 * c + .715 * s, .072 + .928 * c + .072 * s, 0, 0, 0, 0, 0, 1, 0];
            }
            else if (type === 'luminanceToAlpha')
                values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, .2125, .7154, .0721, 0, 0];
            else if (type !== 'matrix')
                throw new Error(`Invalid color matrix type ${type}`);
            if (!values.length)
                values = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
            if (values.length !== 20)
                throw new Error('SVG color matrix requires 20 values');
            const m = new Float32Array(16), bias = new Float32Array(4);
            for (let row = 0; row < 4; row++) {
                for (let col = 0; col < 4; col++)
                    m[col * 4 + row] = values[row * 5 + col];
                bias[row] = values[row * 5 + 4];
            }
            gl.uniformMatrix4fv(this.u(p, 'u_matrix'), false, m);
            gl.uniform4fv(this.u(p, 'u_bias'), bias);
            draw();
            return;
        }
        if (effect.type === 'feComponentTransfer') {
            setup(9);
            const params = new Float32Array(16), tables: number[][] = [[], [], [], []];
            for (const child of effect.children) {
                const i = ['feFuncR', 'feFuncG', 'feFuncB', 'feFuncA'].indexOf(child.type), v = child.attributes;
                if (i < 0)
                    throw new Error('Invalid component transfer channel');
                const type = v.type ?? 'identity';
                if (type === 'linear')
                    params.set([1, Number(v.slope ?? 1), Number(v.intercept ?? 0), 0], i * 4);
                else if (type === 'gamma')
                    params.set([2, Number(v.amplitude ?? 1), Number(v.exponent ?? 1), Number(v.offset ?? 0)], i * 4);
                else if (type === 'table' || type === 'discrete') {
                    const values = numbers(v.tableValues ?? '');
                    if (values.length) {
                        tables[i] = values;
                        params.set([type === 'table' ? 3 : 4, values.length, 0, 0], i * 4);
                    }
                }
                else if (type !== 'identity')
                    throw new Error(`Unsupported component transfer type ${type}`);
            }
            const key = JSON.stringify(tables);
            let texture = this.transferTextures.get(key);
            if (!texture) {
                const width = Math.max(1, ...tables.map(t => t.length));
                if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE))
                    throw new Error('Component transfer table exceeds GPU limits');
                const data = new Float32Array(width * 4);
                for (let x = 0; x < width; x++)
                    for (let channel = 0; channel < 4; channel++)
                        data[x * 4 + channel] = tables[channel][Math.min(x, tables[channel].length - 1)] ?? 0;
                texture = this.texture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, data);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                this.transferTextures.set(key, texture);
            }
            this.bind(p, 'u_functions', texture, 2);
            if (!params.every(Number.isFinite))
                throw new Error('Invalid component transfer parameters');
            gl.uniform4fv(this.u(p, 'u_transfer[0]'), params);
            draw();
            return;
        }
        if (['feConvolveMatrix', 'feDisplacementMap', 'feTile', 'feTurbulence', 'feDiffuseLighting', 'feSpecularLighting', 'feImage'].includes(effect.type)) {
            this.advancedEffect(effect, pass, live);
            return;
        }
        throw new Error(`Unsupported SVG filter primitive: ${effect.type}`);
    }
    private table(key: string, width: number, height: number, data: Float32Array): WebGLTexture {
        let texture = this.advancedTables.get(key);
        if (!texture) {
            if (width > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE))
                throw new Error('SVG filter table exceeds GPU limits');
            texture = this.texture();
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            this.advancedTables.set(key, texture);
        }
        return texture;
    }
    private advancedEffect(effect: VectorEffect, pass: VectorPass, live: Map<string, Surface>): void {
        const gl = this.gl, p = this.advancedProgram, a = effect.attributes;
        if (effect.type === 'feImage') {
            const source = a.href ?? a['xlink:href'], image = this.images.get(source);
            if (!image)
                throw new Error(`Missing filter image: ${source}`);
            const b = effect.region ?? { x: 0, y: 0, width: pass.width, height: pass.height };
            this.drawGeometry({ kind: 'geometry', vertices: unitQuad, matrix: multiplyMatrix(effect.matrix, [b.width, 0, 0, b.height, b.x, b.y]), paint: {
                    kind: 'texture', texture: `image:${source}`, inverse: inverse(multiplyMatrix(effect.matrix, [b.width, 0, 0, b.height, b.x, b.y])) ?? identity(), tile: [1, 1], image: { width: b.width, height: b.height, aspect: a.preserveAspectRatio ?? 'xMidYMid meet' }
                } }, pass, live);
            return;
        }
        gl.useProgram(p);
        gl.bindVertexArray(this.vao);
        gl.disable(gl.BLEND);
        this.bind(p, 'u_input', effect.inputs[0] ? live.get(effect.inputs[0])!.texture : this.white, 0);
        this.bind(p, 'u_second', effect.inputs[1] ? live.get(effect.inputs[1])!.texture : this.white, 1);
        this.bind(p, 'u_table', this.white, 2);
        gl.uniform1i(this.u(p, 'u_linear'), a['color-interpolation-filters'] !== 'sRGB' ? 1 : 0);
        gl.uniformMatrix3fv(this.u(p, 'u_world'), false, mat3(effect.matrix));
        const inv = inverse(effect.matrix) ?? identity();
        gl.uniformMatrix3fv(this.u(p, 'u_inverse'), false, mat3(inv));
        gl.uniform2f(this.u(p, 'u_size'), pass.width, pass.height);
        const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array, kernel = numbers(a.kernelUnitLength ?? '');
        const stepX = kernel[0] ?? Math.hypot(inv[0], inv[1]) * pass.width / viewport[2], stepY = kernel[1] ?? kernel[0] ?? Math.hypot(inv[2], inv[3]) * pass.height / viewport[3];
        if (stepX <= 0 || stepY <= 0)
            throw new Error('kernelUnitLength must be positive');
        gl.uniform2f(this.u(p, 'u_kernelStep'), stepX, stepY);
        const region = effect.region ?? { x: 0, y: 0, width: pass.width, height: pass.height }, inputRegion = effect.inputRegion ?? region;
        gl.uniform4fv(this.u(p, 'u_region'), [region.x, region.y, region.width, region.height]);
        gl.uniform4fv(this.u(p, 'u_inputRegion'), [inputRegion.x, inputRegion.y, inputRegion.width, inputRegion.height]);
        const values = new Float32Array(16);
        if (effect.type === 'feConvolveMatrix') {
            const order = numbers(a.order ?? '3'), x = order[0], y = order[1] ?? x;
            if (order.length > 2 || !Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1 || x * y > 625)
                throw new Error('Convolution order must contain positive integers and at most 625 taps');
            const kernel = numbers(a.kernelMatrix ?? '');
            if (kernel.length !== x * y)
                throw new Error('kernelMatrix length must match convolution order');
            const targetX = Number(a.targetX ?? Math.floor(x / 2)), targetY = Number(a.targetY ?? Math.floor(y / 2));
            if (!Number.isInteger(targetX) || !Number.isInteger(targetY) || targetX < 0 || targetY < 0 || targetX >= x || targetY >= y)
                throw new Error('Invalid convolution target');
            const divisor = Number(a.divisor ?? (kernel.reduce((n, v) => n + v, 0) || 1)), bias = Number(a.bias ?? 0);
            if (!Number.isFinite(divisor) || !divisor || !Number.isFinite(bias))
                throw new Error('Invalid convolution divisor/bias');
            const table = new Float32Array(kernel.length * 4);
            kernel.forEach((v, i) => table[i * 4] = v);
            this.bind(p, 'u_table', this.table(`kernel:${JSON.stringify(kernel)}`, kernel.length, 1, table), 2);
            gl.uniform1i(this.u(p, 'u_mode'), 1);
            gl.uniform2i(this.u(p, 'u_order'), x, y);
            gl.uniform2i(this.u(p, 'u_target'), targetX, targetY);
            gl.uniform1i(this.u(p, 'u_edge'), a.edgeMode === 'wrap' ? 1 : a.edgeMode === 'none' ? 2 : 0);
            gl.uniform1i(this.u(p, 'u_preserve'), a.preserveAlpha === 'true' ? 1 : 0);
            values.set([divisor, bias]);
        }
        else if (effect.type === 'feDisplacementMap') {
            const x = 'RGBA'.indexOf(a.xChannelSelector ?? 'A'), y = 'RGBA'.indexOf(a.yChannelSelector ?? 'A'), scale = Number(a.scale ?? 0);
            if (x < 0 || y < 0 || !Number.isFinite(scale))
                throw new Error('Invalid displacement map parameters');
            gl.uniform1i(this.u(p, 'u_mode'), 2);
            gl.uniform2i(this.u(p, 'u_order'), x, y);
            values[0] = scale;
        }
        else if (effect.type === 'feTile') {
            gl.uniform1i(this.u(p, 'u_mode'), 3);
            if (inputRegion.width <= 0 || inputRegion.height <= 0)
                throw new Error('Filter tile must have a positive input region');
        }
        else if (effect.type === 'feTurbulence') {
            const frequency = numbers(a.baseFrequency ?? '0'), seed = Math.trunc(Number(a.seed ?? 0)), octaves = Number(a.numOctaves ?? 1);
            if (frequency.length > 2 || frequency.some(n => n < 0) || !Number.isInteger(octaves) || octaves < 0)
                throw new Error('Invalid turbulence frequency/octaves');
            let fx = frequency[0] ?? 0, fy = frequency[1] ?? fx;
            const stitch = a.stitchTiles === 'stitch';
            const fit = (value: number, extent: number) => {
                if (!value || !extent)
                    return value;
                const low = Math.floor(value * extent) / extent, high = Math.ceil(value * extent) / extent;
                return low && value / low < high / value ? low : high;
            };
            if (stitch) {
                fx = fit(fx, region.width);
                fy = fit(fy, region.height);
            }
            this.bind(p, 'u_table', this.table(`noise:${seed}`, 256, 5, turbulenceTable(seed)), 2);
            gl.uniform1i(this.u(p, 'u_mode'), 4);
            gl.uniform1i(this.u(p, 'u_octaves'), Math.min(9, octaves));
            gl.uniform1i(this.u(p, 'u_stitch'), stitch ? 1 : 0);
            gl.uniform2f(this.u(p, 'u_frequency'), fx, fy);
            values[0] = a.type === 'fractalNoise' ? 1 : 0;
        }
        else {
            const light = effect.children.find(child => ['feDistantLight', 'fePointLight', 'feSpotLight'].includes(child.type));
            if (!light)
                throw new Error('SVG lighting requires a light source');
            const b = light.attributes;
            for (const [key, value] of Object.entries(b))
                if (['x', 'y', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'azimuth', 'elevation', 'specularExponent', 'limitingConeAngle'].includes(key) && !Number.isFinite(Number(value)))
                    throw new Error(`Invalid lighting parameter ${key}`);
            gl.uniform1i(this.u(p, 'u_mode'), effect.type === 'feDiffuseLighting' ? 5 : 6);
            gl.uniform1i(this.u(p, 'u_lightType'), light.type === 'feDistantLight' ? 0 : light.type === 'fePointLight' ? 1 : 2);
            if (light.type === 'feDistantLight') {
                const azimuth = Number(b.azimuth ?? 0) * Math.PI / 180, elevation = Number(b.elevation ?? 0) * Math.PI / 180;
                gl.uniform3f(this.u(p, 'u_light'), Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation));
            }
            else
                gl.uniform3f(this.u(p, 'u_light'), Number(b.x ?? 0), Number(b.y ?? 0), Number(b.z ?? 0));
            gl.uniform3f(this.u(p, 'u_lightTarget'), Number(b.pointsAtX ?? 0), Number(b.pointsAtY ?? 0), Number(b.pointsAtZ ?? 0));
            gl.uniform2f(this.u(p, 'u_lightParams'), Number(b.specularExponent ?? 1), b.limitingConeAngle === undefined ? 0 : Math.cos(Number(b.limitingConeAngle) * Math.PI / 180));
            values.set([Number(a.surfaceScale ?? 1), Number(a.diffuseConstant ?? 1), Number(a.specularConstant ?? 1), Number(a.specularExponent ?? 1)]);
            let c = color(a['lighting-color'] ?? 'white');
            if (a['color-interpolation-filters'] !== 'sRGB')
                c = c.map((v, i) => i < 3 ? v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 : v) as typeof c;
            values.set(c, 4);
        }
        if (!values.every(Number.isFinite))
            throw new Error('Non-finite SVG filter parameters');
        gl.uniform4fv(this.u(p, 'u_values[0]'), values);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    private async loadImage(source: string): Promise<void> {
        if (this.images.has(source))
            return;
        let pending = this.imagePromises.get(source);
        if (!pending) {
            pending = (async () => {
                const blob = await this.resolveImage(source);
                if (!/^image\/(png|jpeg|webp|gif|avif|bmp)/i.test(blob.type))
                    throw new Error(`SVG image requires a raster MIME type: ${source}`);
                const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', imageOrientation: 'flipY' });
                try {
                    if (this.destroyed)
                        return;
                    const gl = this.gl, bytes = bitmap.width * bitmap.height * 4;
                    if (bitmap.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || bitmap.height > gl.getParameter(gl.MAX_TEXTURE_SIZE) || bytes > 64 * 1024 * 1024)
                        throw new Error("SVG image exceeds GPU size or 64 MB image budget");
                    let existing = [...this.images.values()].reduce((sum, image) => sum + image.width * image.height * 4, 0);
                    for (const [key, image] of this.images)
                        if (!this.protectedImages.has(key) && existing + bytes > 64 * 1024 * 1024) {
                            gl.deleteTexture(image.texture);
                            existing -= image.width * image.height * 4;
                            this.images.delete(key);
                            this.imagePromises.delete(key);
                        }
                    if (existing + bytes > 64 * 1024 * 1024)
                        throw new Error("SVG images in one frame exceed the 64 MB budget");
                    const t = this.texture();
                    gl.bindTexture(gl.TEXTURE_2D, t);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
                    this.images.set(source, { texture: t, width: bitmap.width, height: bitmap.height });
                }
                finally {
                    bitmap.close();
                }
            })();
            this.imagePromises.set(source, pending);
            pending.catch(() => this.imagePromises.delete(source));
        }
        await pending;
    }
    private acquire(width: number, height: number): Surface {
        const index = this.pool.findIndex(p => p.width === width && p.height === height);
        if (index >= 0)
            return this.pool.splice(index, 1)[0];
        const gl = this.gl, max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (width > max || height > max)
            throw new Error(`SVG surface ${width}x${height} exceeds GPU limit ${max}`);
        const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES)), bytes = width * height * 4 * (1 + samples);
        while (this.surfaceBytes + bytes > 256 * 1024 * 1024 && this.pool.length)
            this.deleteSurface(this.pool.shift()!);
        if (this.surfaceBytes + bytes > 256 * 1024 * 1024)
            throw new Error("SVG intermediate surfaces exceed the 256 MB budget");
        const texture = this.texture(), framebuffer = gl.createFramebuffer();
        if (!framebuffer) {
            gl.deleteTexture(texture);
            throw new Error('Unable to allocate vector framebuffer');
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteTexture(texture);
            gl.deleteFramebuffer(framebuffer);
            throw new Error('Incomplete vector framebuffer');
        }
        const surface: Surface = {
            width, height, texture, framebuffer, bytes
        };
        if (samples) {
            const msaa = gl.createFramebuffer(), buffer = gl.createRenderbuffer();
            if (!msaa || !buffer) {
                gl.deleteFramebuffer(msaa);
                gl.deleteRenderbuffer(buffer);
                gl.deleteTexture(texture);
                gl.deleteFramebuffer(framebuffer);
                throw new Error('Unable to allocate vector MSAA surface');
            }
            surface.msaa = msaa;
            surface.buffer = buffer;
            gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
            gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
            gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, buffer);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                gl.deleteRenderbuffer(buffer);
                gl.deleteFramebuffer(msaa);
                gl.deleteTexture(texture);
                gl.deleteFramebuffer(framebuffer);
                throw new Error('Incomplete vector MSAA framebuffer');
            }
        }
        this.surfaceBytes += bytes;
        return surface;
    }
    private resolve(surface: Surface): void {
        const gl = this.gl;
        if (surface.msaa) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, surface.msaa);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, surface.framebuffer);
            gl.blitFramebuffer(0, 0, surface.width, surface.height, 0, 0, surface.width, surface.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        }
    }
    private release(surface: Surface): void {
        this.pool.push(surface);
    }
    private trim(): void {
        while (this.geometryBytes > 32 * 1024 * 1024 || this.geometry.size > 1024) {
            const key = this.geometry.keys().next().value!, g = this.geometry.get(key)!;
            this.gl.deleteBuffer(g.buffer);
            this.geometryBytes -= key.byteLength;
            this.geometry.delete(key);
        }
        let bytes = this.pool.reduce((n, s) => n + s.bytes, 0);
        while (bytes > 64 * 1024 * 1024 && this.pool.length) {
            const s = this.pool.shift()!;
            bytes -= s.bytes;
            this.deleteSurface(s);
        }
        while (this.advancedTables.size > 64) {
            const key = this.advancedTables.keys().next().value!;
            this.gl.deleteTexture(this.advancedTables.get(key)!);
            this.advancedTables.delete(key);
        }
        while (this.transferTextures.size > 64) {
            const key = this.transferTextures.keys().next().value!;
            this.gl.deleteTexture(this.transferTextures.get(key)!);
            this.transferTextures.delete(key);
        }
        while (this.stops.size > 256) {
            const key = this.stops.keys().next().value!;
            this.gl.deleteTexture(this.stops.get(key)!);
            this.stops.delete(key);
        }
        while (this.images.size > 64) {
            const key = this.images.keys().next().value!;
            this.gl.deleteTexture(this.images.get(key)!.texture);
            this.images.delete(key);
            this.imagePromises.delete(key);
        }
    }
    private deleteSurface(s: Surface): void {
        this.surfaceBytes -= s.bytes;
        this.gl.deleteTexture(s.texture);
        this.gl.deleteFramebuffer(s.framebuffer);
        if (s.msaa)
            this.gl.deleteFramebuffer(s.msaa);
        if (s.buffer)
            this.gl.deleteRenderbuffer(s.buffer);
    }
    private texture(): WebGLTexture {
        const gl = this.gl, t = gl.createTexture();
        if (!t)
            throw new Error('Unable to allocate SVG texture');
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }
    private bind(program: WebGLProgram, name: string, texture: WebGLTexture, unit: number): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.u(program, name), unit);
    }
    private u(program: WebGLProgram, name: string): WebGLUniformLocation | null {
        let map = this.uniforms.get(program);
        if (!map) {
            map = new Map();
            this.uniforms.set(program, map);
        }
        if (!map.has(name))
            map.set(name, this.gl.getUniformLocation(program, name));
        return map.get(name)!;
    }
    private program(vertex: string, fragment: string): WebGLProgram {
        const gl = this.gl, shaders: WebGLShader[] = [];
        let program: WebGLProgram | null = null;
        try {
            for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
                const s = gl.createShader(type);
                if (!s)
                    throw new Error('Unable to allocate SVG shader');
                shaders.push(s);
                gl.shaderSource(s, source);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                    throw new Error(gl.getShaderInfoLog(s) ?? 'SVG shader compilation failed');
            }
            program = gl.createProgram();
            if (!program)
                throw new Error('Unable to allocate SVG program');
            for (const s of shaders)
                gl.attachShader(program, s);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(program) ?? 'SVG program link failed');
            return program;
        }
        catch (e) {
            if (program)
                gl.deleteProgram(program);
            throw e;
        }
        finally {
            for (const s of shaders)
                gl.deleteShader(s);
        }
    }
    destroy(): void {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.abort.abort();
        for (const s of this.pool)
            this.deleteSurface(s);
        this.pool.length = 0;
        for (const g of this.geometry.values())
            this.gl.deleteBuffer(g.buffer);
        for (const t of this.stops.values())
            this.gl.deleteTexture(t);
        for (const t of this.advancedTables.values())
            this.gl.deleteTexture(t);
        for (const t of this.transferTextures.values())
            this.gl.deleteTexture(t);
        for (const i of this.images.values())
            this.gl.deleteTexture(i.texture);
        for (const p of [this.paintProgram, this.compositeProgram, this.effectProgram, this.advancedProgram])
            this.gl.deleteProgram(p);
        this.gl.deleteVertexArray(this.vao);
        this.gl.deleteTexture(this.white);
        this.geometry.clear();
        this.stops.clear();
        this.advancedTables.clear();
        this.transferTextures.clear();
        this.images.clear();
        this.imagePromises.clear();
        this.uniforms.clear();
        this.protectedImages.clear();
        this.geometryBytes = 0;
        this.compiler.clear();
        this.planCache = undefined;
    }
}

import { createMsdfgen, type MsdfFont } from "@playcanvas/msdfgen-wasm";
import msdfWasmUrl from "../../../node_modules/@playcanvas/msdfgen-wasm/dist/msdfgen.wasm?url";
import { fontWithGlyphIdCmap } from "./font-binary";
import { TextFont, type TextLayoutData } from "./text-layout";
import type { FontResource, RenderGraph, TextLayoutResource } from "./types";

type TextBlend = "alpha" | "premultiplied" | "additive";
export interface TextCellDraw { layout: TextLayoutResource; blend?: TextBlend; }
interface GlyphInfo {
  page: number;
  offsetX: number; offsetY: number; width: number; height: number;
  uv: [number, number, number, number];
}
interface AtlasPage { texture: WebGLTexture; x: number; y: number; rowHeight: number; }
interface FontEntry { text: TextFont; generator?: MsdfFont; }
interface GeometryChunk { page: number; data: Float32Array; }
interface Atlas {
  font: FontEntry; size: number; padding: number;
  glyphs: Map<number, GlyphInfo>; pages: AtlasPage[];
  geometries: WeakMap<TextLayoutData, GeometryChunk[]>;
}
interface BatchPart { chunk: GeometryChunk; paint: number[]; }
interface BatchPlan { atlas: Atlas; page: number; blend: TextBlend; parts: BatchPart[]; }
interface GpuBatch {
  geometry: WebGLBuffer; paint: WebGLBuffer; capacity: number; count: number;
  atlas: Atlas; parts: BatchPart[];
}
interface TextRun { batches: GpuBatch[]; }
const CELL_SIZE = 64;
const PIXEL_RANGE = 8;
const GEOMETRY_FLOATS = 8;
const PAINT_FLOATS = 6;
let msdfModule: ReturnType<typeof createMsdfgen> | undefined;

/** Binary fonts, local layouts, atlas geometry and GPU paint have separate lifetimes. */
export class TextRenderer {
  private destroyed = false;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly fonts = new Map<Uint8Array, FontEntry>();
  private readonly atlases: Atlas[] = [];
  private readonly runs = new Map<object, TextRun>();
  private readonly attributes: Record<string, number>;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly maxTextureSize: number;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.program = this.createProgram(`#version 300 es
      in vec2 a_corner; in vec4 a_rect; in vec4 a_uvRect;
      in vec2 a_offset; in vec4 a_color;
      uniform vec2 u_viewport; out vec2 v_uv; out vec4 v_color;
      void main() {
        vec2 p = a_offset + a_rect.xy + a_corner * a_rect.zw;
        gl_Position = vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0);
        v_uv = mix(a_uvRect.xy, a_uvRect.zw, a_corner); v_color = a_color;
      }
    `, `#version 300 es
      precision highp float;
      in vec2 v_uv; in vec4 v_color; uniform sampler2D u_atlas;
      uniform bool u_straightAlpha; out vec4 outColor;
      void main() {
        vec3 sampleValue = texture(u_atlas, v_uv).rgb;
        float distance = max(min(sampleValue.r, sampleValue.g), min(max(sampleValue.r, sampleValue.g), sampleValue.b));
        vec2 unitRange = vec2(${PIXEL_RANGE}.0) / vec2(textureSize(u_atlas, 0));
        float screenRange = max(0.5 * dot(unitRange, 1.0 / fwidth(v_uv)), 1.0);
        float alpha = clamp(screenRange * (distance - 0.5) + 0.5, 0.0, 1.0) * v_color.a;
        outColor = vec4(u_straightAlpha ? v_color.rgb : v_color.rgb * alpha, alpha);
      }
    `);
    const vao = gl.createVertexArray(), quad = gl.createBuffer();
    if (!vao || !quad) throw new Error("Failed to allocate text renderer buffers");
    this.vao = vao; this.quad = quad;
    this.attributes = Object.fromEntries(["a_rect", "a_uvRect", "a_offset", "a_color"].map((name) => [name, gl.getAttribLocation(this.program, name)]));
    this.uniforms = Object.fromEntries(["u_atlas", "u_straightAlpha", "u_viewport"].map((name) => [name, gl.getUniformLocation(this.program, name)]));
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, "a_corner");
    gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    for (const location of Object.values(this.attributes)) {
      gl.enableVertexAttribArray(location); gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
  }

  async render(layout: TextLayoutResource, graph: RenderGraph, width: number, height: number, blend: TextBlend = "premultiplied"): Promise<void> {
    await this.renderBatch([{ layout, blend }], graph, width, height, layout);
  }

  /** Caller supplies only adjacent text commands within a single pass. */
  async renderBatch(cells: TextCellDraw[], graph: RenderGraph, width: number, height: number, key: object): Promise<void> {
    if (this.destroyed) throw new Error("Text renderer has been destroyed");
    const plans: BatchPlan[] = [];
    for (const cell of cells) {
      const { layout } = cell;
      if (!layout.text) continue;
      const resource = graph.resources.get(layout.font);
      if (!resource || resource.kind !== "font" || !resource.data) throw new Error(`Font ${layout.font} requires loaded TTF/OTF data`);
      const atlas = await this.getAtlas(resource);
      if (this.destroyed) throw new Error("Text renderer has been destroyed");
      const local = atlas.font.text.layout(layout.text, layout.style, resource.features);
      const chunks = this.getGeometry(atlas, local);
      const blend = cell.blend ?? "premultiplied";
      for (const chunk of chunks) {
        let plan = plans[plans.length - 1];
        if (!plan || plan.atlas !== atlas || plan.page !== chunk.page || plan.blend !== blend) {
          plan = { atlas, page: chunk.page, blend, parts: [] }; plans.push(plan);
        }
        plan.parts.push({ chunk, paint: [...layout.position, ...layout.style.color] });
      }
    }
    const run = this.runs.get(key) ?? { batches: [] };
    this.runs.delete(key); this.runs.set(key, run);
    plans.forEach((plan, index) => {
      const batch = run.batches[index] ?? this.createBatch(plan.atlas);
      run.batches[index] = batch;
      this.updateBatch(batch, plan);
      this.drawBatch(batch, plan, width, height);
    });
    for (const batch of run.batches.splice(plans.length)) this.deleteBatch(batch);
    // Never evict an atlas while this run is still preparing or drawing its cells.
    this.pruneCaches();
  }

  private getFont(data: Uint8Array): FontEntry {
    const font = this.fonts.get(data) ?? { text: new TextFont(data) };
    this.fonts.delete(data); this.fonts.set(data, font);
    return font;
  }

  private async getAtlas(resource: FontResource): Promise<Atlas> {
    const font = this.getFont(resource.data!);
    const size = Math.min(resource.atlas?.pageSize ?? 2048, this.maxTextureSize);
    const padding = resource.atlas?.padding ?? 2;
    const index = this.atlases.findIndex((atlas) => atlas.font === font && atlas.size === size && atlas.padding === padding);
    if (index >= 0) { const [atlas] = this.atlases.splice(index, 1); this.atlases.push(atlas); return atlas; }
    if (CELL_SIZE + padding * 2 > size) throw new Error("MSDF atlas page must fit a 64px glyph and padding");
    if (!font.generator) {
      msdfModule ??= createMsdfgen({ moduleOverrides: { locateFile: () => msdfWasmUrl } });
      const module = await msdfModule;
      if (this.destroyed) throw new Error("Text renderer has been destroyed");
      font.generator ??= module.loadFont(fontWithGlyphIdCmap(resource.data!)) ?? undefined;
      if (!font.generator) throw new Error(`Unable to load font ${resource.id}`);
    }
    const loaded = this.atlases.findIndex((atlas) => atlas.font === font && atlas.size === size && atlas.padding === padding);
    if (loaded >= 0) { const [atlas] = this.atlases.splice(loaded, 1); this.atlases.push(atlas); return atlas; }
    const atlas: Atlas = { font, size, padding, glyphs: new Map(), pages: [], geometries: new WeakMap() };
    this.atlases.push(atlas);
    return atlas;
  }

  private getGeometry(atlas: Atlas, local: TextLayoutData): GeometryChunk[] {
    const cached = atlas.geometries.get(local);
    if (cached) return cached;
    const chunks: GeometryChunk[] = [];
    let page = -1, data: number[] = [];
    const flush = () => { if (data.length) chunks.push({ page, data: new Float32Array(data) }); data = []; };
    for (const item of local.glyphs) {
      const glyph = this.getGlyph(atlas, item.id);
      if (glyph.page < 0) continue;
      if (glyph.page !== page) { flush(); page = glyph.page; }
      data.push(item.x + glyph.offsetX * local.size, item.y + glyph.offsetY * local.size, glyph.width * local.size, glyph.height * local.size, ...glyph.uv);
    }
    flush();
    atlas.geometries.set(local, chunks);
    return chunks;
  }

  private getGlyph(atlas: Atlas, id: number): GlyphInfo {
    const cached = atlas.glyphs.get(id);
    if (cached) return cached;
    const extents = atlas.font.text.font.glyphExtents(id);
    const glyph: GlyphInfo = { page: -1, offsetX: 0, offsetY: 0, width: 0, height: 0, uv: [0, 0, 0, 0] };
    if (extents?.width && extents.height) {
      const bitmap = atlas.font.generator!.generateGlyph(0xf0000 + id, CELL_SIZE, PIXEL_RANGE);
      if (!bitmap) throw new Error(`Unable to generate MSDF glyph ${id}`);
      const { padding } = atlas, w = bitmap.width + padding * 2, h = bitmap.height + padding * 2;
      let page = atlas.pages[atlas.pages.length - 1] ?? this.newPage(atlas);
      if (page.x + w > atlas.size) { page.x = 0; page.y += page.rowHeight; page.rowHeight = 0; }
      if (page.y + h > atlas.size) page = this.newPage(atlas);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, page.texture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, page.x + padding, page.y + padding, bitmap.width, bitmap.height, gl.RGBA, gl.UNSIGNED_BYTE, bitmap.rgba);
      glyph.page = atlas.pages.length - 1;
      glyph.offsetX = -bitmap.translateX; glyph.offsetY = bitmap.translateY - 2;
      glyph.width = 2; glyph.height = 2;
      glyph.uv = [(page.x + padding) / atlas.size, (page.y + padding) / atlas.size, (page.x + padding + bitmap.width) / atlas.size, (page.y + padding + bitmap.height) / atlas.size];
      page.x += w; page.rowHeight = Math.max(page.rowHeight, h);
    }
    atlas.glyphs.set(id, glyph);
    return glyph;
  }

  private newPage(atlas: Atlas): AtlasPage {
    const gl = this.gl, texture = gl.createTexture();
    if (!texture) throw new Error("Failed to allocate text atlas");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, atlas.size, atlas.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const page = { texture, x: 0, y: 0, rowHeight: 0 }; atlas.pages.push(page); return page;
  }

  private createBatch(atlas: Atlas): GpuBatch {
    const geometry = this.gl.createBuffer(), paint = this.gl.createBuffer();
    if (!geometry || !paint) throw new Error("Failed to allocate text batch buffers");
    return { geometry, paint, capacity: 0, count: 0, atlas, parts: [] };
  }

  private updateBatch(batch: GpuBatch, plan: BatchPlan): void {
    const gl = this.gl;
    const count = plan.parts.reduce((sum, part) => sum + part.chunk.data.length / GEOMETRY_FLOATS, 0);
    const geometryChanged = batch.parts.length !== plan.parts.length || plan.parts.some((part, index) => part.chunk !== batch.parts[index].chunk);
    if (count > batch.capacity) {
      batch.capacity = Math.max(count, batch.capacity * 2, 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.geometry); gl.bufferData(gl.ARRAY_BUFFER, batch.capacity * GEOMETRY_FLOATS * 4, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.paint); gl.bufferData(gl.ARRAY_BUFFER, batch.capacity * PAINT_FLOATS * 4, gl.DYNAMIC_DRAW);
    }
    if (geometryChanged) {
      const data = new Float32Array(count * GEOMETRY_FLOATS);
      let offset = 0;
      for (const part of plan.parts) { data.set(part.chunk.data, offset); offset += part.chunk.data.length; }
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.geometry); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    }
    let offset = 0;
    plan.parts.forEach((part, index) => {
      const length = part.chunk.data.length / GEOMETRY_FLOATS;
      if (geometryChanged || part.paint.some((value, field) => value !== batch.parts[index].paint[field])) {
        const data = new Float32Array(length * PAINT_FLOATS);
        for (let i = 0; i < length; i++) data.set(part.paint, i * PAINT_FLOATS);
        gl.bindBuffer(gl.ARRAY_BUFFER, batch.paint); gl.bufferSubData(gl.ARRAY_BUFFER, offset * PAINT_FLOATS * 4, data);
      }
      offset += length;
    });
    batch.parts = plan.parts; batch.count = count; batch.atlas = plan.atlas;
  }

  private drawBatch(batch: GpuBatch, plan: BatchPlan, width: number, height: number): void {
    const gl = this.gl;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.geometry);
    gl.vertexAttribPointer(this.attributes.a_rect, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribPointer(this.attributes.a_uvRect, 4, gl.FLOAT, false, 32, 16);
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.paint);
    gl.vertexAttribPointer(this.attributes.a_offset, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(this.attributes.a_color, 4, gl.FLOAT, false, 24, 8);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, plan.atlas.pages[plan.page].texture);
    gl.uniform1i(this.uniforms.u_atlas, 0); gl.uniform1i(this.uniforms.u_straightAlpha, plan.blend === "alpha" ? 1 : 0);
    gl.uniform2f(this.uniforms.u_viewport, width, height);
    gl.enable(gl.BLEND);
    if (plan.blend === "additive") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFuncSeparate(plan.blend === "alpha" ? gl.SRC_ALPHA : gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    gl.bindVertexArray(null);
  }

  private deleteBatch(batch: GpuBatch): void { this.gl.deleteBuffer(batch.geometry); this.gl.deleteBuffer(batch.paint); }
  private deleteRun(key: object): void {
    for (const batch of this.runs.get(key)!.batches) this.deleteBatch(batch);
    this.runs.delete(key);
  }
  private deleteAtlas(atlas: Atlas): void {
    for (const page of atlas.pages) this.gl.deleteTexture(page.texture);
    for (const [key, run] of this.runs) if (run.batches.some((batch) => batch.atlas === atlas)) this.deleteRun(key);
  }
  private pruneCaches(): void {
    while (this.atlases.length > 8) this.deleteAtlas(this.atlases.shift()!);
    while (this.fonts.size > 8) {
      const [data, font] = this.fonts.entries().next().value!;
      for (let i = this.atlases.length - 1; i >= 0; i--) {
        if (this.atlases[i].font === font) { this.deleteAtlas(this.atlases[i]); this.atlases.splice(i, 1); }
      }
      font.generator?.delete(); this.fonts.delete(data);
    }
    while (this.runs.size > 128) this.deleteRun(this.runs.keys().next().value!);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const key of this.runs.keys()) this.deleteRun(key);
    for (const atlas of this.atlases) this.deleteAtlas(atlas);
    this.atlases.length = 0;
    for (const font of this.fonts.values()) font.generator?.delete();
    this.fonts.clear();
    this.gl.deleteBuffer(this.quad); this.gl.deleteVertexArray(this.vao); this.gl.deleteProgram(this.program);
  }

  private createProgram(vertex: string, fragment: string): WebGLProgram {
    const vs = this.shader(this.gl.VERTEX_SHADER, vertex), fs = this.shader(this.gl.FRAGMENT_SHADER, fragment);
    const program = this.gl.createProgram();
    if (!program) throw new Error("Failed to create text program");
    this.gl.attachShader(program, vs); this.gl.attachShader(program, fs); this.gl.linkProgram(program);
    this.gl.deleteShader(vs); this.gl.deleteShader(fs);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) throw new Error(this.gl.getProgramInfoLog(program) || "Text program linking failed");
    return program;
  }

  private shader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error("Failed to create text shader");
    this.gl.shaderSource(shader, source); this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || "Text shader compilation failed");
    return shader;
  }
}

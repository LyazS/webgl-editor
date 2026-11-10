import type { FontResource, RenderGraph, TextLayoutResource } from "./types";

interface GlyphPlacement { glyphId: number; fontId: string; codepoint: number; x: number; y: number; }
interface GlyphInfo { page: number; width: number; height: number; u0: number; v0: number; u1: number; v1: number; }
interface AtlasPage { texture: WebGLTexture; pixels: Uint8Array; canvas?: HTMLCanvasElement; context?: CanvasRenderingContext2D; }
interface Atlas { size: number; pages: AtlasPage[]; glyphs: Map<string, GlyphInfo>; msdf: boolean; color: boolean; }

/** Deterministic binary-font renderer with HarfBuzz shaping and paged MSDF atlases. */
export class TextRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quad: WebGLBuffer;
  private readonly instances: WebGLBuffer;
  private readonly atlases = new Map<string, Atlas>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = this.createProgram(`#version 300 es
      in vec2 a_corner; in vec4 a_rect; in vec4 a_uvRect;
      uniform vec2 u_viewport; out vec2 v_uv;
      void main() { vec2 p=a_rect.xy+a_corner*a_rect.zw; vec2 ndc=vec2(p.x/u_viewport.x*2.0-1.0,1.0-p.y/u_viewport.y*2.0); gl_Position=vec4(ndc,0.0,1.0); v_uv=mix(a_uvRect.xy,a_uvRect.zw,a_corner); }
    `, `#version 300 es
      precision highp float; in vec2 v_uv; uniform sampler2D u_atlas; uniform vec4 u_color; uniform bool u_msdf; uniform bool u_colorAtlas; out vec4 outColor;
      float median(float r,float g,float b){return max(min(r,g),min(max(r,g),b));}
      void main(){ vec4 sampleColor=texture(u_atlas,v_uv); if(u_colorAtlas){ outColor=vec4(sampleColor.rgb*u_color.rgb,sampleColor.a*u_color.a); return; } float alpha=u_msdf ? smoothstep(0.46,0.54,median(sampleColor.r,sampleColor.g,sampleColor.b)) : sampleColor.r; alpha*=u_color.a; outColor=vec4(u_color.rgb*alpha,alpha); }
    `);
    const vao = gl.createVertexArray(), quad = gl.createBuffer(), instances = gl.createBuffer();
    if (!vao || !quad || !instances) throw new Error("Failed to allocate text renderer buffers");
    this.vao = vao; this.quad = quad; this.instances = instances;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, "a_corner"); gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instances); gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    for (const [name, size, offset] of [["a_rect", 4, 0], ["a_uvRect", 4, 16] ] as const) { const location = gl.getAttribLocation(this.program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset); gl.vertexAttribDivisor(location, 1); }
    gl.bindVertexArray(null);
  }

  async render(layout: TextLayoutResource, graph: RenderGraph, width: number, height: number, blend: "alpha" | "premultiplied" | "additive" = "premultiplied"): Promise<void> {
    const font = graph.resources.get(layout.font); if (!font || font.kind !== "font") throw new Error(`Missing font: ${layout.font}`);
    if (font.data) {
      const shaped = await this.shape(layout, font, graph); const atlas = await this.getMsdfAtlas(graph, font, layout.style.size, layout.text, shaped);
      const byPage = new Map<number, number[][]>();
      for (const item of shaped) { const glyph = atlas.glyphs.get(`${item.fontId}:${item.glyphId}`) ?? atlas.glyphs.get(`${item.fontId}:cp:${item.codepoint}`); if (!glyph) continue; const list = byPage.get(glyph.page) ?? []; list.push([item.x, item.y - glyph.height, glyph.width, glyph.height, glyph.u0, glyph.v0, glyph.u1, glyph.v1]); byPage.set(glyph.page, list); }
      for (const [page, instances] of byPage) this.drawInstances(instances, atlas.pages[page].texture, atlas.msdf, atlas.color, layout.style.color, width, height, blend);
      return;
    }
    const fallback = this.layoutWithCanvas(layout, font); const atlas = this.getCanvasAtlas(font, layout.style.size, fallback.characters); const instances = fallback.instances.map((item) => { const glyph = atlas.glyphs.get(item.char); return glyph ? [item.x, item.y, glyph.width, glyph.height, glyph.u0, glyph.v0, glyph.u1, glyph.v1] : null; }).filter((item): item is number[] => !!item); if (instances.length) this.drawInstances(instances, atlas.pages[0].texture, false, false, layout.style.color, width, height, blend);
  }

  private drawInstances(instances: number[][], texture: WebGLTexture, msdf: boolean, colorAtlas: boolean, color: [number, number, number, number], width: number, height: number, blend: "alpha" | "premultiplied" | "additive"): void {
    const gl = this.gl; gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.instances); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances.flat()), gl.DYNAMIC_DRAW); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(gl.getUniformLocation(this.program, "u_atlas"), 0); gl.uniform1i(gl.getUniformLocation(this.program, "u_msdf"), msdf ? 1 : 0); gl.uniform1i(gl.getUniformLocation(this.program, "u_colorAtlas"), colorAtlas ? 1 : 0); gl.uniform2f(gl.getUniformLocation(this.program, "u_viewport"), width, height); gl.uniform4f(gl.getUniformLocation(this.program, "u_color"), ...color); gl.enable(gl.BLEND); if (blend === "additive") gl.blendFunc(gl.ONE, gl.ONE); else if (blend === "alpha") gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.length); gl.bindVertexArray(null);
  }

  private async shape(layout: TextLayoutResource, primary: FontResource, graph: RenderGraph): Promise<GlyphPlacement[]> {
    const hb = await import("harfbuzzjs");
    const run = (text: string, resource: FontResource): GlyphPlacement[] => {
      if (!resource.data) return [];
      const blob = new hb.Blob(new Uint8Array(resource.data)); const face = new hb.Face(blob); const font = new hb.Font(face); const buffer = new hb.Buffer(); const variations = Object.entries(resource.variations ?? {}).map(([tag, value]) => hb.Variation.fromString(`${tag}=${value}`)).filter((item): item is NonNullable<typeof item> => !!item); if (variations.length) font.setVariations(variations); buffer.addText(text); buffer.guessSegmentProperties(); const features = (resource.features ?? ["kern", "liga"]).map((value) => hb.Feature.fromString(value)).filter((item): item is NonNullable<typeof item> => !!item); hb.shape(font, buffer, features); const infos = buffer.getGlyphInfos(); const positions = buffer.getGlyphPositions(); const codepoints = Array.from(text).map((char) => char.codePointAt(0) ?? 0); let x = 0; return infos.map((info, index) => { const position = positions[index]; const codepoint = codepoints[Math.min(index, codepoints.length - 1)] ?? 0; const item = { glyphId: info.codepoint, fontId: resource.id, codepoint, x: x + position.xOffset * layout.style.size / face.upem / 64, y: layout.position[1] - position.yOffset * layout.style.size / face.upem / 64 }; x += position.xAdvance * layout.style.size / face.upem / 64; return item; });
    };
    const fallbacks = (primary.fallback ?? []).map((id) => graph.resources.get(id)).filter((item): item is FontResource => !!item && item.kind === "font" && !!item.data); if (!fallbacks.length) return run(layout.text, primary).map((item) => ({ ...item, x: item.x + layout.position[0], y: item.y }));
    const result: GlyphPlacement[] = []; let x = layout.position[0]; for (const char of Array.from(layout.text)) { let glyphs = run(char, primary); let selected = primary; if (!glyphs.length || glyphs.every((glyph) => glyph.glyphId === 0)) { for (const candidate of fallbacks) { const attempt = run(char, candidate); if (attempt.length && attempt.some((glyph) => glyph.glyphId !== 0)) { glyphs = attempt; selected = candidate; break; } } } for (const glyph of glyphs) { result.push({ ...glyph, fontId: selected.id, x: x + glyph.x, y: glyph.y }); } x += glyphs.reduce((sum, glyph) => sum + Math.max(0, glyph.x), 0); }
    return result;
  }

  private async getMsdfAtlas(graph: RenderGraph, primary: FontResource, size: number, text: string, shaped: GlyphPlacement[]): Promise<Atlas> {
    const mode = primary.atlas?.mode ?? "msdf"; const pageSize = primary.atlas?.pageSize ?? 2048; const key = `msdf:${size}:${pageSize}:${mode}:${[...new Set(shaped.map((item) => `${item.fontId}:${item.glyphId}:${item.codepoint}`))].sort().join(",")}`; const cached = this.atlases.get(key); if (cached) return cached;
    const generator = await import("@playcanvas/msdfgen-wasm"); const msdfgen = await generator.createMsdfgen(); const unique = new Map<string, { font: FontResource; codepoint: number }>(); for (const item of shaped) { const font = graph.resources.get(item.fontId); if (font?.kind === "font" && font.data) unique.set(`${item.fontId}:cp:${item.codepoint}`, { font, codepoint: item.codepoint }); }
    const atlas: Atlas = { size: pageSize, pages: [], glyphs: new Map(), msdf: mode === "msdf", color: mode === "color" }; let x = 0; let y = 0; const row = Math.max(32, Math.ceil(size * 1.5)); let page = this.newPage(pageSize, atlas.msdf || atlas.color, atlas.color);
    const hb = await import("harfbuzzjs"); const hbFonts = new Map<string, any>(); for (const item of unique.values()) { if (!hbFonts.has(item.font.id)) { const blob = new hb.Blob(new Uint8Array(item.font.data!)); hbFonts.set(item.font.id, new hb.Font(new hb.Face(blob))); } }
    for (const [keyPart, item] of unique) {
      let width = Math.max(32, Math.ceil(size)), height = width, rgba: Uint8Array | undefined;
      if (atlas.color) { const shapedItem = shaped.find((glyph) => `${glyph.fontId}:cp:${glyph.codepoint}` === keyPart); const png = shapedItem ? hbFonts.get(item.font.id)?.glyphColorPNG(shapedItem.glyphId) : undefined; const colorContext = page.context; if (png && typeof createImageBitmap === "function" && colorContext) { const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" })); width = bitmap.width; height = bitmap.height; if (x + width > pageSize) { this.finalizePage(page, pageSize, true); atlas.pages.push(page); page = this.newPage(pageSize, true, true); x = 0; y = 0; } page.context?.drawImage(bitmap, x, y); bitmap.close(); atlas.glyphs.set(keyPart, { page: atlas.pages.length, width, height, u0: x / pageSize, v0: y / pageSize, u1: (x + width) / pageSize, v1: (y + height) / pageSize }); x += width + 2; continue; } }
      const loaded = msdfgen.loadFont(item.font.data!); if (!loaded) continue; const glyph = loaded.generateGlyph(item.codepoint, Math.max(32, Math.ceil(size)), 8); loaded.delete(); if (!glyph) continue; width = glyph.width; height = glyph.height; if (x + width > pageSize) { x = 0; y += row; } if (y + height > pageSize) { this.finalizePage(page, pageSize, atlas.color); atlas.pages.push(page); page = this.newPage(pageSize, atlas.msdf || atlas.color, atlas.color); x = 0; y = 0; } rgba = glyph.rgba; const bytesPerPixel = atlas.msdf || atlas.color ? 4 : 1; for (let yy = 0; yy < height; yy++) { if (bytesPerPixel === 4) page.pixels.set(rgba.slice(yy * width * 4, (yy + 1) * width * 4), ((y + yy) * pageSize + x) * bytesPerPixel); else for (let xx = 0; xx < width; xx++) page.pixels[(y + yy) * pageSize + x + xx] = rgba[(yy * width + xx) * 4 + 3]; } atlas.glyphs.set(keyPart, { page: atlas.pages.length, width, height, u0: x / pageSize, v0: y / pageSize, u1: (x + width) / pageSize, v1: (y + height) / pageSize }); x += width + 2;
    }
    this.finalizePage(page, pageSize, atlas.color); atlas.pages.push(page); for (const item of atlas.pages) this.uploadPage(item, pageSize, atlas.msdf || atlas.color); this.atlases.set(key, atlas); return atlas;
  }

  private newPage(size: number, rgba: boolean, color = false): AtlasPage { const page: AtlasPage = { texture: this.gl.createTexture()!, pixels: new Uint8Array(size * size * (rgba ? 4 : 1)) }; if (color) { page.canvas = document.createElement("canvas"); page.canvas.width = size; page.canvas.height = size; page.context = page.canvas.getContext("2d")!; } return page; }
  private finalizePage(page: AtlasPage, size: number, color: boolean): void { if (color && page.context) page.pixels = new Uint8Array(page.context.getImageData(0, 0, size, size).data.buffer); }
  private uploadPage(page: AtlasPage, size: number, msdf: boolean): void { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, page.texture); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, msdf ? gl.RGBA8 : gl.R8, size, size, 0, msdf ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, page.pixels); gl.bindTexture(gl.TEXTURE_2D, null); }

  private layoutWithCanvas(layout: TextLayoutResource, font: FontResource): { instances: Array<{ char: string; x: number; y: number }>; characters: string[] } { const ctx = document.createElement("canvas").getContext("2d")!; ctx.font = `${layout.style.size}px ${font.family}`; const chars = Array.from(layout.text); let x = layout.position[0]; return { characters: [...new Set(chars)], instances: chars.map((char) => { const item = { char, x, y: layout.position[1] }; x += ctx.measureText(char).width + (layout.style.letterSpacing ?? 0); return item; }) }; }
  private getCanvasAtlas(font: FontResource, size: number, characters: string[]): Atlas { const key = `canvas:${font.id}:${size}:${characters.sort().join("")}`; const existing = this.atlases.get(key); if (existing) return existing; const canvas = document.createElement("canvas"); canvas.width = 2048; canvas.height = 2048; const ctx = canvas.getContext("2d")!; ctx.font = `${size}px ${font.family}`; ctx.textBaseline = "top"; ctx.fillStyle = "white"; const glyphs = new Map<string, GlyphInfo>(); let x = 2; for (const char of characters) { const width = Math.max(1, Math.ceil(ctx.measureText(char).width + 4)); ctx.fillText(char, x + 2, 2); glyphs.set(char, { page: 0, width, height: Math.ceil(size * 1.5), u0: x / 2048, v0: 0, u1: (x + width) / 2048, v1: Math.ceil(size * 1.5) / 2048 }); x += width; } const pixels = ctx.getImageData(0, 0, 2048, 2048).data; const alpha = new Uint8Array(2048 * 2048); for (let i = 0; i < 2048 * 2048; i++) alpha[i] = pixels[i * 4 + 3]; const page = this.newPage(2048, false); page.pixels.set(alpha); const atlas: Atlas = { size: 2048, pages: [page], glyphs, msdf: false, color: false }; this.uploadPage(page, 2048, false); this.atlases.set(key, atlas); return atlas; }
  private createProgram(vertex: string, fragment: string): WebGLProgram { const vs = this.shader(this.gl.VERTEX_SHADER, vertex), fs = this.shader(this.gl.FRAGMENT_SHADER, fragment), program = this.gl.createProgram(); if (!program) throw new Error("Failed to create text program"); this.gl.attachShader(program, vs); this.gl.attachShader(program, fs); this.gl.linkProgram(program); if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) throw new Error(this.gl.getProgramInfoLog(program) || "Text program linking failed"); return program; }
  private shader(type: number, source: string): WebGLShader { const shader = this.gl.createShader(type); if (!shader) throw new Error("Failed to create text shader"); this.gl.shaderSource(shader, source); this.gl.compileShader(shader); if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || "Text shader compilation failed"); return shader; }
}

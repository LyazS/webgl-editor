import { LuaFactory, LuaLibraries, type LuaEngine } from "wasmoon";
import { RenderGraphBuilder, RenderPassBuilder } from "../render-graph/graph";
import type { BufferDataType, MaterialDefinition, RenderGraph, UniformBindings, UniformType, VertexAttributeLayout } from "../render-graph/types";

export interface FrameContext { FPS: 30; totalFrames: number; frame: number; }
type LuaState = Record<string, unknown>;
type BufferDeclaration = { bufferKind: "vertex" | "index"; data: number[]; type: BufferDataType; usage: "static" | "dynamic" };
type TextureDeclaration = { width: number | "viewport"; height: number | "viewport"; format: "rgba8"; persistent?: boolean; depth?: boolean; capacity?: number; minFilter?: "nearest" | "linear"; magFilter?: "nearest" | "linear"; wrapS?: "clamp-to-edge" | "repeat" | "mirrored-repeat"; wrapT?: "clamp-to-edge" | "repeat" | "mirrored-repeat" };

export class LuaRenderRuntime {
  private readonly factory = new LuaFactory();
  private engine?: LuaEngine;
  private source?: string;
  private state: LuaState = {};
  private builder?: RenderGraphBuilder;
  private readonly declaredTextures = new Map<string, TextureDeclaration>();
  private readonly declaredBuffers = new Map<string, BufferDeclaration>();
  private readonly declaredMeshes = new Map<string, { vertexBuffers: Record<string, string>; indexBuffer?: string; topology: "triangles" | "triangle-strip" | "lines"; vertexCount: number; indexCount?: number; attributes?: Record<string, VertexAttributeLayout> }>();
  private readonly declaredPrograms = new Map<string, MaterialDefinition>();
  private resourceCounter = 0;

  async compile(source: string, files: Record<string, string>): Promise<void> {
    this.shaderFiles = files; this.declaredTextures.clear(); this.declaredBuffers.clear(); this.declaredMeshes.clear(); this.declaredPrograms.clear(); this.resourceCounter = 0;
    const engine = await this.factory.createEngine({ openStandardLibs: false, injectObjects: false, functionTimeout: 200 });
    const builder = new RenderGraphBuilder(); builder.screen();
    this.builder = builder;
    for (const library of [LuaLibraries.Base, LuaLibraries.Table, LuaLibraries.String, LuaLibraries.Math]) engine.global.loadLibrary(library);
    engine.global.set("require", (name: string) => { if (name !== "render_graph") throw new Error("Only the render_graph SDK is available"); return this.createSdk(); });
    engine.global.set("__shader_file", (path: string) => { const content = files[path]; if (content === undefined) throw new Error(`Shader file not found: ${path}`); return content; });
    try {
      await engine.doString(source);
      const setup = engine.global.get("setup"); const render = engine.global.get("render");
      if (typeof setup !== "function") throw new Error("The script must define setup()");
      if (typeof render !== "function") throw new Error("The script must define render(ctx, state)");
      const previousEngine = this.engine;
      this.engine = engine; this.builder = builder;
      const state = await setup(); this.state = state && typeof state === "object" ? state as LuaState : {};
      this.source = source; builder.compile("screen"); previousEngine?.global.close();
    } catch (error) { engine.global.close(); this.engine = undefined; this.builder = undefined; throw this.normalizeError(error); }
  }

  async buildGraph(frame: number, _width: number, _height: number, totalFrames: number): Promise<RenderGraph> {
    if (!this.engine || !this.source || !this.builder) throw new Error("Lua runtime has not been compiled");
    try { await this.engine.global.get("render")({ FPS: 30, totalFrames, frame }, this.state); return this.builder.compile("screen"); }
    catch (error) { throw this.normalizeError(error); }
  }

  async recompile(): Promise<void> {
    if (!this.source) throw new Error("Lua runtime has not been compiled");
    await this.compile(this.source, this.shaderFiles);
  }

  snapshotState(): unknown {
    return this.cloneValue(this.state);
  }

  restoreState(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") throw new Error("Checkpoint state must be a table");
    this.state = this.cloneValue(snapshot) as LuaState;
  }

  async close(): Promise<void> { this.engine?.global.close(); this.engine = undefined; this.builder = undefined; this.source = undefined; this.state = {}; }

  private createSdk() {
    return {
      texture: (name: string, descriptor: Partial<TextureDeclaration>) => {
        if (this.declaredTextures.has(name)) throw new Error(`Texture already exists: ${name}`);
        const normalized = { width: descriptor.width ?? "viewport", height: descriptor.height ?? "viewport", format: descriptor.format ?? "rgba8", ...descriptor } as TextureDeclaration;
        this.declaredTextures.set(name, normalized); this.builder?.texture(name, normalized); return name;
      },
      renderTarget: (name: string, descriptor: Partial<TextureDeclaration> = {}) => {
        const normalized = { ...descriptor, width: descriptor.width ?? "viewport", height: descriptor.height ?? "viewport", format: descriptor.format ?? "rgba8" } as TextureDeclaration;
        if (name !== "screen") this.builder?.texture(name, normalized);
        const pass = new RenderPassBuilder(name, undefined);
        pass.write(name);
        this.builder?.addPass(pass.pass);
        return this.createPassHandle(pass);
      },
      historyTarget: (name: string, descriptor: TextureDeclaration & { capacity: number }) => {
        const normalized = { ...descriptor, width: descriptor.width ?? "viewport", height: descriptor.height ?? "viewport", format: descriptor.format ?? "rgba8" } as TextureDeclaration & { capacity: number };
        this.builder?.historyTarget(name, normalized);
        const pass = new RenderPassBuilder(name, undefined);
        pass.write(name);
        this.builder?.addPass(pass.pass);
        return this.createPassHandle(pass);
      },
      accumulationTarget: (name: string, descriptor: TextureDeclaration) => {
        const normalized = { ...descriptor, width: descriptor.width ?? "viewport", height: descriptor.height ?? "viewport", format: descriptor.format ?? "rgba8" } as TextureDeclaration;
        this.builder?.accumulationTarget(name, normalized);
        const pass = new RenderPassBuilder(name, undefined);
        pass.write(name);
        this.builder?.addPass(pass.pass);
        return this.createPassHandle(pass);
      },
      vertexBuffer: (descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }) => this.createBufferHandle("vertex", descriptor),
      indexBuffer: (descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }) => this.createBufferHandle("index", descriptor),
      mesh: (descriptor: { vertexBuffers: Record<string, unknown>; indexBuffer?: unknown; topology?: "triangles" | "triangle-strip" | "lines"; vertexCount: number; indexCount?: number; attributes?: Record<string, VertexAttributeLayout> }) => {
        const id = this.nextResourceId("mesh"); const vertexBuffers: Record<string, string> = {};
        for (const [semantic, handle] of Object.entries(descriptor.vertexBuffers ?? {})) vertexBuffers[semantic] = this.handleId(handle, `vertex buffer for ${semantic}`);
        const definition = { vertexBuffers, indexBuffer: descriptor.indexBuffer ? this.handleId(descriptor.indexBuffer, "index buffer") : undefined, topology: descriptor.topology ?? "triangles", vertexCount: descriptor.vertexCount, indexCount: descriptor.indexCount, attributes: descriptor.attributes } as const;
        this.declaredMeshes.set(id, definition); this.builder?.mesh(id, definition); return { id };
      },
      program: (name: string, descriptor: { vertex: string; fragment: string; vertexInputs?: Record<string, string> }) => { if (this.declaredPrograms.has(name)) throw new Error(`Program already exists: ${name}`); const definition = { vertex: this.readShaderFile(descriptor.vertex), fragment: this.readShaderFile(descriptor.fragment), vertexInputs: descriptor.vertexInputs }; this.declaredPrograms.set(name, definition); this.builder?.program(name, definition); return name; },
    };
  }

  private createPassHandle(pass: RenderPassBuilder) {
    return {
      clear: (color: [number, number, number, number]) => pass.clear(color),
      addDrawCell: (name: string, options: { mesh: unknown; program: string; textures?: Record<string, unknown>; uniforms?: unknown; instanceCount?: number }) => {
        const command = { type: "mesh" as const, mesh: this.handleId(options.mesh, "mesh"), program: options.program, uniforms: this.normalizeUniforms(options.uniforms), enabled: true, instanceCount: this.normalizeInstanceCount(options.instanceCount ?? 1) };
        this.applyTextures(pass, command, options.textures); const storedCommand = pass.drawMesh(command); return this.createDrawCellHandle(pass, storedCommand, name);
      }
    };
  }

  private createDrawCellHandle(pass: RenderPassBuilder, command: { type: "mesh"; mesh: string; program: string; uniforms?: UniformBindings; enabled?: boolean; instanceCount?: number }, _name: string) {
    return {
      setUniform: (name: string, value: unknown) => { command.uniforms = { ...(command.uniforms ?? {}), [name]: this.normalizeUniform(value, name) }; },
      setTextures: (textures: Record<string, unknown>) => this.applyTextures(pass, command, textures),
      setEnabled: (enabled: boolean) => { command.enabled = enabled; },
      setInstanceCount: (count: number) => { command.instanceCount = this.normalizeInstanceCount(count); },
      update: (value: { textures?: Record<string, unknown>; uniforms?: unknown; instanceCount?: number }) => { if (value.textures) this.applyTextures(pass, command, value.textures); if (value.uniforms) command.uniforms = { ...(command.uniforms ?? {}), ...this.normalizeUniforms(value.uniforms) }; if (value.instanceCount !== undefined) command.instanceCount = this.normalizeInstanceCount(value.instanceCount); }
    };
  }

  private applyTextures(pass: RenderPassBuilder, command: { uniforms?: UniformBindings }, textures?: Record<string, unknown>): void {
    for (const [uniform, value] of Object.entries(textures ?? {})) {
      const textureName = typeof value === "string" ? value : (value as { name?: unknown }).name;
      if (typeof textureName !== "string") throw new Error(`Texture binding ${uniform} requires a texture name`);
      command.uniforms = { ...(command.uniforms ?? {}), [uniform]: { type: "sampler2D", value } as never };
      pass.read(textureName);
    }
  }

  private createBufferHandle(kind: "vertex" | "index", descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }) {
    const id = this.nextResourceId(kind); const definition = { bufferKind: kind, data: this.normalizeNumericArray(descriptor.data, `${kind} buffer`), type: descriptor.type ?? (kind === "vertex" ? "float32" : "uint16"), usage: descriptor.usage ?? "static" } as const;
    this.declaredBuffers.set(id, definition);
    if (kind === "vertex") this.builder?.vertexBuffer(id, definition); else this.builder?.indexBuffer(id, definition);
    return { id, setData: (data: unknown) => this.updateDeclaredBuffer(id, data, 0), updateRange: (offset: number, data: unknown) => this.updateDeclaredBuffer(id, data, offset) };
  }

  private updateDeclaredBuffer(id: string, value: unknown, offset: number): void { if (!this.builder) throw new Error("Buffer updates are only available after setup()"); this.builder.updateBuffer(id, this.normalizeNumericArray(value, `buffer ${id}`), offset); }
  private handleId(value: unknown, label: string): string { if (typeof value === "string") return value; if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id; throw new Error(`${label} must be a resource handle`); }
  private nextResourceId(prefix: string): string { this.resourceCounter += 1; return `__${prefix}_${this.resourceCounter}`; }

  private normalizeUniform(value: unknown, name: string): { type: UniformType; value: number | number[] | string | { name: string; offset: number } } { if (!value || typeof value !== "object") throw new Error(`uniform ${name} must be a descriptor`); const descriptor = value as { type?: unknown; value?: unknown }; if (typeof descriptor.type !== "string") throw new Error(`uniform ${name} requires a type`); if (descriptor.type === "sampler2D") { if (typeof descriptor.value === "string") return { type: descriptor.type as UniformType, value: descriptor.value }; if (descriptor.value && typeof descriptor.value === "object" && typeof (descriptor.value as { name?: unknown }).name === "string") return { type: descriptor.type as UniformType, value: descriptor.value as { name: string; offset: number } }; throw new Error(`sampler uniform ${name} requires a texture name`); } if (typeof descriptor.value === "number") return { type: descriptor.type as UniformType, value: descriptor.value }; return { type: descriptor.type as UniformType, value: this.normalizeNumericArray(descriptor.value, `uniform ${name}`) }; }
  private normalizeUniforms(value: unknown): UniformBindings | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== "object") throw new Error("uniforms must be a table"); const result: UniformBindings = {}; for (const [name, raw] of Object.entries(value as Record<string, unknown>)) result[name] = this.normalizeUniform(raw, name); return result; }
  private shaderFiles: Record<string, string> = {};
  private readShaderFile(path: string): string { const content = this.shaderFiles[path]; if (content === undefined) throw new Error(`Shader file not found: ${path}`); return content; }
  private normalizeNumericArray(value: unknown, label: string): number[] { if (Array.isArray(value)) return value.map((item) => Number(item)); if (value && typeof value === "object") { const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => /^\d+$/.test(key)).sort(([a], [b]) => Number(a) - Number(b)); if (entries.length > 0) return entries.map(([, item]) => Number(item)); } throw new Error(`${label} data must be an array of numbers`); }
  private normalizeInstanceCount(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("instanceCount must be a positive integer"); return value; }
  private normalizeError(error: unknown): Error { if (error instanceof Error) return error; return new Error(String(error)); }

  private cloneValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      for (const item of value) result.push(this.cloneValue(item, seen));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== "function") result[key] = this.cloneValue(item, seen);
    }
    return result;
  }
}

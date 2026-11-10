import type {
  BufferDataType,
  DepthFunc,
  DrawMeshCommand,
  HistoryTextureReference,
  PrimitiveTopology,
  RenderGraph,
  RenderPass,
  TextureDescriptor,
  UniformBindings,
  VertexAttributeLayout
} from "./types";
import { TextRenderer } from "./text-renderer";

interface RenderTarget {
  kind: "target";
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  samplerFingerprint: string;
  depthRenderbuffer?: WebGLRenderbuffer;
}

interface HistoryRenderTarget {
  kind: "history";
  slots: RenderTarget[];
  capacity: number;
  frames: Array<number | null>;
}

interface AccumulationRenderTarget {
  kind: "accumulation";
  slots: [RenderTarget, RenderTarget];
  readIndex: 0 | 1;
  initialized: boolean;
}

interface CachedMaterialProgram {
  program: WebGLProgram;
  vertex: string;
  fragment: string;
  vertexInputsKey: string;
}

interface CachedBuffer {
  buffer: WebGLBuffer;
  fingerprint: string;
}

export interface TemporalCheckpoint {
  history: Record<string, { frames: Array<number | null>; slots: Uint8Array[] }>;
  accumulation: Record<string, { readIndex: 0 | 1; initialized: boolean; slots: Uint8Array[] }>;
}

export class WebGLExecutor {
  private readonly gl: WebGL2RenderingContext;
  private readonly targets = new Map<string, RenderTarget | HistoryRenderTarget | AccumulationRenderTarget>();
  private readonly materialPrograms = new Map<string, CachedMaterialProgram>();
  private readonly buffers = new Map<string, CachedBuffer>();
  private readonly meshVaos = new Map<string, WebGLVertexArrayObject>();
  private readonly emptyTexture: WebGLTexture;
  private readonly textRenderer: TextRenderer;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.emptyTexture = this.createEmptyTexture();
    this.textRenderer = new TextRenderer(gl);
  }

  resetHistory(): void {
    for (const target of this.targets.values()) {
      if (target.kind === "history") target.frames.fill(null);
      if (target.kind === "accumulation") { target.readIndex = 0; target.initialized = false; }
    }
  }

  createTemporalCheckpoint(): TemporalCheckpoint {
    const checkpoint: TemporalCheckpoint = { history: {}, accumulation: {} };
    for (const [id, target] of this.targets) {
      if (target.kind === "history") {
        checkpoint.history[id] = { frames: [...target.frames], slots: target.slots.map((slot) => this.readTargetPixels(slot)) };
      } else if (target.kind === "accumulation") {
        checkpoint.accumulation[id] = { readIndex: target.readIndex, initialized: target.initialized, slots: target.slots.map((slot) => this.readTargetPixels(slot)) };
      }
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return checkpoint;
  }

  restoreTemporalCheckpoint(checkpoint: TemporalCheckpoint): void {
    for (const [id, saved] of Object.entries(checkpoint.history)) {
      const target = this.targets.get(id);
      if (!target || target.kind !== "history") continue;
      target.frames = [...saved.frames];
      target.slots.forEach((slot, index) => this.writeTargetPixels(slot, saved.slots[index]));
    }
    for (const [id, saved] of Object.entries(checkpoint.accumulation)) {
      const target = this.targets.get(id);
      if (!target || target.kind !== "accumulation") continue;
      target.readIndex = saved.readIndex;
      target.initialized = saved.initialized;
      target.slots.forEach((slot, index) => this.writeTargetPixels(slot, saved.slots[index]));
    }
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (this.gl.canvas.width !== pixelWidth || this.gl.canvas.height !== pixelHeight) {
      this.gl.canvas.width = pixelWidth;
      this.gl.canvas.height = pixelHeight;
    }
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
  }

  async execute(graph: RenderGraph, width: number, height: number, frame = 0): Promise<void> {
    const gl = this.gl;
    this.resize(width, height);
    this.ensureTargets(graph, width, height);
    this.ensureBuffers(graph);

    for (const pass of graph.passes) {
      const targetId = pass.writes[0];
      const target = targetId === "screen" ? undefined : this.resolveTarget(targetId, frame);
      if (targetId !== "screen" && !target) throw new Error(`Missing render target: ${targetId}`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
      // The canvas backing store may be DPR-scaled. Offscreen textures use
      // their logical graph dimensions; screen passes use the backing store.
      gl.viewport(0, 0, target?.width ?? gl.canvas.width, target?.height ?? gl.canvas.height);
      this.prepareAccumulation(targetId);
      this.configureDepth(pass, target);
      await this.executePass(pass, target?.width ?? width, target?.height ?? height, graph, frame);
      if (targetId !== "screen") this.markHistoryFrame(targetId, frame);
      if (targetId !== "screen") this.advanceAccumulation(targetId);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  private async executePass(pass: RenderPass, _width: number, _height: number, graph: RenderGraph, frame: number): Promise<void> {
    const gl = this.gl;
    for (const command of pass.commands) {
      if (command.type === "clear") {
        gl.clearColor(...command.color);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else if (command.type === "mesh") {
        if (command.enabled === false) continue;
        this.executeMesh(command, graph, frame);
      } else if (command.type === "text") {
        if (command.enabled === false) continue;
        const layout = graph.resources.get(command.layout);
        if (!layout || layout.kind !== "text-layout") throw new Error(`Missing text layout: ${command.layout}`);
        await this.textRenderer.render(layout, graph, _width, _height, command.blend);
      }
    }
  }

  private configureDepth(pass: RenderPass, target?: RenderTarget): void {
    const gl = this.gl;
    const depth = pass.depth;
    if (!depth?.enabled) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(true);
      return;
    }
    if (target && !target.depthRenderbuffer) throw new Error(`Pass ${pass.id} requires a depth attachment`);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(this.depthFunction(depth.func));
    gl.depthMask(depth.write ?? true);
    gl.clearDepth(depth.clear ?? 1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  private depthFunction(func: DepthFunc | undefined): number {
    const gl = this.gl;
    if (func === "never") return gl.NEVER;
    if (func === "equal") return gl.EQUAL;
    if (func === "lequal") return gl.LEQUAL;
    if (func === "greater") return gl.GREATER;
    if (func === "notequal") return gl.NOTEQUAL;
    if (func === "gequal") return gl.GEQUAL;
    if (func === "always") return gl.ALWAYS;
    return gl.LESS;
  }

  private executeMesh(command: DrawMeshCommand, graph: RenderGraph, frame: number): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const mesh = graph.resources.get(command.mesh);
    if (!mesh || mesh.kind !== "mesh") throw new Error(`Missing mesh: ${command.mesh}`);
    const program = this.getMaterialProgram(command.program, graph);
    const vao = this.getMeshVao(command, graph, program);
    gl.useProgram(program);
    gl.bindVertexArray(vao);

    if (command.color) {
      this.applyUniforms(program, {
        ...(command.uniforms ?? {}),
        u_color: { type: "vec4", value: command.color }
      }, graph, frame);
    } else {
      this.applyUniforms(program, command.uniforms, graph, frame);
    }

    const mode = this.topologyMode(mesh.topology);
    const instanceCount = command.instanceCount ?? 1;
    if (mesh.indexBuffer) {
      const indexResource = graph.resources.get(mesh.indexBuffer);
      if (!indexResource || indexResource.kind !== "buffer" || indexResource.bufferKind !== "index") {
        throw new Error(`Missing mesh index buffer: ${mesh.indexBuffer}`);
      }
      const indexType = indexResource.descriptor.type === "uint32" ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      if (instanceCount > 1) gl.drawElementsInstanced(mode, mesh.indexCount ?? 0, indexType, 0, instanceCount);
      else gl.drawElements(mode, mesh.indexCount ?? 0, indexType, 0);
    } else {
      if (instanceCount > 1) gl.drawArraysInstanced(mode, 0, mesh.vertexCount, instanceCount);
      else gl.drawArrays(mode, 0, mesh.vertexCount);
    }
  }

  private topologyMode(topology: PrimitiveTopology): number {
    if (topology === "triangles") return this.gl.TRIANGLES;
    if (topology === "triangle-strip") return this.gl.TRIANGLE_STRIP;
    return this.gl.LINES;
  }

  private getMeshVao(command: DrawMeshCommand, graph: RenderGraph, program: WebGLProgram): WebGLVertexArrayObject {
    const key = `${command.program}:${JSON.stringify({
      mesh: command.mesh
    })}`;
    const existing = this.meshVaos.get(key);
    if (existing) return existing;

    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error("Failed to create mesh vertex array");
    this.gl.bindVertexArray(vao);
    const material = graph.materials.get(command.program);
    const mesh = graph.resources.get(command.mesh);
    if (!material) throw new Error(`Unknown program: ${command.program}`);
    if (!mesh || mesh.kind !== "mesh") throw new Error(`Unknown mesh: ${command.mesh}`);

    for (const [semantic, bufferId] of Object.entries(mesh.vertexBuffers)) {
      const resource = graph.resources.get(bufferId);
      if (!resource || resource.kind !== "buffer" || resource.bufferKind !== "vertex") {
        throw new Error(`Missing mesh vertex buffer: ${bufferId}`);
      }
      const buffer = this.buffers.get(bufferId);
      if (!buffer) throw new Error(`Vertex buffer is not uploaded: ${bufferId}`);
      const inputName = material.vertexInputs?.[semantic] ?? this.defaultVertexInput(semantic);
      if (!inputName) throw new Error(`Program ${command.program} has no shader input mapping for ${semantic}`);
      const location = this.gl.getAttribLocation(program, inputName);
      if (location < 0) throw new Error(`Program ${command.program} must declare ${inputName} for mesh rendering`);
      const layout = mesh.attributes?.[semantic] ?? this.defaultAttributeLayout(semantic, resource.descriptor.type);
      if (!layout) throw new Error(`Missing vertex layout for semantic: ${semantic}`);
      const type = layout.type ?? resource.descriptor.type;
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer.buffer);
      this.gl.enableVertexAttribArray(location);
      this.gl.vertexAttribPointer(
        location,
        layout.components,
        this.attributeType(type),
        layout.normalized ?? false,
        layout.stride ?? 0,
        layout.offset ?? 0
      );
      this.gl.vertexAttribDivisor(location, layout.divisor ?? 0);
    }

    if (mesh.indexBuffer) {
      const index = this.buffers.get(mesh.indexBuffer);
      if (!index) throw new Error(`Index buffer is not uploaded: ${mesh.indexBuffer}`);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, index.buffer);
    }
    this.gl.bindVertexArray(null);
    this.meshVaos.set(key, vao);
    return vao;
  }

  private defaultVertexInput(semantic: string): string | undefined {
    return {
      position: "a_position",
      normal: "a_normal",
      uv0: "a_uv0",
      color0: "a_color0"
    }[semantic];
  }

  private defaultAttributeLayout(semantic: string, type: BufferDataType): VertexAttributeLayout | undefined {
    const components: Record<string, 1 | 2 | 3 | 4> = {
      position: 3,
      normal: 3,
      uv0: 2,
      color0: 4
    };
    const size = components[semantic];
    return size ? { components: size, type } : undefined;
  }

  private attributeType(type: BufferDataType): number {
    if (type === "float32") return this.gl.FLOAT;
    if (type === "uint8") return this.gl.UNSIGNED_BYTE;
    if (type === "uint16") return this.gl.UNSIGNED_SHORT;
    return this.gl.UNSIGNED_INT;
  }

  private applyUniforms(
    program: WebGLProgram,
    uniforms: UniformBindings | undefined,
    graph: RenderGraph,
    frame: number
  ): void {
    if (!uniforms) return;
    let textureUnit = 0;
    for (const [name, binding] of Object.entries(uniforms)) {
      const location = this.gl.getUniformLocation(program, name);
      if (!location) continue;
      const value = binding.value;
      if (binding.type === "sampler2D") {
        const reference = typeof value === "string" ? { name: value, offset: 0 } : value as unknown as HistoryTextureReference;
        if (!reference || typeof reference.name !== "string") throw new Error(`Sampler uniform ${name} requires a texture resource`);
        const resource = graph.resources.get(reference.name);
        const target = this.resolveSampleTarget(reference.name, reference.offset, frame);
        if (!resource || (resource.kind !== "texture" && resource.kind !== "history" && resource.kind !== "accumulation")) {
          throw new Error(`Sampler uniform ${name} references a missing texture: ${reference.name}`);
        }
        this.gl.activeTexture(this.gl.TEXTURE0 + textureUnit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, target?.texture ?? this.emptyTexture);
        this.gl.uniform1i(location, textureUnit);
        textureUnit += 1;
        continue;
      }
      if (typeof value === "string" || (value && !Array.isArray(value) && typeof value === "object")) throw new Error(`Uniform ${name} cannot use a resource ID`);
      const numericValue = value as number | number[];
      const values = Array.isArray(numericValue) ? numericValue : [numericValue];
      switch (binding.type) {
        case "float": this.gl.uniform1f(location, values[0]); break;
        case "vec2": this.gl.uniform2fv(location, values); break;
        case "vec3": this.gl.uniform3fv(location, values); break;
        case "vec4": this.gl.uniform4fv(location, values); break;
        case "int": this.gl.uniform1i(location, values[0]); break;
        case "ivec2": this.gl.uniform2iv(location, values); break;
        case "ivec3": this.gl.uniform3iv(location, values); break;
        case "ivec4": this.gl.uniform4iv(location, values); break;
        case "mat4": this.gl.uniformMatrix4fv(location, false, values); break;
        default: throw new Error(`Unsupported uniform type: ${binding.type}`);
      }
    }
  }

  private getMaterialProgram(id: string, graph: RenderGraph): WebGLProgram {
    const definition = graph.materials.get(id);
    if (!definition) throw new Error(`Unknown material: ${id}`);
    const existing = this.materialPrograms.get(id);
    const vertexInputsKey = JSON.stringify(definition.vertexInputs ?? {});
    if (
      existing &&
      existing.vertex === definition.vertex &&
      existing.fragment === definition.fragment &&
      existing.vertexInputsKey === vertexInputsKey
    ) {
      return existing.program;
    }
    if (existing) {
      this.gl.deleteProgram(existing.program);
      this.clearMeshVaos();
    }
    const program = this.createProgram(definition.vertex, definition.fragment);
    this.materialPrograms.set(id, {
      program,
      vertex: definition.vertex,
      fragment: definition.fragment,
      vertexInputsKey
    });
    return program;
  }

  private ensureBuffers(graph: RenderGraph): void {
    for (const resource of graph.resources.values()) {
      if (resource.kind !== "buffer") continue;
      const descriptor = resource.descriptor;
      const fingerprint = `${resource.bufferKind}:${descriptor.type}:${descriptor.data.join(",")}`;
      const existing = this.buffers.get(resource.id);
      if (existing?.fingerprint === fingerprint) continue;
      if (existing) {
        this.gl.deleteBuffer(existing.buffer);
        this.clearMeshVaos();
      }
      const buffer = this.gl.createBuffer();
      if (!buffer) throw new Error(`Failed to allocate buffer: ${resource.id}`);
      const target = resource.bufferKind === "index" ? this.gl.ELEMENT_ARRAY_BUFFER : this.gl.ARRAY_BUFFER;
      const data = descriptor.type === "float32"
        ? new Float32Array(descriptor.data)
        : descriptor.type === "uint8"
          ? new Uint8Array(descriptor.data)
        : descriptor.type === "uint32"
          ? new Uint32Array(descriptor.data)
          : new Uint16Array(descriptor.data);
      this.gl.bindBuffer(target, buffer);
      this.gl.bufferData(target, data, this.gl.STATIC_DRAW);
      this.buffers.set(resource.id, { buffer, fingerprint });
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
  }

  private clearMeshVaos(): void {
    for (const vao of this.meshVaos.values()) {
      this.gl.deleteVertexArray(vao);
    }
    this.meshVaos.clear();
  }

  private ensureTargets(graph: RenderGraph, viewportWidth: number, viewportHeight: number): void {
    for (const resource of graph.resources.values()) {
      if ((resource.kind !== "texture" && resource.kind !== "history" && resource.kind !== "accumulation") || !resource.descriptor) continue;
      const width = resource.descriptor.width === "viewport" ? viewportWidth : resource.descriptor.width;
      const height = resource.descriptor.height === "viewport" ? viewportHeight : resource.descriptor.height;
      const samplerFingerprint = JSON.stringify({
        depth: resource.descriptor.depth,
        minFilter: resource.descriptor.minFilter,
        magFilter: resource.descriptor.magFilter,
        wrapS: resource.descriptor.wrapS,
        wrapT: resource.descriptor.wrapT
      });
      const existing = this.targets.get(resource.id);
      if (resource.kind === "history") {
        if (existing && existing.kind === "history" && existing.slots.length === resource.capacity && existing.slots.every((slot) => slot.width === width && slot.height === height && slot.samplerFingerprint === samplerFingerprint)) continue;
        if (existing) this.deleteTarget(existing);
        const slots = Array.from({ length: resource.capacity }, () => this.createRenderTarget(resource.descriptor, width, height, samplerFingerprint));
        this.targets.set(resource.id, { kind: "history", slots, capacity: resource.capacity, frames: Array(resource.capacity).fill(null) });
        continue;
      }
      if (resource.kind === "accumulation") {
        if (existing && existing.kind === "accumulation" && existing.slots.every((slot) => slot.width === width && slot.height === height && slot.samplerFingerprint === samplerFingerprint)) continue;
        if (existing) this.deleteTarget(existing);
        this.targets.set(resource.id, {
          kind: "accumulation",
          slots: [
            this.createRenderTarget(resource.descriptor, width, height, samplerFingerprint),
            this.createRenderTarget(resource.descriptor, width, height, samplerFingerprint)
          ],
          readIndex: 0,
          initialized: false
        });
        continue;
      }
      if (existing && existing.kind === "target" && existing.width === width && existing.height === height && existing.samplerFingerprint === samplerFingerprint) continue;
      if (existing) this.deleteTarget(existing);
      this.targets.set(resource.id, this.createRenderTarget(resource.descriptor, width, height, samplerFingerprint));
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, null);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  private createRenderTarget(descriptor: TextureDescriptor, width: number, height: number, samplerFingerprint: string): RenderTarget {
    const texture = this.gl.createTexture();
    const framebuffer = this.gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Failed to allocate render target");
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.filterMode(descriptor.minFilter));
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.filterMode(descriptor.magFilter));
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.wrapMode(descriptor.wrapS));
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.wrapMode(descriptor.wrapT));
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, width, height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, texture, 0);
    let depthRenderbuffer: WebGLRenderbuffer | undefined;
    if (descriptor.depth) {
      depthRenderbuffer = this.gl.createRenderbuffer() ?? undefined;
      if (!depthRenderbuffer) throw new Error("Failed to allocate depth attachment");
      this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, depthRenderbuffer);
      this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT16, width, height);
      this.gl.framebufferRenderbuffer(this.gl.FRAMEBUFFER, this.gl.DEPTH_ATTACHMENT, this.gl.RENDERBUFFER, depthRenderbuffer);
    }
    if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) !== this.gl.FRAMEBUFFER_COMPLETE) throw new Error("Framebuffer is incomplete");
    return { kind: "target", texture, framebuffer, width, height, samplerFingerprint, depthRenderbuffer };
  }

  private resolveTarget(id: string, frame: number): RenderTarget | undefined {
    const target = this.targets.get(id);
    if (!target) return undefined;
    if (target.kind === "target") return target;
    if (target.kind === "accumulation") return target.slots[1 - target.readIndex];
    return target.slots[this.mod(frame, target.capacity)];
  }

  private resolveSampleTarget(id: string, offset: number, frame: number): RenderTarget | undefined {
    const target = this.targets.get(id);
    if (!target) return undefined;
    if (target.kind === "target") return offset === 0 ? target : undefined;
    if (target.kind === "accumulation") return target.initialized ? target.slots[target.readIndex] : undefined;
    const slot = this.mod(frame - offset, target.capacity);
    return target.frames[slot] === frame - offset ? target.slots[slot] : undefined;
  }

  private markHistoryFrame(id: string, frame: number): void {
    const target = this.targets.get(id);
    if (target?.kind === "history") target.frames[this.mod(frame, target.capacity)] = frame;
  }

  private prepareAccumulation(id: string): void {
    const target = this.targets.get(id);
    if (target?.kind === "accumulation" && !target.initialized) {
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }

  private advanceAccumulation(id: string): void {
    const target = this.targets.get(id);
    if (target?.kind === "accumulation") {
      target.readIndex = target.readIndex === 0 ? 1 : 0;
      target.initialized = true;
    }
  }

  private mod(value: number, divisor: number): number {
    return ((value % divisor) + divisor) % divisor;
  }

  private deleteTarget(target: RenderTarget | HistoryRenderTarget | AccumulationRenderTarget): void {
    const targets = target.kind === "history" || target.kind === "accumulation" ? target.slots : [target];
    for (const slot of targets) {
      this.gl.deleteFramebuffer(slot.framebuffer);
      this.gl.deleteTexture(slot.texture);
      if (slot.depthRenderbuffer) this.gl.deleteRenderbuffer(slot.depthRenderbuffer);
    }
  }

  private createEmptyTexture(): WebGLTexture {
    const texture = this.gl.createTexture();
    if (!texture) throw new Error("Failed to create empty history texture");
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    return texture;
  }

  private readTargetPixels(target: RenderTarget): Uint8Array {
    const pixels = new Uint8Array(target.width * target.height * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.readPixels(0, 0, target.width, target.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  private writeTargetPixels(target: RenderTarget, pixels: Uint8Array | undefined): void {
    if (!pixels) return;
    this.gl.bindTexture(this.gl.TEXTURE_2D, target.texture);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, target.width, target.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
  }

  private filterMode(filter: "nearest" | "linear" | undefined): number {
    return filter === "nearest" ? this.gl.NEAREST : this.gl.LINEAR;
  }

  private wrapMode(wrap: "clamp-to-edge" | "repeat" | "mirrored-repeat" | undefined): number {
    if (wrap === "repeat") return this.gl.REPEAT;
    if (wrap === "mirrored-repeat") return this.gl.MIRRORED_REPEAT;
    return this.gl.CLAMP_TO_EDGE;
  }

  private createProgram(vertex: string, fragment: string): WebGLProgram {
    const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertex);
    const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragment);
    const program = this.gl.createProgram();
    if (!program) throw new Error("Failed to create shader program");
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      throw new Error(this.gl.getProgramInfoLog(program) || "Program linking failed");
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error("Failed to create shader");
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      throw new Error(this.gl.getShaderInfoLog(shader) || "Shader compilation failed");
    }
    return shader;
  }
}

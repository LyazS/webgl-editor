import type {
  ClearCommand,
  RenderGraph,
  RenderPass,
  ResourceId,
  MaterialDefinition,
  MaterialId,
  BufferDataType,
  DrawMeshCommand,
  DrawTextCommand,
  DrawVectorCommand,
  VertexAttributeLayout,
  RenderResource,
  MeshResource,
  HistoryTextureResource,
  AccumulationTextureResource,
  HistoryTextureReference,
  TextureDescriptor,
  UniformBinding,
  UniformBindings,
  DepthState
} from "./types";

export class RenderPassBuilder {
  readonly pass: RenderPass;

  constructor(id: string, depth?: DepthState) {
    this.pass = { id, reads: [], writes: [], commands: [], depth };
  }

  read(resource: ResourceId): this {
    this.pass.reads.push(resource);
    return this;
  }

  write(resource: ResourceId): this {
    this.pass.writes.push(resource);
    return this;
  }

  setDepth(state?: DepthState): this {
    this.pass.depth = state;
    return this;
  }

  clear(color: [number, number, number, number]): this {
    const command: ClearCommand = { type: "clear", color };
    this.pass.commands.push(command);
    return this;
  }

  drawMesh(options: Omit<DrawMeshCommand, "type">): DrawMeshCommand {
    this.readUniformResources(options.uniforms);
    const command: DrawMeshCommand = { type: "mesh", ...options };
    this.pass.commands.push(command);
    return command;
  }

  drawText(options: Omit<DrawTextCommand, "type">): DrawTextCommand {
    const command: DrawTextCommand = { type: "text", ...options };
    this.pass.commands.push(command);
    return command;
  }

  drawVector(options: Omit<DrawVectorCommand, "type">): DrawVectorCommand {
    const command: DrawVectorCommand = { type: "vector", ...options };
    this.pass.commands.push(command); return command;
  }

  private readUniformResources(uniforms?: UniformBindings): void {
    for (const binding of Object.values(uniforms ?? {})) {
      if (binding.type === "sampler2D" && typeof binding.value === "string") {
        if (!this.pass.reads.includes(binding.value)) this.pass.reads.push(binding.value);
      } else if (binding.type === "sampler2D" && this.isHistoryReference(binding.value)) {
        if (!this.pass.reads.includes(binding.value.name)) this.pass.reads.push(binding.value.name);
      }
    }
  }

  private isHistoryReference(value: unknown): value is HistoryTextureReference {
    return !!value && typeof value === "object" && typeof (value as HistoryTextureReference).name === "string" && typeof (value as HistoryTextureReference).offset === "number";
  }
}

export class RenderGraphBuilder {
  private readonly resources = new Map<ResourceId, RenderResource>();
  private readonly materials = new Map<MaterialId, MaterialDefinition>();
  private readonly passes: RenderPass[] = [];

  texture(id: ResourceId, descriptor: TextureDescriptor): ResourceId {
    if (this.resources.has(id)) {
      throw new Error(`Resource already exists: ${id}`);
    }
    this.resources.set(id, { id, kind: "texture", descriptor });
    return id;
  }

  historyTarget(id: ResourceId, descriptor: TextureDescriptor & { capacity: number }): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    if (!Number.isInteger(descriptor.capacity) || descriptor.capacity < 2) throw new Error(`History target ${id} capacity must be at least 2`);
    this.resources.set(id, { id, kind: "history", descriptor, capacity: descriptor.capacity } satisfies HistoryTextureResource);
    return id;
  }

  accumulationTarget(id: ResourceId, descriptor: TextureDescriptor): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    this.resources.set(id, { id, kind: "accumulation", descriptor } satisfies AccumulationTextureResource);
    return id;
  }

  vertexBuffer(id: ResourceId, descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }): ResourceId {
    return this.buffer(id, "vertex", descriptor);
  }

  createVertexBuffer(descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }): ResourceId {
    return this.vertexBuffer(this.nextId("vertexBuffer"), descriptor);
  }

  indexBuffer(id: ResourceId, descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }): ResourceId {
    return this.buffer(id, "index", descriptor);
  }

  createIndexBuffer(descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }): ResourceId {
    return this.indexBuffer(this.nextId("indexBuffer"), descriptor);
  }

  private buffer(
    id: ResourceId,
    bufferKind: "vertex" | "index",
    descriptor: { data: number[]; type?: BufferDataType; usage?: "static" | "dynamic" }
  ): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    const type = descriptor?.type ?? (bufferKind === "vertex" ? "float32" : "uint16");
    if (bufferKind === "index" && type === "float32") {
      throw new Error(`Index buffer ${id} must use uint16 or uint32 data`);
    }
    if (bufferKind === "index" && type === "uint8") {
      throw new Error(`Index buffer ${id} must use uint16 or uint32 data`);
    }
    if (!Array.isArray(descriptor?.data) || descriptor.data.length === 0) {
      throw new Error(`Buffer ${id} must contain data`);
    }
    if (!descriptor.data.every((value) => Number.isFinite(value))) {
      throw new Error(`Buffer ${id} contains a non-finite value`);
    }
    if (bufferKind === "index" && !descriptor.data.every((value) => Number.isInteger(value) && value >= 0)) {
      throw new Error(`Index buffer ${id} must contain non-negative integers`);
    }
    if (type === "uint16" && descriptor.data.some((value) => value > 65535)) {
      throw new Error(`Index buffer ${id} contains a value outside uint16 range`);
    }
    if (type === "uint32" && descriptor.data.some((value) => value > 4294967295)) {
      throw new Error(`Index buffer ${id} contains a value outside uint32 range`);
    }
    this.resources.set(id, {
      id,
      kind: "buffer",
      bufferKind,
      descriptor: { data: [...descriptor.data], type, usage: descriptor.usage ?? "static" }
    });
    return id;
  }

  updateBuffer(id: ResourceId, data: number[], offset = 0): void {
    const resource = this.resources.get(id);
    if (!resource || resource.kind !== "buffer") throw new Error(`Unknown buffer: ${id}`);
    if (resource.descriptor.usage !== "dynamic") throw new Error(`Buffer ${id} is not dynamic`);
    if (!data.every((value) => Number.isFinite(value))) throw new Error(`Buffer ${id} contains a non-finite value`);
    if (offset < 0 || offset + data.length > resource.descriptor.data.length) {
      throw new Error(`Buffer ${id} update is outside its declared size`);
    }
    resource.descriptor.data.splice(offset, data.length, ...data);
  }

  mesh(id: ResourceId, descriptor: Omit<MeshResource, "id" | "kind">): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    this.resources.set(id, { id, kind: "mesh", ...descriptor });
    return id;
  }

  createMesh(descriptor: Omit<MeshResource, "id" | "kind">): ResourceId {
    return this.mesh(this.nextId("mesh"), descriptor);
  }

  private idCounter = 0;
  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `__${prefix}_${this.idCounter}`;
  }

  screen(): ResourceId {
    this.resources.set("screen", { id: "screen", kind: "screen" });
    return "screen";
  }

  material(id: MaterialId, definition: MaterialDefinition): MaterialId {
    const existing = this.materials.get(id);
    if (existing && (
      existing.vertex !== definition.vertex ||
      existing.fragment !== definition.fragment ||
      JSON.stringify(existing.vertexInputs ?? {}) !== JSON.stringify(definition.vertexInputs ?? {})
    )) {
      throw new Error(`Material already exists with different source: ${id}`);
    }
    this.materials.set(id, definition);
    return id;
  }

  font(id: ResourceId, definition: import("./types").FontDefinition): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    if (!definition.family.trim()) throw new Error(`Font ${id} requires a font name`);
    const { pageSize = 2048, padding = 2 } = definition.atlas ?? {};
    if (!Number.isInteger(pageSize) || pageSize < 32) throw new Error(`Font ${id} atlas pageSize must be an integer >= 32`);
    if (!Number.isInteger(padding) || padding < 1 || padding * 2 >= pageSize) throw new Error(`Font ${id} atlas padding must be positive and fit the page`);
    this.resources.set(id, { id, kind: "font", ...definition });
    return id;
  }

  updateFontData(id: ResourceId, data: Uint8Array): void {
    const font = this.resources.get(id);
    if (!font || font.kind !== "font") throw new Error(`Unknown font: ${id}`);
    if (data.length < 12 || ![0x00010000, 0x4f54544f].includes(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0))) throw new Error(`Font ${id} requires standalone TTF/OTF binary data`);
    font.data = data;
  }

  textLayout(id: ResourceId, definition: { font: ResourceId; text: string; style: import("./types").TextStyle; position: [number, number] }): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    if (!this.resources.has(definition.font)) throw new Error(`Unknown font: ${definition.font}`);
    this.resources.set(id, { id, kind: "text-layout", ...definition });
    return id;
  }

  updateTextLayout(id: ResourceId, patch: { text?: string; style?: Partial<import("./types").TextStyle>; position?: [number, number] }): void {
    const resource = this.resources.get(id);
    if (!resource || resource.kind !== "text-layout") throw new Error(`Unknown text layout: ${id}`);
    if (patch.text !== undefined) resource.text = patch.text;
    if (patch.position !== undefined) resource.position = patch.position;
    if (patch.style !== undefined) resource.style = { ...resource.style, ...patch.style };
  }

  vector(id: ResourceId, document: import("../svg/document").SvgDocument): ResourceId {
    if (this.resources.has(id)) throw new Error(`Resource already exists: ${id}`);
    this.resources.set(id, { id, kind: "vector", document }); return id;
  }

  program(id: MaterialId, definition: MaterialDefinition): MaterialId {
    return this.material(id, definition);
  }

  pass(id: string, build: (pass: RenderPassBuilder) => void, depth?: DepthState): this {
    const builder = new RenderPassBuilder(id, depth);
    build(builder);
    this.addPass(builder.pass);
    return this;
  }

  addPass(pass: RenderPass): this {
    if (this.passes.some((item) => item.id === pass.id)) {
      throw new Error(`Pass already exists: ${pass.id}`);
    }
    this.passes.push(pass);
    return this;
  }

  compile(output: ResourceId = "screen"): RenderGraph {
    if (!this.resources.has(output)) {
      throw new Error(`Graph output does not exist: ${output}`);
    }
    if (!this.passes.some((pass) => pass.writes.includes(output))) {
      throw new Error(`Graph output has no producer: ${output}`);
    }
    for (const pass of this.passes) {
      if (pass.writes.length !== 1) throw new Error(`Pass ${pass.id} must write exactly one target`);
      this.validateDepthState(pass);
      for (const resource of [...pass.reads, ...pass.writes]) {
        if (!this.resources.has(resource)) throw new Error(`Unknown resource: ${resource}`);
      }
      for (const command of pass.commands) {
        if (command.type === "mesh") this.validateMeshCommand(pass.id, command);
        if (command.type === "mesh") this.validateUniforms(pass.id, command.uniforms);
        if (command.type === "text") this.validateTextCommand(pass.id, command);
        if (command.type === "vector") {
          const resource = this.resources.get(command.document);
          if (!resource || resource.kind !== "vector") throw new Error(`Invalid vector resource: ${command.document}`);
          if (command.transform.length !== 6 || !command.transform.every(Number.isFinite)) throw new Error("Vector transform requires six finite numbers");
          if (!Number.isFinite(command.opacity) || command.opacity < 0 || command.opacity > 1) throw new Error("Vector opacity must be between 0 and 1");
          for (const value of [command.width, command.height]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error("Vector viewport must be positive");
        }
      }
    }

    const orderedPasses = this.topologicalOrder();
    return {
      resources: new Map(this.resources),
      materials: new Map(this.materials),
      passes: orderedPasses,
      output
    };
  }

  private validateTextCommand(passId: string, command: DrawTextCommand): void {
    const layout = this.resources.get(command.layout);
    if (!layout || layout.kind !== "text-layout") throw new Error(`Pass ${passId} references an invalid text layout: ${command.layout}`);
    const font = this.resources.get(layout.font);
    if (!font || font.kind !== "font") throw new Error(`Pass ${passId} references an invalid font: ${layout.font}`);
    if (!font.data) throw new Error(`Font ${font.id} has no loaded TTF/OTF data`);
    if (!Number.isFinite(layout.style.size) || layout.style.size <= 0) throw new Error(`Text layout ${layout.id} size must be positive`);
    if (layout.style.maxWidth !== undefined && (!Number.isFinite(layout.style.maxWidth) || layout.style.maxWidth <= 0)) throw new Error(`Text layout ${layout.id} maxWidth must be positive`);
    if (layout.style.lineHeight !== undefined && (!Number.isFinite(layout.style.lineHeight) || layout.style.lineHeight <= 0)) throw new Error(`Text layout ${layout.id} lineHeight must be positive`);
    if (layout.style.letterSpacing !== undefined && !Number.isFinite(layout.style.letterSpacing)) throw new Error(`Text layout ${layout.id} letterSpacing must be finite`);
  }

  private validateDepthState(pass: RenderPass): void {
    if (!pass.depth?.enabled) return;
    const target = this.resources.get(pass.writes[0]);
    if (!target || (target.kind !== "screen" && (target.kind !== "texture" && target.kind !== "history" && target.kind !== "accumulation" || !target.descriptor?.depth))) {
      throw new Error(`Pass ${pass.id} enables depth testing but its target has no depth attachment`);
    }
    if (pass.depth.clear !== undefined && (!Number.isFinite(pass.depth.clear) || pass.depth.clear < 0 || pass.depth.clear > 1)) {
      throw new Error(`Pass ${pass.id} depth clear must be between 0 and 1`);
    }
  }

  private validateMeshCommand(passId: string, command: DrawMeshCommand): void {
    const mesh = this.resources.get(command.mesh);
    if (!mesh || mesh.kind !== "mesh") throw new Error(`Pass ${passId} references an invalid mesh: ${command.mesh}`);
    const vertexBindings = Object.entries(mesh.vertexBuffers ?? {});
    if (vertexBindings.length === 0) throw new Error(`Mesh ${command.mesh} must provide at least one vertex buffer`);
    for (const [semantic, bufferId] of vertexBindings) {
      const vertexBuffer = this.resources.get(bufferId);
      if (!vertexBuffer || vertexBuffer.kind !== "buffer" || vertexBuffer.bufferKind !== "vertex") {
        throw new Error(`Pass ${passId} references an invalid ${semantic} vertex buffer: ${bufferId}`);
      }
      const layout = mesh.attributes?.[semantic] ?? this.defaultAttributeLayout(semantic, vertexBuffer.descriptor.type);
      if (!layout) {
        throw new Error(`Mesh ${command.mesh} needs an attribute layout for semantic: ${semantic}`);
      }
      if (!Number.isInteger(layout.components) || layout.components < 1 || layout.components > 4) {
        throw new Error(`Pass ${passId} attribute ${semantic} components must be between 1 and 4`);
      }
      if (layout.type && layout.type !== vertexBuffer.descriptor.type) {
        throw new Error(`Pass ${passId} attribute ${semantic} type does not match buffer ${bufferId}`);
      }
      if (layout.stride !== undefined && (!Number.isInteger(layout.stride) || layout.stride < 0)) {
        throw new Error(`Pass ${passId} attribute ${semantic} stride must be a non-negative integer`);
      }
      if (layout.offset !== undefined && (!Number.isInteger(layout.offset) || layout.offset < 0)) {
        throw new Error(`Pass ${passId} attribute ${semantic} offset must be a non-negative integer`);
      }
      if (layout.divisor !== undefined && (!Number.isInteger(layout.divisor) || layout.divisor < 0)) {
        throw new Error(`Pass ${passId} attribute ${semantic} divisor must be a non-negative integer`);
      }
    }
    if (!this.materials.has(command.program)) {
      throw new Error(`Pass ${passId} references an unknown program: ${command.program}`);
    }
    if (!Number.isInteger(mesh.vertexCount) || mesh.vertexCount <= 0) {
      throw new Error(`Mesh ${command.mesh} vertexCount must be a positive integer`);
    }
    if (command.instanceCount !== undefined && (!Number.isInteger(command.instanceCount) || command.instanceCount <= 0)) {
      throw new Error(`Pass ${passId} instanceCount must be a positive integer`);
    }
    if (mesh.indexBuffer) {
      const indexBuffer = this.resources.get(mesh.indexBuffer);
      if (!indexBuffer || indexBuffer.kind !== "buffer" || indexBuffer.bufferKind !== "index") {
        throw new Error(`Mesh ${command.mesh} references an invalid index buffer: ${mesh.indexBuffer}`);
      }
      if (!Number.isInteger(mesh.indexCount) || (mesh.indexCount ?? 0) <= 0) {
        throw new Error(`Mesh ${command.mesh} indexCount must be a positive integer`);
      }
    }
  }

  private validateUniforms(passId: string, uniforms?: UniformBindings): void {
    for (const [name, binding] of Object.entries(uniforms ?? {})) {
      if (!binding || typeof binding.type !== "string") {
        throw new Error(`Pass ${passId} uniform ${name} is invalid`);
      }
      const expectedLength: Record<string, number | undefined> = {
        float: 1,
        vec2: 2,
        vec3: 3,
        vec4: 4,
        int: 1,
        ivec2: 2,
        ivec3: 3,
        ivec4: 4,
        mat4: 16
      };
      if (binding.type === "sampler2D") {
        const reference = typeof binding.value === "string" ? { name: binding.value, offset: 0 } : binding.value;
        if (!this.isHistoryReference(reference)) throw new Error(`Pass ${passId} sampler uniform ${name} must reference a texture resource`);
        const resource = this.resources.get(reference.name);
        if (!resource || (resource.kind !== "texture" && resource.kind !== "history" && resource.kind !== "accumulation")) {
          throw new Error(`Pass ${passId} sampler uniform ${name} references an invalid texture: ${reference.name}`);
        }
        if (resource.kind === "history" && (!Number.isInteger(reference.offset) || reference.offset < 1 || reference.offset >= resource.capacity)) {
          throw new Error(`Pass ${passId} sampler uniform ${name} history offset must be between 1 and ${resource.capacity - 1}`);
        }
        if (resource.kind === "accumulation" && (!Number.isInteger(reference.offset) || reference.offset < 0 || reference.offset > 1)) {
          throw new Error(`Pass ${passId} accumulation offset must be 0 or 1`);
        }
        continue;
      }
      if (typeof binding.value === "string" || this.isHistoryReference(binding.value)) {
        throw new Error(`Pass ${passId} uniform ${name} cannot use a resource ID`);
      }
      const values = Array.isArray(binding.value) ? binding.value : [binding.value];
      const length = expectedLength[binding.type];
      if (!length || values.length !== length || !values.every((value) => Number.isFinite(value))) {
        throw new Error(`Pass ${passId} uniform ${name} has an invalid ${binding.type} value`);
      }
    }
  }

  private isHistoryReference(value: unknown): value is HistoryTextureReference {
    return !!value && typeof value === "object" && typeof (value as HistoryTextureReference).name === "string" && typeof (value as HistoryTextureReference).offset === "number";
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

  private topologicalOrder(): RenderPass[] {
    const producers = new Map<ResourceId, string>();
    for (const pass of this.passes) {
      for (const resource of pass.writes) {
        if (producers.has(resource)) {
          throw new Error(`Multiple producers for resource: ${resource}`);
        }
        producers.set(resource, pass.id);
      }
    }

    const byId = new Map(this.passes.map((pass) => [pass.id, pass]));
    const dependencies = new Map<string, Set<string>>();
    for (const pass of this.passes) {
      const deps = new Set<string>();
      for (const input of pass.reads) {
        const producer = producers.get(input);
        if (producer && producer !== pass.id) deps.add(producer);
      }
      dependencies.set(pass.id, deps);
    }

    const result: RenderPass[] = [];
    const remaining = new Set(this.passes.map((pass) => pass.id));
    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => {
        const deps = dependencies.get(id) ?? new Set<string>();
        return [...deps].every((dependency) => !remaining.has(dependency));
      });

      if (ready.length === 0) {
        throw new Error("Render graph contains a dependency cycle");
      }

      for (const id of ready) {
        remaining.delete(id);
        const pass = byId.get(id);
        if (pass) result.push(pass);
      }
    }
    return result;
  }
}

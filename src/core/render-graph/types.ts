export type ResourceId = string;
export type MaterialId = string;

export type TextureFormat = "rgba8";
export type BufferDataType = "float32" | "uint8" | "uint16" | "uint32";
export type PrimitiveTopology = "triangles" | "triangle-strip" | "lines";
export type VertexSemantic = "position" | "normal" | "uv0" | "color0" | string;
export type UniformType = "float" | "vec2" | "vec3" | "vec4" | "int" | "ivec2" | "ivec3" | "ivec4" | "mat4" | "sampler2D";
export type DepthFunc = "never" | "less" | "equal" | "lequal" | "greater" | "notequal" | "gequal" | "always";

export interface TextureDescriptor {
  width: number | "viewport";
  height: number | "viewport";
  format: TextureFormat;
  persistent?: boolean;
  depth?: boolean;
  minFilter?: "nearest" | "linear";
  magFilter?: "nearest" | "linear";
  wrapS?: "clamp-to-edge" | "repeat" | "mirrored-repeat";
  wrapT?: "clamp-to-edge" | "repeat" | "mirrored-repeat";
}

export interface TextureResource {
  id: ResourceId;
  kind: "texture";
  descriptor?: TextureDescriptor;
}

export interface HistoryTextureResource {
  id: ResourceId;
  kind: "history";
  descriptor: TextureDescriptor;
  capacity: number;
}

export interface AccumulationTextureResource {
  id: ResourceId;
  kind: "accumulation";
  descriptor: TextureDescriptor;
}

export interface ScreenResource {
  id: ResourceId;
  kind: "screen";
}

export interface BufferDescriptor {
  data: number[];
  type: BufferDataType;
  usage: "static" | "dynamic";
}

export interface BufferResource {
  id: ResourceId;
  kind: "buffer";
  bufferKind: "vertex" | "index";
  descriptor: BufferDescriptor;
}

export interface MeshResource {
  id: ResourceId;
  kind: "mesh";
  vertexBuffers: Record<VertexSemantic, ResourceId>;
  indexBuffer?: ResourceId;
  topology: PrimitiveTopology;
  vertexCount: number;
  indexCount?: number;
  attributes?: Record<string, VertexAttributeLayout>;
}

export type RenderResource = TextureResource | HistoryTextureResource | AccumulationTextureResource | ScreenResource | BufferResource | MeshResource;

export interface MaterialDefinition {
  vertex: string;
  fragment: string;
  vertexInputs?: Record<string, string>;
}

export interface RenderContext {
  FPS: 30;
  totalFrames: number;
  frame: number;
}

export interface ClearCommand {
  type: "clear";
  color: [number, number, number, number];
}

export interface DrawMeshCommand {
  type: "mesh";
  mesh: ResourceId;
  program: MaterialId;
  uniforms?: UniformBindings;
  color?: [number, number, number, number];
  enabled?: boolean;
  instanceCount?: number;
}

export interface UniformBinding {
  type: UniformType;
  value: number | number[] | ResourceId | HistoryTextureReference;
}

export interface HistoryTextureReference {
  name: ResourceId;
  offset: number;
}

export type UniformBindings = Record<string, UniformBinding>;

export interface VertexAttributeLayout {
  components: 1 | 2 | 3 | 4;
  type?: BufferDataType;
  normalized?: boolean;
  stride?: number;
  offset?: number;
  divisor?: number;
}

export type RenderCommand = ClearCommand | DrawMeshCommand;

export interface RenderPass {
  id: string;
  reads: ResourceId[];
  writes: ResourceId[];
  commands: RenderCommand[];
  depth?: DepthState;
}

export interface DepthState {
  enabled?: boolean;
  write?: boolean;
  func?: DepthFunc;
  clear?: number;
}

export interface RenderGraph {
  resources: Map<ResourceId, RenderResource>;
  materials: Map<MaterialId, MaterialDefinition>;
  passes: RenderPass[];
  output: ResourceId;
}

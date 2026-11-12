import { decodeSvgFont } from "../svg/font";
const defaultFontUrl = `${import.meta.env.BASE_URL}fonts/NotoSansSC-Regular.otf`;
import { SvgDocument } from "../svg/document";
import { identity, type Matrix } from "../vector/math";
import { parsePath } from "../vector/path";
import luaWasmUrl from "wasmoon/dist/glue.wasm?url";
import { LuaFactory, LuaLibraries, type LuaEngine } from "wasmoon";
import { RenderGraphBuilder, RenderPassBuilder } from "../render-graph/graph";
import type { BufferDataType, FontDefinition, MaterialDefinition, RenderGraph, TextStyle, UniformBindings, UniformType, VertexAttributeLayout } from "../render-graph/types";

export interface FrameContext { FPS: 30; totalFrames: number; frame: number; width: number; height: number; pixelRatio: number; }
type LuaState = Record<string, unknown>;
type BufferDeclaration = { bufferKind: "vertex" | "index"; data: number[]; type: BufferDataType; usage: "static" | "dynamic" };
type TextureDeclaration = { width: number | "viewport"; height: number | "viewport"; format: "rgba8"; persistent?: boolean; depth?: boolean; capacity?: number; minFilter?: "nearest" | "linear"; magFilter?: "nearest" | "linear"; wrapS?: "clamp-to-edge" | "repeat" | "mirrored-repeat"; wrapT?: "clamp-to-edge" | "repeat" | "mirrored-repeat" };

export class LuaRenderRuntime {
  private readonly factory = new LuaFactory(luaWasmUrl);
  private engine?: LuaEngine;
  private source?: string;
  private state: LuaState = {};
  private builder?: RenderGraphBuilder;
  private readonly declaredTextures = new Map<string, TextureDeclaration>();
  private readonly declaredBuffers = new Map<string, BufferDeclaration>();
  private readonly declaredMeshes = new Map<string, { vertexBuffers: Record<string, string>; indexBuffer?: string; topology: "triangles" | "triangle-strip" | "lines"; vertexCount: number; indexCount?: number; attributes?: Record<string, VertexAttributeLayout> }>();
  private readonly declaredPrograms = new Map<string, MaterialDefinition>();
  private readonly declaredFonts = new Map<string, FontDefinition>();
  private resourceCounter = 0;
  private readonly vectorDocuments = new Map<string, { document: SvgDocument; font?: string; fonts?: Record<string,string> }>();
  private readonly loadedFontData = new Map<string, Uint8Array>();
  private creatingResources = false;
  private readonly fontFiles = new Map<string, Promise<Uint8Array>>();

  async compile(source: string, files: Record<string, string | Uint8Array>): Promise<void> {
    this.vectorDocuments.clear(); this.loadedFontData.clear(); this.creatingResources = true;
    this.shaderFiles = files; this.declaredTextures.clear(); this.declaredBuffers.clear(); this.declaredMeshes.clear(); this.declaredPrograms.clear(); this.declaredFonts.clear(); this.resourceCounter = 0;
    const engine = await this.factory.createEngine({ openStandardLibs: false, injectObjects: false, functionTimeout: 200 });
    const builder = new RenderGraphBuilder(); builder.screen();
    this.builder = builder;
    for (const library of [LuaLibraries.Base, LuaLibraries.Table, LuaLibraries.String, LuaLibraries.Math]) engine.global.loadLibrary(library);
    engine.global.set("__render_graph_sdk", () => this.createSdk());
    engine.global.set("__lua_file", (path: string) => {
      const content = files[path];
      return typeof content === "string" ? content : undefined;
    });
    engine.global.set("__shader_file", (path: string) => { const content = files[path]; if (content === undefined) throw new Error(`Shader file not found: ${path}`); return content; });
    try {
      await engine.doString(`
        local moduleCache = {}
        local loadingModules = {}

        local function modulePath(name)
          if type(name) ~= "string" or name == "" then
            error("module name must be a non-empty string", 3)
          end
          local path = name:gsub("\\\\", "/")
          if not path:find("/", 1, true) and not path:match("%.lua$") then path = path:gsub("%.", "/") end
          if path:sub(-4) ~= ".lua" then path = path .. ".lua" end
          if path:sub(1, 1) == "/" then error("module path must stay inside the project: " .. name, 3) end
          for segment in path:gmatch("[^/]+") do
            if segment == "." or segment == ".." then error("module path must stay inside the project: " .. name, 3) end
          end
          return path
        end

        function require(name)
          if name == "render_graph" then
            if moduleCache[name] == nil then moduleCache[name] = __render_graph_sdk() end
            return moduleCache[name]
          end
          local path = modulePath(name)
          if moduleCache[path] ~= nil then return moduleCache[path] end
          if loadingModules[path] then error("cyclic Lua module dependency: " .. path, 2) end
          local source = __lua_file(path)
          if source == nil then error("Lua module not found: " .. path, 2) end
          local chunk, loadError = load(source, "@" .. path, "t", _ENV)
          if not chunk then error(loadError, 2) end
          loadingModules[path] = true
          local result = chunk()
          loadingModules[path] = nil
          if result == nil then result = true end
          moduleCache[path] = result
          return result
        end
      `);
      await engine.doString(source);
      const setup = engine.global.get("setup"); const render = engine.global.get("render");
      if (typeof setup !== "function") throw new Error("The script must define setup()");
      if (typeof render !== "function") throw new Error("The script must define render(ctx, state)");
      const previousEngine = this.engine;
      this.engine = engine; this.builder = builder;
      const state = await setup(); this.state = state && typeof state === "object" ? state as LuaState : {};
      this.creatingResources = false;
      await this.loadDeclaredFonts();
      for (const { document, font, fonts } of this.vectorDocuments.values()) if (font) {
        const bytes = this.loadedFontData.get(font); if (!bytes) throw new Error(`SVG font not found: ${font}`); document.setFont(bytes);
        if(fonts){const faces:Record<string,Uint8Array>={};for(const [family,id] of Object.entries(fonts)){const data=this.loadedFontData.get(id);if(!data)throw new Error(`SVG font face not found: ${id}`);faces[family]=data;}document.setFontFaces(faces);}
      }
      this.source = source; builder.compile("screen"); previousEngine?.global.close();
    } catch (error) { engine.global.close(); this.engine = undefined; this.builder = undefined; throw this.normalizeError(error); }
  }

  async buildGraph(frame: number, width: number, height: number, totalFrames: number, pixelRatio = 1): Promise<RenderGraph> {
    if (!this.engine || !this.source || !this.builder) throw new Error("Lua runtime has not been compiled");
    try { await this.engine.global.get("render")({ FPS: 30, totalFrames, frame, width, height, pixelRatio }, this.state); return this.builder.compile("screen"); }
    catch (error) { throw this.normalizeError(error); }
  }

  async recompile(): Promise<void> {
    if (!this.source) throw new Error("Lua runtime has not been compiled");
    await this.compile(this.source, this.shaderFiles);
  }

  snapshotState(): unknown {
    return { kind:"render-graph-runtime-checkpoint-v1", state:this.cloneValue(this.state), vectors:Object.fromEntries([...this.vectorDocuments].map(([id,{document}])=>[id,document.snapshot()])) };
  }

  restoreState(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") throw new Error("Checkpoint state must be a table");
    const saved=snapshot as {kind?:string;state?:unknown;vectors?:Record<string,import("../svg/document").SvgSnapshot>};
    if(saved.kind==="render-graph-runtime-checkpoint-v1"){
      this.state=this.cloneValue(saved.state) as LuaState;
      for(const [id,value]of Object.entries(saved.vectors??{})){const resource=this.vectorDocuments.get(id);if(!resource)throw new Error(`SVG checkpoint resource not found: ${id}`);resource.document.restore(value);}
    }else this.state = this.cloneValue(snapshot) as LuaState;
  }

  async close(): Promise<void> { this.engine?.global.close(); this.engine = undefined; this.builder = undefined; this.source = undefined; this.state = {}; this.vectorDocuments.clear(); this.loadedFontData.clear(); this.fontFiles.clear(); this.creatingResources = false; }

  private createSdk() {
    return {
      svg: (name: string, options: { source?: string; data?: string; strict?: boolean; font?: string; fonts?: Record<string,string> }) => {
        if (!this.creatingResources) throw new Error("SVG resources must be created before render()");
        if (!options || (options.source === undefined) === (options.data === undefined)) throw new Error("svg requires exactly one of source or data");
        return this.createVectorHandle(name, options.data ?? this.readShaderFile(options.source!), options);
      },
      path: (options: { d: string; fill?: string; stroke?: string; strokeWidth?: number; fillRule?: string }) => {
        if (!this.creatingResources) throw new Error("Path resources must be created before render()");
        parsePath(options.d);
        const escape = (v: string) => v.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");
        return this.createVectorHandle(this.nextResourceId("path"), `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" overflow="visible"><path id="path" d="${escape(options.d)}" fill="${escape(options.fill ?? "black")}" stroke="${escape(options.stroke ?? "none")}" stroke-width="${options.strokeWidth ?? 1}" fill-rule="${escape(options.fillRule ?? "nonzero")}"/></svg>`, {});
      },
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
      font: (name: string, descriptor: Partial<FontDefinition> = {}) => {
        if (this.declaredFonts.has(name)) throw new Error(`Font already exists: ${name}`);
        const options = descriptor as Record<string, unknown>;
        if (["weight", "style", "fallback", "variations", "data"].some((key) => options[key] !== undefined)) {
          throw new Error("Use a source TTF/OTF for the desired font face; weight/style/fallback/variations/data are unsupported");
        }
        const mode = (descriptor.atlas as Record<string, unknown> | undefined)?.mode;
        if (mode !== undefined && mode !== "msdf") throw new Error("Only MSDF font atlases are supported");
        const definition: FontDefinition = { family: descriptor.family ?? "Noto Sans SC", source: descriptor.source, features: descriptor.features ? this.normalizeStringArray(descriptor.features, `font ${name} features`) : undefined, atlas: descriptor.atlas };
        this.declaredFonts.set(name, definition); this.builder?.font(name, definition); return name;
      },
    };
  }

  private createPassHandle(pass: RenderPassBuilder) {
    return {
      addVectorCell: (name: string, options: { svg?: unknown; path?: unknown; transform?: unknown; width?: number; height?: number; opacity?: number }) => {
        if (!this.creatingResources) throw new Error("Vector cells must be created before render()");
        const document = this.handleId(options.svg ?? options.path, "SVG or path");
        const transform = options.transform === undefined ? identity() : this.normalizeNumericArray(options.transform, "Vector transform") as Matrix;
        const command = pass.drawVector({ document, transform, width: options.width, height: options.height, opacity: options.opacity ?? 1, enabled: true });
        return {
          setTransform: (value: unknown) => { const m = this.normalizeNumericArray(value, "Vector transform"); if (m.length !== 6 || !m.every(Number.isFinite)) throw new Error("Vector transform requires six finite numbers"); command.transform = m as Matrix; },
          setOpacity: (value: number) => { if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Vector opacity must be between 0 and 1"); command.opacity = value; },
          setEnabled: (value: boolean) => { command.enabled = value; },
          setViewport: (width: number, height: number) => { if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error("Vector viewport must be positive"); command.width = width; command.height = height; }
        };
      },
      clear: (color: [number, number, number, number]) => pass.clear(color),
      addDrawCell: (name: string, options: { mesh: unknown; program: string; textures?: Record<string, unknown>; uniforms?: unknown; instanceCount?: number }) => {
        const command = { type: "mesh" as const, mesh: this.handleId(options.mesh, "mesh"), program: options.program, uniforms: this.normalizeUniforms(options.uniforms), enabled: true, instanceCount: this.normalizeInstanceCount(options.instanceCount ?? 1) };
        this.applyTextures(pass, command, options.textures); const storedCommand = pass.drawMesh(command); return this.createDrawCellHandle(pass, storedCommand, name);
      },
      addTextCell: (name: string, options: { font: string; text?: string; size?: number; position?: [number, number]; color?: [number, number, number, number]; lineHeight?: number; letterSpacing?: number; maxWidth?: number; align?: "left" | "center" | "right"; anchor?: "top-left" | "baseline" | "center"; blend?: "alpha" | "premultiplied" | "additive" }) => {
        const layoutId = this.nextResourceId(`text_${name}`);
        const colorValues = options.color === undefined ? [1, 1, 1, 1] : this.normalizeNumericArray(options.color, `text ${name} color`);
        const positionValues = options.position === undefined ? [0, 0] : this.normalizeNumericArray(options.position, `text ${name} position`);
        if (colorValues.length !== 4 || positionValues.length !== 2) throw new Error(`Text cell ${name} requires color[4] and position[2]`);
        const style: TextStyle = { size: options.size ?? 24, color: colorValues as [number, number, number, number], lineHeight: options.lineHeight, letterSpacing: options.letterSpacing, maxWidth: options.maxWidth, align: options.align, anchor: options.anchor };
        this.builder?.textLayout(layoutId, { font: options.font, text: options.text ?? "", style, position: positionValues as [number, number] });
        const command = pass.drawText({ layout: layoutId, blend: options.blend ?? "premultiplied", enabled: true });
        return this.createTextCellHandle(layoutId, command, name);
      }
    };
  }

  private createVectorHandle(name: string, source: string, options: { strict?: boolean; font?: string; source?: string; fonts?: Record<string,string> }) {
    const document = new SvgDocument(source, { strict: options.strict });
    for (const image of document.xml.querySelectorAll("image, feImage")) {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href"); if (!href || href.startsWith("#") || /^(?:[a-z]+:|\/)/i.test(href)) continue;
      const parts = `${options.source?.split("/").slice(0, -1).join("/") ?? ""}/${href}`.split("/"), normalized: string[] = [];
      for (const part of parts) if (part === "..") normalized.pop(); else if (part && part !== ".") normalized.push(part);
      const path = normalized.join("/"), bytes = this.shaderFiles[path];
      if (bytes instanceof Uint8Array) {
        const ext = path.split(".").pop()?.toLowerCase(), mime = ({ png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", avif:"image/avif" } as Record<string,string>)[ext ?? ""];
        if (!mime) throw new Error(`Unsupported SVG image asset: ${path}`);
        let binary = ""; for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
        image.setAttribute("href", `data:${mime};base64,${btoa(binary)}`);
      } else if (options.source) image.setAttribute("href", path);
    }
    const fontFaces:Record<string,string>={...options.fonts};
    for(const [index,face] of document.fontSources.entries()){
      if(!face.source)continue;
      const id=`__svg_font:${name}:${index}`,key=`${face.family}:${face.weight}:${face.style}`;
      let source=face.source;
      if(!/^(?:[a-z]+:|\/)/i.test(source)){
        const parts=`${options.source?.split("/").slice(0,-1).join("/")??""}/${source}`.split("/"),out:string[]=[];
        for(const part of parts)if(part==='..')out.pop();else if(part&&part!=='.')out.push(part);source=out.join('/');
      }
      const definition={family:face.family,source};this.declaredFonts.set(id,definition);this.builder?.font(id,definition);fontFaces[key]??=id;
    }
    let font = options.font;
    if (document.xml.querySelector("text")) {
      font ??= Object.values(fontFaces)[0] ?? "__svg_default_font";
      if (!this.declaredFonts.has(font) && font === "__svg_default_font") {
        const definition = { family: "Noto Sans SC" }; this.declaredFonts.set(font, definition); this.builder?.font(font, definition);
      }
    }
    this.builder?.vector(name, document); this.vectorDocuments.set(name, { document, font, fonts: fontFaces });
    return { id: name,
      setAttribute: (id: string, attribute: string, value: string | number) => document.setAttribute(id, attribute, String(value)),
      setText: (id: string, value: string) => document.setText(id, value),
      setData: (d: string) => document.setAttribute("path", "d", d),
      hitTest: (x: number, y: number, width: number, height: number) => document.hitTest(x, y, width, height),
      getDiagnostics: () => [...document.diagnostics]
    };
  }

  private createTextCellHandle(layoutId: string, _command: { type: "text"; layout: string; enabled?: boolean; blend?: "alpha" | "premultiplied" | "additive" }, _name: string) {
    return {
      setText: (text: string) => this.builder?.updateTextLayout(layoutId, { text }),
      setPosition: (position: [number, number]) => { const values = this.normalizeNumericArray(position, `text ${_name} position`); if (values.length !== 2) throw new Error(`Text cell ${_name} position requires two numbers`); this.builder?.updateTextLayout(layoutId, { position: values as [number, number] }); },
      setColor: (color: [number, number, number, number]) => { const values = this.normalizeNumericArray(color, `text ${_name} color`); if (values.length !== 4) throw new Error(`Text cell ${_name} color requires four numbers`); this.builder?.updateTextLayout(layoutId, { style: { color: values as [number, number, number, number] } }); },
      setStyle: (style: Partial<TextStyle>) => {
        const normalized = { ...style } as Partial<TextStyle>;
        if (style.color !== undefined) {
          const values = this.normalizeNumericArray(style.color, `text ${_name} color`);
          if (values.length !== 4) throw new Error(`Text cell ${_name} color requires four numbers`);
          normalized.color = values as [number, number, number, number];
        }
        this.builder?.updateTextLayout(layoutId, { style: normalized });
      },
      setEnabled: (enabled: boolean) => { _command.enabled = enabled; }
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
  private shaderFiles: Record<string, string | Uint8Array> = {};
  private readShaderFile(path: string): string { const content = this.shaderFiles[path]; if (content === undefined) throw new Error(`Shader file not found: ${path}`); if (typeof content !== "string") throw new Error(`Shader file must be text: ${path}`); return content; }
  private async loadDeclaredFonts(): Promise<void> {
    await Promise.all([...this.declaredFonts].map(async ([id, font]) => {
      const source = font.source ?? defaultFontUrl;
      let bytes = this.shaderFiles[source];
      if (bytes !== undefined && !(bytes instanceof Uint8Array)) throw new Error(`Font ${id} must be a binary TTF/OTF asset: ${source}`);
      if (bytes === undefined) {
        let pending = this.fontFiles.get(source);
        if (!pending) {
          pending = fetch(source).then(async (response) => {
            if (!response.ok) throw new Error(`Failed to load font ${source}: ${response.status}`);
            return new Uint8Array(await response.arrayBuffer());
          });
          this.fontFiles.set(source, pending);
          pending.catch(() => this.fontFiles.delete(source));
        }
        bytes = await pending;
      }
      if(id.startsWith("__svg_font:"))bytes=await decodeSvgFont(bytes as Uint8Array);
      this.builder?.updateFontData(id, bytes as Uint8Array); this.loadedFontData.set(id, bytes as Uint8Array);
    }));
  }

  private normalizeNumericArray(value: unknown, label: string): number[] { if (Array.isArray(value)) return value.map((item) => Number(item)); if (value && typeof value === "object") { const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => /^\d+$/.test(key)).sort(([a], [b]) => Number(a) - Number(b)); if (entries.length > 0) return entries.map(([, item]) => Number(item)); } throw new Error(`${label} data must be an array of numbers`); }
  private normalizeStringArray(value: unknown, label: string): string[] { if (Array.isArray(value)) return value.map(String); if (value && typeof value === "object") { const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => /^\d+$/.test(key)).sort(([a], [b]) => Number(a) - Number(b)); if (entries.length > 0) return entries.map(([, item]) => String(item)); } throw new Error(`${label} must be an array of strings`); }
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

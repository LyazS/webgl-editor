<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { WebGLExecutor } from "./core/render-graph/webgl-executor";
import type { TemporalCheckpoint } from "./core/render-graph/webgl-executor";
import { LuaRenderRuntime } from "./core/runtime/lua-runtime";

const canvas = ref<HTMLCanvasElement>();
const virtualFiles = reactive<Record<string, string>>({
  "config.json": `{
  "totalFrames": 240
}`,
  "main.lua": `local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = {
    position = "a_position",
    normal = "a_normal",
    uv0 = "a_uv",
    color0 = "a_color"
  }
})

local lineProgram = rg.program("lineProgram", {
  vertex = "shaders/line.vert",
  fragment = "shaders/line.frag"
})

local feedbackProgram = rg.program("feedbackProgram", {
  vertex = "shaders/feedback.vert",
  fragment = "shaders/feedback.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})

local positions
local normals
local uvs
local colors
local indices
local linePositions
local quadPositions
local quadUvs
local trailCell
local screenCell
local lineCell

function setup()
  positions = rg.vertexBuffer({
    data = {
      -0.58, -0.38, -0.2,
       0.58, -0.38, -0.2,
       0.0,  0.58, -0.2
    },
    type = "float32",
    usage = "dynamic"
  })
  normals = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 0, 0, 1 },
    type = "float32"
  })
  uvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0.5, 1 },
    type = "float32"
  })
  colors = rg.vertexBuffer({
    data = { 255, 80, 80, 255, 80, 220, 255, 255, 180, 100, 255, 255 },
    type = "uint8"
  })
  indices = rg.indexBuffer({ data = { 0, 1, 2 }, type = "uint16" })
  linePositions = rg.vertexBuffer({
    data = { -0.9, -0.78, 0.1, 0.9, -0.78, 0.1 },
    type = "float32"
  })
  quadPositions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  quadUvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 1, 1 },
    type = "float32"
  })

  local triangle = rg.mesh({
    vertexBuffers = { position = positions, normal = normals, uv0 = uvs, color0 = colors },
    indexBuffer = indices,
    topology = "triangles",
    vertexCount = 3,
    indexCount = 3,
    attributes = { color0 = { components = 4, type = "uint8", normalized = true } }
  })
  local line = rg.mesh({
    vertexBuffers = { position = linePositions },
    topology = "lines",
    vertexCount = 2
  })
  local screenQuad = rg.mesh({
    vertexBuffers = { position = quadPositions, uv0 = quadUvs },
    topology = "triangle-strip",
    vertexCount = 4
  })

  local trail = rg.historyTarget("trail", {
    capacity = 16,
    width = "viewport",
    height = "viewport",
    format = "rgba8"
  })
  trail:clear({ 0.0, 0.0, 0.0, 1.0 })
  trailCell = trail:addDrawCell("trailCell", { mesh = triangle, program = meshProgram })

  local screen = rg.renderTarget("screen")
  screen:clear({ 0.025, 0.035, 0.06, 1.0 })
  screenCell = screen:addDrawCell("screenCell", {
    mesh = screenQuad,
    program = feedbackProgram,
    textures = {
      u_history1 = { name = "trail", offset = 1 },
      u_history2 = { name = "trail", offset = 2 },
      u_history3 = { name = "trail", offset = 3 },
      u_history4 = { name = "trail", offset = 4 },
      u_history5 = { name = "trail", offset = 5 },
      u_history6 = { name = "trail", offset = 6 },
      u_history7 = { name = "trail", offset = 7 },
      u_history8 = { name = "trail", offset = 8 }
    }
  })
  lineCell = screen:addDrawCell("lineCell", { mesh = line, program = lineProgram })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.32
  positions:setData({
    -0.58 + offset, -0.38, -0.2,
     0.58 + offset, -0.38, -0.2,
     0.0 + offset,  0.58, -0.2
  })
  trailCell:setUniform("u_transform", {
    type = "mat4",
    value = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }
  })
  trailCell:setUniform("u_tint", { type = "vec4", value = { 1, 1, 1, 1 } })
  lineCell:setUniform("u_color", { type = "vec4", value = { 0.95, 0.82, 0.25, 1.0 } })
end`
  ,
  "shaders/mesh.vert": `#version 300 es
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
in vec4 a_color;
uniform mat4 u_transform;
out vec3 v_normal;
out vec2 v_uv;
out vec4 v_color;
void main() {
  gl_Position = u_transform * vec4(a_position, 1.0);
  v_normal = a_normal;
  v_uv = a_uv;
  v_color = a_color;
}`,
  "shaders/mesh.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in vec4 v_color;
uniform vec4 u_tint;
out vec4 outColor;
void main() {
  float light = 0.65 + max(v_normal.z, 0.0) * 0.35;
  outColor = vec4(v_uv, 0.72, 1.0) * v_color * u_tint * light;
}`,
  "shaders/line.vert": `#version 300 es
in vec3 a_position;
void main() {
  gl_Position = vec4(a_position, 1.0);
}`,
  "shaders/line.frag": `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`,
  "shaders/feedback.vert": `#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 1.0);
  v_uv = a_uv;
}`,
  "shaders/feedback.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_history1;
uniform sampler2D u_history2;
uniform sampler2D u_history3;
uniform sampler2D u_history4;
uniform sampler2D u_history5;
uniform sampler2D u_history6;
uniform sampler2D u_history7;
uniform sampler2D u_history8;
out vec4 outColor;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 trail = vec4(0.0);
  trail += texture(u_history1, uv) * 0.34;
  trail += texture(u_history2, uv) * 0.24;
  trail += texture(u_history3, uv) * 0.16;
  trail += texture(u_history4, uv) * 0.10;
  trail += texture(u_history5, uv) * 0.065;
  trail += texture(u_history6, uv) * 0.04;
  trail += texture(u_history7, uv) * 0.025;
  trail += texture(u_history8, uv) * 0.015;
  outColor = trail;
}`,
  "shaders/copy.vert": `#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 1.0);
  v_uv = a_uv;
}`,
  "shaders/copy.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
out vec4 outColor;
void main() {
  outColor = texture(u_input, vec2(v_uv.x, 1.0 - v_uv.y));
}`,
  "shaders/accum.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_previous;
uniform vec2 u_center;
out vec4 outColor;
void main() {
  vec4 previous = texture(u_previous, vec2(v_uv.x, 1.0 - v_uv.y));
  float distanceToCenter = distance(v_uv, u_center);
  float stamp = exp(-distanceToCenter * 90.0);
  vec3 ink = vec3(0.18, 0.72, 1.0) * stamp;
  outColor = vec4(previous.rgb * 0.94 + ink, max(previous.a * 0.94, stamp));
}`,
  "shaders/instanced.vert": `#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
flat out int v_instance;
uniform float u_time;
void main() {
  const int columns = 10;
  int column = gl_InstanceID % columns;
  int row = gl_InstanceID / columns;
  vec2 grid = vec2(float(column), float(row));
  vec2 center = (grid + vec2(0.5) - vec2(5.0)) / vec2(5.0);
  float wave = sin(u_time * 2.0 + float(gl_InstanceID) * 0.35) * 0.035;
  vec2 position = a_position.xy * 0.075 + center + vec2(0.0, wave);
  gl_Position = vec4(position, a_position.z, 1.0);
  v_uv = a_uv;
  v_instance = gl_InstanceID;
}`,
  "shaders/instanced.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
flat in int v_instance;
out vec4 outColor;
void main() {
  float phase = float(v_instance) * 0.17;
  vec3 color = 0.5 + 0.5 * cos(vec3(phase, phase + 2.0, phase + 4.0));
  float glow = 0.75 + 0.25 * sin(v_uv.x * 3.14159);
  outColor = vec4(color * glow, 1.0);
}`,
});
const fileNames = [
  "config.json",
  "main.lua",
  "shaders/mesh.vert",
  "shaders/mesh.frag",
  "shaders/line.vert",
  "shaders/line.frag",
  "shaders/feedback.vert",
  "shaders/feedback.frag",
  "shaders/copy.vert",
  "shaders/copy.frag",
  "shaders/accum.frag",
  "shaders/instanced.vert",
  "shaders/instanced.frag",
];
const examples: Record<string, { label: string; main: string }> = {
  history: { label: "HistoryTarget · 8 帧拖影", main: virtualFiles["main.lua"] },
  renderTarget: {
    label: "RenderTarget · 普通离屏渲染",
    main: `local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = { position = "a_position", normal = "a_normal", uv0 = "a_uv", color0 = "a_color" }
})
local copyProgram = rg.program("copyProgram", {
  vertex = "shaders/copy.vert",
  fragment = "shaders/copy.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local positions
local triangleCell

function setup()
  positions = rg.vertexBuffer({ data = { -0.58, -0.38, 0, 0.58, -0.38, 0, 0, 0.58, 0 }, type = "float32", usage = "dynamic" })
  local normals = rg.vertexBuffer({ data = { 0,0,1, 0,0,1, 0,0,1 }, type = "float32" })
  local uvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0.5,1 }, type = "float32" })
  local colors = rg.vertexBuffer({ data = { 255,80,80,255, 80,220,255,255, 180,100,255,255 }, type = "uint8" })
  local indices = rg.indexBuffer({ data = { 0,1,2 }, type = "uint16" })
  local quadPositions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local quadUvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0,1, 1,1 }, type = "float32" })
  local triangle = rg.mesh({ vertexBuffers = { position=positions, normal=normals, uv0=uvs, color0=colors }, indexBuffer=indices, topology="triangles", vertexCount=3, indexCount=3, attributes={ color0={components=4,type="uint8",normalized=true} } })
  local quad = rg.mesh({ vertexBuffers = { position=quadPositions, uv0=quadUvs }, topology="triangle-strip", vertexCount=4 })
  local target = rg.renderTarget("sceneColor", { width="viewport", height="viewport", format="rgba8", depth=true })
  target:clear({ 0.02, 0.03, 0.05, 1.0 })
  triangleCell = target:addDrawCell("triangle", { mesh=triangle, program="meshProgram" })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="sceneColor" } })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.3
  positions:setData({ -0.58+offset,-0.38,0, 0.58+offset,-0.38,0, 0+offset,0.58,0 })
  triangleCell:setUniform("u_transform", { type="mat4", value={1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1} })
  triangleCell:setUniform("u_tint", { type="vec4", value={1,1,1,1} })
end`
  },
  accumulation: {
    label: "AccumulationTarget · 累积反馈",
    main: `local rg = require("render_graph")

local accumProgram = rg.program("accumProgram", { vertex="shaders/feedback.vert", fragment="shaders/accum.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local copyProgram = rg.program("copyProgram", { vertex="shaders/copy.vert", fragment="shaders/copy.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local accumulationCell

function setup()
  local quadPositions = rg.vertexBuffer({ data={-1,-1,0, 1,-1,0, -1,1,0, 1,1,0}, type="float32" })
  local quadUvs = rg.vertexBuffer({ data={0,0, 1,0, 0,1, 1,1}, type="float32" })
  local quad = rg.mesh({ vertexBuffers={position=quadPositions, uv0=quadUvs}, topology="triangle-strip", vertexCount=4 })
  local accumulation = rg.accumulationTarget("paint", { width="viewport", height="viewport", format="rgba8" })
  accumulationCell = accumulation:addDrawCell("accumulate", { mesh=quad, program="accumProgram", textures={ u_previous={name="paint", offset=1} } })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="paint" } })
  return {}
end

function render(ctx, state)
  local x = 0.5 + math.sin(ctx.frame / ctx.FPS * 1.5) * 0.35
  local y = 0.5 + math.cos(ctx.frame / ctx.FPS * 1.2) * 0.25
  accumulationCell:setUniform("u_center", { type="vec2", value={x,y} })
end`
  },
  instancing: {
    label: "Instancing · 100 个实例",
    main: `local rg = require("render_graph")

local instancedProgram = rg.program("instancedProgram", {
  vertex = "shaders/instanced.vert",
  fragment = "shaders/instanced.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local instanceCell

function setup()
  local positions = rg.vertexBuffer({
    data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 },
    type = "float32"
  })
  local uvs = rg.vertexBuffer({
    data = { 0,0, 1,0, 0,1, 1,1 },
    type = "float32"
  })
  local quad = rg.mesh({
    vertexBuffers = { position = positions, uv0 = uvs },
    topology = "triangle-strip",
    vertexCount = 4
  })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.015, 0.02, 0.045, 1.0 })
  instanceCell = screen:addDrawCell("instances", {
    mesh = quad,
    program = "instancedProgram",
    instanceCount = 100
  })
  return {}
end

function render(ctx, state)
  instanceCell:setUniform("u_time", {
    type = "float",
    value = ctx.frame / ctx.FPS
  })
end`
  }
};
const selectedExample = ref("history");
const activeFile = ref("main.lua");
const activeContent = computed(() => virtualFiles[activeFile.value] ?? "");
const currentFrame = ref(0);
const playing = ref(false);
const loopPlayback = ref(true);
const FPS = 30;
const totalFrames = ref(240);
const maxFrame = computed(() => totalFrames.value - 1);
const status = ref("Ready");
const passCount = ref(0);
const resourceCount = ref(0);
const luaRuntime = new LuaRenderRuntime();
const checkpointInterval = 30;
const checkpoints = new Map<number, { state: unknown; temporal: TemporalCheckpoint }>();
let executor: WebGLExecutor | undefined;
let animationFrame = 0;

async function buildGraph() {
  const graph = await luaRuntime.buildGraph(
    currentFrame.value,
    canvas.value?.clientWidth ?? 1,
    canvas.value?.clientHeight ?? 1,
    totalFrames.value
  );
  passCount.value = graph.passes.length;
  resourceCount.value = graph.resources.size;
  return graph;
}

async function render(updateStatus = true): Promise<boolean> {
  if (!executor || !canvas.value) return false;
  try {
    const graph = await buildGraph();
    executor.execute(graph, canvas.value.clientWidth, canvas.value.clientHeight, currentFrame.value);
    const nextFrame = currentFrame.value + 1;
    if (nextFrame % checkpointInterval === 0) {
      checkpoints.set(nextFrame, {
        state: luaRuntime.snapshotState(),
        temporal: executor.createTemporalCheckpoint()
      });
    }
    if (updateStatus) status.value = `Frame ${currentFrame.value} · ${graph.passes.length} pass`;
    return true;
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function compile() {
  try {
    const config = JSON.parse(virtualFiles["config.json"]) as { totalFrames?: unknown };
    if (typeof config.totalFrames !== "number" || !Number.isInteger(config.totalFrames) || config.totalFrames <= 0) {
      throw new Error("config.json: totalFrames must be a positive integer");
    }
    await luaRuntime.compile(virtualFiles["main.lua"], virtualFiles);
    checkpoints.clear();
    executor?.resetHistory();
    totalFrames.value = config.totalFrames;
    currentFrame.value = Math.min(currentFrame.value, totalFrames.value - 1);
    status.value = "Graph compiled";
    await render();
  } catch (error) {
    status.value = error instanceof Error ? `Compile error: ${error.message}` : String(error);
  }
}

async function changeExample(name: string): Promise<void> {
  const example = examples[name];
  if (!example) return;
  selectedExample.value = name;
  virtualFiles["main.lua"] = example.main;
  activeFile.value = "main.lua";
  await compile();
}

function onExampleChange(event: Event): void {
  void changeExample((event.target as HTMLSelectElement).value);
}

async function seekToFrame(targetFrame: number): Promise<void> {
  const previousFrame = currentFrame.value;
  playing.value = false;
  cancelAnimationFrame(animationFrame);
  if (targetFrame === previousFrame + 1) {
    currentFrame.value = targetFrame;
    await render();
    return;
  }

  status.value = `Rebuilding history to frame ${targetFrame}`;
  const checkpointFrame = [...checkpoints.keys()]
    .filter((frame) => frame <= targetFrame)
    .sort((a, b) => b - a)[0];
  const checkpoint = checkpointFrame === undefined ? undefined : checkpoints.get(checkpointFrame);
  await luaRuntime.recompile();
  executor?.resetHistory();
  currentFrame.value = 0;
  if (!(await render(false))) return;
  let firstFrame = 1;
  if (checkpoint && checkpointFrame !== undefined && executor) {
    luaRuntime.restoreState(checkpoint.state);
    executor.restoreTemporalCheckpoint(checkpoint.temporal);
    currentFrame.value = checkpointFrame;
    firstFrame = checkpointFrame;
  }
  for (let frame = firstFrame; frame <= targetFrame; frame += 1) {
    currentFrame.value = frame;
    if (!(await render(false))) return;
  }
  status.value = `Frame ${targetFrame} · history rebuilt`;
}

async function seek(event: Event) {
  await seekToFrame(Number((event.target as HTMLInputElement).value));
}

function tick() {
  if (!playing.value) return;
  if (currentFrame.value + 1 >= totalFrames.value) {
    if (!loopPlayback.value) {
      playing.value = false;
      status.value = `Finished at frame ${currentFrame.value}`;
      return;
    }
    void seekToFrame(0).then(() => {
      if (loopPlayback.value) {
        playing.value = true;
        animationFrame = requestAnimationFrame(tick);
      }
    });
    return;
  } else {
    currentFrame.value += 1;
  }
  void render();
  animationFrame = requestAnimationFrame(tick);
}

function updateActiveFile(event: Event) {
  virtualFiles[activeFile.value] = (event.target as HTMLTextAreaElement).value;
}

function selectFile(fileName: string) {
  activeFile.value = fileName;
}

function togglePlayback() {
  playing.value = !playing.value;
  if (playing.value) {
    status.value = "Playing";
    animationFrame = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(animationFrame);
    status.value = `Paused at frame ${currentFrame.value}`;
  }
}

onMounted(async () => {
  await nextTick();
  if (!canvas.value) return;
  try {
    executor = new WebGLExecutor(canvas.value);
    const config = JSON.parse(virtualFiles["config.json"]) as { totalFrames?: unknown };
    if (typeof config.totalFrames !== "number" || !Number.isInteger(config.totalFrames) || config.totalFrames <= 0) {
      throw new Error("config.json: totalFrames must be a positive integer");
    }
    await luaRuntime.compile(virtualFiles["main.lua"], virtualFiles);
    totalFrames.value = config.totalFrames;
    await render();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame);
  void luaRuntime.close();
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">WEBGL / RENDER GRAPH</div>
        <h1>Deterministic Canvas</h1>
      </div>
      <div class="topbar-actions">
        <select :value="selectedExample" aria-label="Render target example" @change="onExampleChange">
          <option v-for="(example, name) in examples" :key="name" :value="name">{{ example.label }}</option>
        </select>
        <div class="status-pill"><span class="status-dot" />{{ status }}</div>
      </div>
    </header>

    <section class="workspace">
      <aside class="editor-panel panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">SCRIPT</span>
            <strong>{{ activeFile }}</strong>
          </div>
          <button class="compile-button" @click="compile">Compile</button>
        </div>
        <div class="editor-body">
          <nav class="file-tree" aria-label="Virtual project files">
            <div class="tree-title">PROJECT</div>
            <button
              v-for="fileName in fileNames"
              :key="fileName"
              class="file-item"
              :class="{ active: activeFile === fileName }"
              @click="selectFile(fileName)"
            >
              <span class="file-icon">{{ fileName.endsWith(".json") ? "{}" : "◈" }}</span>{{ fileName }}
            </button>
          </nav>
          <textarea :value="activeContent" spellcheck="false" :aria-label="activeFile" @input="updateActiveFile" />
        </div>
        <div class="editor-footer">
          <span>Lua SDK boundary</span>
          <span>Graph IR ready</span>
        </div>
      </aside>

      <section class="preview-panel panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">PREVIEW</span>
            <strong>WebGL2 Canvas</strong>
          </div>
          <div class="preview-actions">
            <div class="graph-stats">{{ passCount }} pass · {{ resourceCount }} resource</div>
            <button class="play-button" @click="togglePlayback">{{ playing ? "Pause" : "Play" }}</button>
          </div>
        </div>
        <div class="canvas-wrap"><canvas ref="canvas" /></div>
        <div class="timeline">
          <div class="timeline-label"><span>FRAME</span><strong>{{ currentFrame }} / {{ maxFrame }}</strong></div>
          <input type="range" min="0" :max="maxFrame" :value="currentFrame" @input="seek" />
          <div class="timeline-end">{{ maxFrame }}</div>
          <label class="loop-control"><input v-model="loopPlayback" type="checkbox" /> Loop</label>
          <span class="timeline-config">{{ totalFrames }} frames · {{ FPS }} FPS</span>
        </div>
      </section>
    </section>
  </main>
</template>

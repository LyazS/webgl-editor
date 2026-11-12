<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { WebGLExecutor } from "./core/render-graph/webgl-executor";
import type { TemporalCheckpoint } from "./core/render-graph/webgl-executor";
import { LuaRenderRuntime } from "./core/runtime/lua-runtime";
import type { RenderGraphAgentApi, RenderFrameOptions, RenderedFrameCapture } from "./core/agent-api";

type ExampleProject = { label: string; files: Record<string, string> };
type FileTreeNode = { name: string; path: string; kind: "file" | "directory"; children?: FileTreeNode[] };
type VisibleFileTreeNode = FileTreeNode & { depth: number };
const canvas = ref<HTMLCanvasElement>();

// Every example is a self-contained project rooted at its own directory. Vite eagerly
// imports the directory so the editor can expose exactly the files Lua is allowed to read.
const rawExampleFiles = import.meta.glob("./examples/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const projectFiles: Record<string, Record<string, string>> = {};
const labels: Record<string, string> = {};

for (const [filePath, content] of Object.entries(rawExampleFiles)) {
  const relativePath = filePath.slice("./examples/".length);
  const [scope, ...parts] = relativePath.split("/");
  if (parts.length === 0) continue;
  const project = (projectFiles[scope] ??= {});
  const projectPath = parts.join("/");
  if (projectPath === "example.json") {
    const metadata = JSON.parse(content) as { label?: unknown };
    if (typeof metadata.label === "string" && metadata.label.length > 0) labels[scope] = metadata.label;
  } else {
    project[projectPath] = content;
  }
}

const examples: Record<string, ExampleProject> = Object.fromEntries(
  Object.entries(projectFiles).map(([name, files]) => [name, {
    label: labels[name] ?? name,
    files,
  }]),
);
const defaultExample = examples.history ?? examples[Object.keys(examples)[0]];
if (!defaultExample) throw new Error("No render graph examples found");

const virtualFiles = reactive<Record<string, string>>({ ...defaultExample.files });
const expandedDirectories = reactive(new Set<string>(["assets", "shot1", "shot1/lib", "shot1/lib/icons", "shot1/shaders", "shared", "shared/lua", "shared/shaders"]));

function buildFileTree(files: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode>();
  const ensureDirectory = (path: string, name: string, parent: FileTreeNode[]): FileTreeNode => {
    const existing = directories.get(path);
    if (existing) return existing;
    const node: FileTreeNode = { name, path, kind: "directory", children: [] };
    directories.set(path, node);
    parent.push(node);
    return node;
  };
  for (const filePath of files) {
    const parts = filePath.split("/");
    let parent = root;
    let path = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      path = path ? `${path}/${parts[index]}` : parts[index];
      parent = ensureDirectory(path, parts[index], parent).children!;
    }
    parent.push({ name: parts[parts.length - 1], path: filePath, kind: "file" });
  }
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) if (node.children) sortNodes(node.children);
  };
  sortNodes(root);
  return root;
}

const fileTree = computed(() => buildFileTree(Object.keys(virtualFiles)));
const visibleFileTree = computed<VisibleFileTreeNode[]>(() => {
  const visible: VisibleFileTreeNode[] = [];
  const visit = (nodes: FileTreeNode[], depth: number) => {
    for (const node of nodes) {
      visible.push({ ...node, depth });
      if (node.kind === "directory" && expandedDirectories.has(node.path)) visit(node.children ?? [], depth + 1);
    }
  };
  visit(fileTree.value, 0);
  return visible;
});

function toggleDirectory(path: string): void {
  if (expandedDirectories.has(path)) expandedDirectories.delete(path);
  else expandedDirectories.add(path);
}

function loadExampleFiles(files: Record<string, string>): void {
  for (const fileName of Object.keys(virtualFiles)) delete virtualFiles[fileName];
  Object.assign(virtualFiles, files);
  expandedDirectories.clear();
  for (const fileName of Object.keys(files)) {
    const parts = fileName.split("/");
    for (let index = 1; index < parts.length; index += 1) expandedDirectories.add(parts.slice(0, index).join("/"));
  }
}

const selectedExample = ref(examples.history ? "history" : Object.keys(examples)[0]);
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
let captureQueue: Promise<void> = Promise.resolve();

async function buildGraph() {
  const graph = await luaRuntime.buildGraph(
    currentFrame.value,
    canvas.value?.clientWidth ?? 1,
    canvas.value?.clientHeight ?? 1,
    totalFrames.value,
    window.devicePixelRatio || 1
  );
  passCount.value = graph.passes.length;
  resourceCount.value = graph.resources.size;
  return graph;
}

async function render(updateStatus = true): Promise<boolean> {
  if (!executor || !canvas.value) return false;
  try {
    const graph = await buildGraph();
    await executor.execute(graph, canvas.value.clientWidth, canvas.value.clientHeight, currentFrame.value);
    passCount.value = graph.passes.reduce((count, pass) => count + 1 + pass.commands.reduce((n, command) => n + (command.type === "vector" ? command.compiledPlan?.passes.length ?? 0 : 0), 0), 0);
    const nextFrame = currentFrame.value + 1;
    if (nextFrame % checkpointInterval === 0) {
      checkpoints.set(nextFrame, {
        state: luaRuntime.snapshotState(),
        temporal: executor.createTemporalCheckpoint()
      });
    }
    if (updateStatus) status.value = `Frame ${currentFrame.value} · ${passCount.value} pass`;
    return true;
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function compile() {
  playing.value = false; cancelAnimationFrame(animationFrame); status.value = "Compiling";
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
  loadExampleFiles(example.files);
  activeFile.value = "main.lua";
  await compile();
}

function onExampleChange(event: Event): void {
  void changeExample((event.target as HTMLSelectElement).value);
}

async function seekToFrame(targetFrame: number): Promise<boolean> {
  const previousFrame = currentFrame.value;
  playing.value = false;
  cancelAnimationFrame(animationFrame);
  if (targetFrame === previousFrame + 1) {
    currentFrame.value = targetFrame;
    return render();
  }

  status.value = `Rebuilding history to frame ${targetFrame}`;
  const checkpointFrame = [...checkpoints.keys()]
    .filter((frame) => frame <= targetFrame)
    .sort((a, b) => b - a)[0];
  const checkpoint = checkpointFrame === undefined ? undefined : checkpoints.get(checkpointFrame);
  await luaRuntime.recompile();
  executor?.resetHistory();
  currentFrame.value = 0;
  if (!(await render(false))) return false;
  let firstFrame = 1;
  if (checkpoint && checkpointFrame !== undefined && executor) {
    luaRuntime.restoreState(checkpoint.state);
    executor.restoreTemporalCheckpoint(checkpoint.temporal);
    currentFrame.value = checkpointFrame;
    firstFrame = checkpointFrame;
  }
  for (let frame = firstFrame; frame <= targetFrame; frame += 1) {
    currentFrame.value = frame;
    if (!(await render(false))) return false;
  }
  status.value = `Frame ${targetFrame} · history rebuilt`;
  return true;
}

async function seek(event: Event) {
  await seekToFrame(Number((event.target as HTMLInputElement).value));
}

function captureFrame(frame: number, options: RenderFrameOptions = {}): Promise<RenderedFrameCapture> {
  const task = captureQueue.then(async () => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= totalFrames.value) {
      throw new Error(`Frame must be an integer from 0 to ${totalFrames.value - 1}`);
    }
    if (!executor || !canvas.value) throw new Error("Render graph is not ready");
    if (!(await seekToFrame(frame))) throw new Error(status.value);

    const canvasElement = canvas.value;
    const pixels = options.includePixels ? executor.readScreenPixels() : undefined;
    return {
      frame,
      width: canvasElement.width,
      height: canvasElement.height,
      mimeType: "image/png" as const,
      dataUrl: canvasElement.toDataURL("image/png"),
      ...(pixels ? { pixels: Array.from(pixels.data) } : {})
    };
  });
  // Keep later captures usable even when one capture fails.
  captureQueue = task.then(() => undefined, () => undefined);
  return task;
}

const agentApi: RenderGraphAgentApi = { captureFrame };

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

function onContextLost(event: Event): void {
  event.preventDefault();
  playing.value = false;
  cancelAnimationFrame(animationFrame);
  executor?.destroy();
  executor = undefined;
  status.value = "WebGL context lost; waiting for restoration";
}

async function onContextRestored(): Promise<void> {
  if (!canvas.value) return;
  try {
    executor?.destroy();
    executor = new WebGLExecutor(canvas.value);
    checkpoints.clear();
    // Replay so Lua mutations, SVG animations and temporal textures agree.
    await luaRuntime.recompile();
    const target = currentFrame.value;
    for (let frame = 0; frame <= target; frame++) {
      currentFrame.value = frame;
      if (!await render()) break;
    }
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
}

onMounted(async () => {
  await nextTick();
  window.renderGraphAgent = agentApi;
  if (!canvas.value) return;
  canvas.value.addEventListener("webglcontextlost", onContextLost);
  canvas.value.addEventListener("webglcontextrestored", onContextRestored);
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
  if (window.renderGraphAgent === agentApi) delete window.renderGraphAgent;
  canvas.value?.removeEventListener("webglcontextlost", onContextLost);
  canvas.value?.removeEventListener("webglcontextrestored", onContextRestored);
  cancelAnimationFrame(animationFrame);
  executor?.destroy();
  executor = undefined;
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
          <nav class="file-tree" aria-label="Project files">
            <div class="tree-title">PROJECT</div>
            <button
              v-for="node in visibleFileTree"
              :key="node.path"
              class="file-item"
              :class="{ active: node.kind === 'file' && activeFile === node.path, directory: node.kind === 'directory' }"
              :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
              :aria-expanded="node.kind === 'directory' ? expandedDirectories.has(node.path) : undefined"
              @click="node.kind === 'directory' ? toggleDirectory(node.path) : selectFile(node.path)"
            >
              <span class="file-icon">{{ node.kind === 'directory' ? (expandedDirectories.has(node.path) ? '▾' : '▸') : (node.name.endsWith('.json') ? '{}' : '◈') }}</span>
              <span class="file-label">{{ node.name }}</span>
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

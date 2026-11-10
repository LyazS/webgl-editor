# WebGL Render Graph 原型能力说明

本文档描述当前代码实际提供的能力。Lua API 以 `src/core/runtime/lua-runtime.ts` 为准，Graph 校验以 `src/core/render-graph/graph.ts` 为准。

## 1. 当前定位

这是一个浏览器端 WebGL2 Render Graph 原型：

```text
虚拟文件
  → Wasmoon Lua 5.4
  → Render Graph 构建与校验
  → WebGL2 Framebuffer / Texture / Buffer / VAO
  → 屏幕输出
```

项目不是完整的实时渲染引擎，也不是持久化项目编辑器。

## 2. 已实现能力

- Vue 3、Vite、浏览器端运行。
- 虚拟文件树和内存中的 `config.json`、`main.lua`、GLSL 文件。
- WebGL2 画布、离屏 2D 纹理和多 Pass 执行。
- Lua 5.4 Wasmoon；Base、Table、String、Math 库。
- `setup()` / `render(ctx, state)` 生命周期。
- 帧上下文：`FPS=30`、`totalFrames`、整数 `frame`。
- Texture、RenderTarget、HistoryTarget、AccumulationTarget。
- Vertex Buffer、Index Buffer、Mesh、静态/动态 Buffer 更新。
- `triangles`、`triangle-strip`、`lines`。
- 实例化绘制：`instanceCount`、`gl_InstanceID` 和 attribute `divisor`。
- position、normal、uv0、color0 semantic 和自定义 attribute layout。
- Program、vertex/fragment shader、vertexInputs 映射。
- clear、Mesh DrawCell、uniform、sampler2D、启用/禁用绘制。
- float、vec2、vec3、vec4、int、ivec2、ivec3、ivec4、mat4 uniform。
- sampler2D 对普通纹理、HistoryTarget 和 AccumulationTarget 的绑定。
- 深度 attachment、depth test、depth write、depth func、depth clear。
- Graph 资源校验、Pass 拓扑排序、重复生产者和循环依赖检查。
- Lua、Graph、shader 编译和链接错误反馈。
- History/Accumulation 的部分 checkpoint 和恢复能力。

## 3. Lua 文件合同

虚拟项目的主要文件为：

```text
config.json
main.lua
shaders/*.vert
shaders/*.frag
```

`config.json` 当前只使用：

```json
{
  "totalFrames": 240
}
```

`totalFrames` 必须是正整数。

`main.lua` 必须包含：

```lua
function setup()
    return {}
end

function render(ctx, state)
end
```

资源、Program、Mesh、Pass 和 DrawCell 必须在第一次 `render()` 前完成，可以放在脚本加载阶段或 `setup()` 中；`render()` 只更新动态数据。最终必须有一个 Pass 的 target 是 `"screen"`。

完整 API 见 [LUA_RENDER_GRAPH_LANGUAGE_V2.md](./LUA_RENDER_GRAPH_LANGUAGE_V2.md)。

## 4. 当前实际 Lua API

```lua
local rg = require("render_graph")

local program = rg.program("name", {
    vertex = "shaders/a.vert",
    fragment = "shaders/a.frag",
    vertexInputs = { position = "a_position" }
})

local vb = rg.vertexBuffer({
    data = { ... },
    type = "float32",
    usage = "dynamic"
})

local mesh = rg.mesh({
    vertexBuffers = { position = vb },
    topology = "triangles",
    vertexCount = 3
})

local target = rg.renderTarget("offscreen", {
    width = "viewport",
    height = "viewport",
    format = "rgba8"
})

local cell = target:addDrawCell("draw", {
    mesh = mesh,
    program = "name"
})

local screen = rg.renderTarget("screen")

screen:addDrawCell("copy", {
    mesh = quad,
    program = "copy",
    textures = { u_input = "offscreen" }
})
```

当前 SDK 的重要事实：

- `vertexBuffer()`、`indexBuffer()`、`mesh()` 接收 descriptor，不接收用户自定义资源名；它们返回 Lua 句柄。
- `program()` 接收名称并返回名称字符串。
- Target API 会在内部创建 Render Pass；当前 Lua 层没有 `rg.pass()`。
- 屏幕使用 `rg.renderTarget("screen")`，不是 `rg.screen()`。
- 当前没有 Lua 层 `rg.material()`，应使用 `rg.program()`。
- `renderTarget()`、`historyTarget()`、`accumulationTarget()` 会创建目标并返回可添加 DrawCell 的目标句柄。

## 5. Graph 校验规则

编译 Graph 时会检查：

1. 输出资源存在并且有 Pass 生产。
2. 每个 Pass 恰好写一个 target。
3. Pass ID 和资源 ID 不重复。
4. 所有 reads、textures、Mesh、Buffer、Program 引用有效。
5. 一个资源不能有多个 Pass 生产者。
6. Pass 依赖不能形成环。
7. Buffer 数据、Index 数据、Mesh 数量和 attribute layout 有效。
8. uniform 类型和值长度有效。
9. depth enabled 的 target 有 depth attachment。

## 6. Shader 约定

Shader 使用 WebGL2 GLSL，通常以 `#version 300 es` 开头。默认 attribute 映射为：

```text
position → a_position
normal   → a_normal
uv0      → a_uv0
color0   → a_color0
```

如果 shader 使用其他名称，必须在 `vertexInputs` 中显式映射。

## 7. 部分支持与边界

- 播放由 `requestAnimationFrame` 驱动，每次回调推进一帧，不做严格 30 FPS 补偿。
- seek 使用整数帧，但不会自动恢复 Lua state 或历史纹理到目标帧。
- HistoryTarget 读取过去帧，直接跳帧无法凭空生成缺失的历史内容。
- 纹理当前只有 `rgba8`。
- 资源会缓存，但没有自动生命周期分析、临时纹理复用或 aliasing。
- 虚拟文件只存在当前页面内存，刷新后不会持久化。

## 8. 当前未实现

- 图片、视频、摄像头纹理和通用外部纹理加载。
- Depth texture、Texture Array、Cubemap 和更多纹理格式。
- Blend、Stencil、Cull、MRT、MSAA 显式控制。
- Compute、GPU simulation、粒子系统。
- Bloom、Blur、Color grading 等完整后处理套件。
- 自动相机矩阵、模型/视图/投影注入。
- Lua 调试器、GLSL 行号诊断面板、完整项目导入导出。

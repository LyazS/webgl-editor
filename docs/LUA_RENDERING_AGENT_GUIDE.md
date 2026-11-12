# Lua 渲染脚本：coding agent 指南

这份文档给需要在本项目中编写 `main.lua` 的 coding agent。目标是让 agent 能从一个渲染需求得到可运行的 Lua 脚本、GLSL 文件和正确的 Render Graph。完整参数以 [LUA_RENDER_GRAPH_LANGUAGE.md](./LUA_RENDER_GRAPH_LANGUAGE.md) 为准；能力边界以 [RENDER_GRAPH_CAPABILITIES.md](./RENDER_GRAPH_CAPABILITIES.md) 为准。

## 先确认项目文件

一个 Lua 示例项目至少包含：

```text
config.json
main.lua
shaders/*.vert
shaders/*.frag
```

`config.json` 当前只读取 `totalFrames`：

```json
{ "totalFrames": 240 }
```

shader 和 Lua 路径都是虚拟项目内的相对路径。写脚本前先检查同类示例，优先复用现有的全屏 quad、mesh 和 shader 约定。项目中的参考示例位于 `src/examples/`。

## 先做图，再写代码

把需求拆成这几层：

1. **输出目标**：直接画到 `screen`，还是先画到离屏、History 或 Accumulation Target。
2. **静态资源**：Program、Buffer、Mesh、Font、SVG/Path。它们只创建一次。
3. **每帧数据**：位置、顶点数据、uniform、纹理引用、实例数量和启用状态。
4. **依赖顺序**：后处理 pass 通过 `textures` 读取前一个 Target；Graph 会据此排序。

Lua 层的 Target 就是一个内部 Render Pass。当前 SDK 没有 `rg.pass()`，也没有 `rg.screen()`；屏幕必须通过 `rg.renderTarget("screen")` 获取。

## 必须遵守的生命周期

脚本必须定义两个全局函数：

```lua
function setup()
  return {}
end

function render(ctx, state)
end
```

`setup()` 在 Compile 时执行一次。资源、Target、DrawCell 和初始状态可以在文件顶层或 `setup()` 中创建，但必须在第一次 `render()` 前完成。

`render(ctx, state)` 每帧执行。这里只更新已经创建的资源：

- dynamic Buffer 的数据；
- DrawCell 的 uniform、纹理、实例数量和 enabled；
- TextCell 的文本、位置、颜色和样式；
- VectorCell 的 transform、opacity、viewport 和 enabled；
- SVG/Path 句柄的动态属性。

不要在 `render()` 中调用 `rg.program()`、`rg.mesh()`、`rg.renderTarget()`、`addDrawCell()` 等创建 API。重复创建会导致重复资源、重复 Pass 或多个生产者错误。

`ctx` 的字段固定为：

```lua
ctx.FPS         -- 30
ctx.totalFrames -- config.json 的 totalFrames
ctx.frame       -- 当前整数帧，从 0 开始
ctx.width       -- 画布逻辑宽度，CSS 像素
ctx.height      -- 画布逻辑高度，CSS 像素
ctx.pixelRatio  -- 设备像素比
```

`state` 是 `setup()` 返回的 table。如果 `setup()` 返回其他值，运行时会使用空 table。把可序列化的动画状态放进 `state`，把资源句柄保存在脚本级变量中。

Lua 只开放 Base、Table、String、Math 库。使用 `local rg = require("render_graph")` 获取 SDK；项目内模块可以用 `require("lib/animation")` 或 `require("lib/animation.lua")` 加载。IO、OS、Debug、DOM、WebGL 和外部 Lua 模块不可用。

## 最小可运行模板

下面的模板绘制一个会水平移动的三角形。它展示了最常用的资源顺序：Program → dynamic Buffer → Mesh → screen Target → DrawCell → 每帧更新。

`main.lua`：

```lua
local rg = require("render_graph")

rg.program("triangleProgram", {
  vertex = "shaders/triangle.vert",
  fragment = "shaders/triangle.frag",
  vertexInputs = { position = "a_position" }
})

local positions
local triangleCell

function setup()
  positions = rg.vertexBuffer({
    data = { -0.5, -0.4, 0, 0.5, -0.4, 0, 0, 0.5, 0 },
    type = "float32",
    usage = "dynamic"
  })

  local triangle = rg.mesh({
    vertexBuffers = { position = positions },
    topology = "triangles",
    vertexCount = 3
  })

  local screen = rg.renderTarget("screen")
  screen:clear({ 0.02, 0.03, 0.05, 1 })
  triangleCell = screen:addDrawCell("triangle", {
    mesh = triangle,
    program = "triangleProgram"
  })

  return {}
end

function render(ctx, state)
  local x = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.3
  positions:setData({
    -0.5 + x, -0.4, 0,
     0.5 + x, -0.4, 0,
     0.0 + x,  0.5, 0
  })
  triangleCell:setUniform("u_tint", {
    type = "vec4",
    value = { 0.35, 0.85, 1.0, 1.0 }
  })
end
```

`shaders/triangle.vert`：

```glsl
#version 300 es
in vec3 a_position;

void main() {
  gl_Position = vec4(a_position, 1.0);
}
```

`shaders/triangle.frag`：

```glsl
#version 300 es
precision highp float;

uniform vec4 u_tint;
out vec4 outColor;

void main() {
  outColor = u_tint;
}
```

## 常用 API 选择

### Program、Buffer 和 Mesh

```lua
local program = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = {
    position = "a_position",
    uv0 = "a_uv",
    color0 = "a_color"
  }
})

local positions = rg.vertexBuffer({
  data = { ... }, type = "float32", usage = "dynamic"
})
local indices = rg.indexBuffer({ data = { 0, 1, 2 }, type = "uint16" })

local mesh = rg.mesh({
  vertexBuffers = { position = positions },
  indexBuffer = indices,
  topology = "triangles", -- triangles | triangle-strip | lines
  vertexCount = 3,
  indexCount = 3
})
```

Buffer 类型是 `float32`、`uint8`、`uint16`、`uint32`；Index Buffer 只能使用 `uint16` 或 `uint32`。只有 `usage = "dynamic"` 的 Buffer 可以调用 `setData()` 或 `updateRange(offset, data)`，而且更新长度不能超过初始声明长度。

Mesh 的 semantic 通常使用 `position`、`normal`、`uv0`、`color0`。默认分量数分别是 3、3、2、4；需要交错数据、归一化颜色或实例属性时，在 `attributes` 中指定 `components`、`type`、`normalized`、`stride`、`offset`、`divisor`。

`vertexInputs` 把 semantic 映射到 GLSL attribute。没有显式映射时，默认名称是 `a_position`、`a_normal`、`a_uv0`、`a_color0`。shader 声明的名称和映射必须一致。

### Target、DrawCell 和依赖

```lua
local scene = rg.renderTarget("scene", {
  width = "viewport", height = "viewport", format = "rgba8"
})
scene:clear({ 0, 0, 0, 1 })
local sceneCell = scene:addDrawCell("scene", {
  mesh = mesh,
  program = "meshProgram",
  uniforms = {
    u_tint = { type = "vec4", value = { 1, 1, 1, 1 } }
  }
})

local quad = ...
local screen = rg.renderTarget("screen")
screen:addDrawCell("copy", {
  mesh = quad,
  program = "copyProgram",
  textures = { u_input = "scene" }
})
```

`textures` 中的字符串会自动建立 Graph 读取依赖。纹理只能采样 `texture`、`historyTarget` 或 `accumulationTarget` 资源；当前 Lua 没有通用图片、视频或摄像头纹理上传 API。

反馈效果使用：

```lua
local trail = rg.historyTarget("trail", {
  capacity = 16, width = "viewport", height = "viewport", format = "rgba8"
})
local trailCell = trail:addDrawCell("trail", {
  mesh = quad,
  program = "feedbackProgram",
  textures = { u_previous = { name = "trail", offset = 1 } }
})
```

History 的 `offset` 必须是 `1` 到 `capacity - 1`。Accumulation Target 是双缓冲，引用 offset 只能是 `0` 或 `1`。最终 Graph 必须有一个 Target 写入 `screen`。

DrawCell 创建后可调用：

```lua
cell:setUniform(name, { type = "float|vec2|vec3|vec4|int|ivec2|ivec3|ivec4|mat4", value = ... })
cell:setTextures({ u_input = "scene" })
cell:setEnabled(false)
cell:setInstanceCount(100)
cell:update({ uniforms = { ... }, textures = { ... }, instanceCount = 100 })
```

Uniform 数组长度必须匹配类型；`mat4` 需要 16 个数。sampler2D 优先通过 `textures` 设置。

### TextCell、VectorCell

文字：

```lua
local font = rg.font("ui")
local screen = rg.renderTarget("screen")
local title = screen:addTextCell("title", {
  font = font, text = "Frame 0", size = 32,
  position = { 32, 48 }, color = { 1, 1, 1, 1 },
  blend = "premultiplied"
})
```

默认字体是内置 Noto Sans SC；自定义字体必须是独立 TTF/OTF：`rg.font("ui", { source = "fonts/ui.otf" })`。`TextCell` 支持 `setText()`、`setPosition()`、`setColor()`、`setStyle()`、`setEnabled()`。

SVG 或程序化路径：

```lua
local art = rg.svg("art", { source = "assets/art.svg" })
local path = rg.path({ d = "M0 0H100V100H0Z", fill = "#69d8c5" })
local screen = rg.renderTarget("screen")
local artCell = screen:addVectorCell("art", { svg = art })
local pathCell = screen:addVectorCell("path", { path = path })
```

`source` 和 `data` 必须二选一。VectorCell 支持 `setTransform()`、`setOpacity()`、`setEnabled()`、`setViewport()`；Path 句柄支持 `setData()`。详细限制见 [SVG_RENDERING.md](./SVG_RENDERING.md)。

## Graph 校验失败时先查什么

1. 是否定义了 `setup()` 和 `render(ctx, state)`，并且最终写入了 `screen`。
2. 是否在 `render()` 中误创建了资源或 DrawCell。
3. `program`、shader 路径、`vertexInputs` 和 GLSL attribute 是否一致。
4. Mesh 是否至少有一个 vertex buffer；`vertexCount`、`indexCount` 是否为正整数。
5. Index 数据是否为非负整数，Buffer 类型和 attribute `type` 是否一致。
6. uniform 类型和值长度是否匹配；sampler 是否引用了真实 Target/Texture。
7. 一个资源是否被多个 Target 写入，或者 Pass 依赖形成环。
8. History/Accumulation 的 offset 是否在允许范围内。

运行时的 Lua、Graph、shader 编译错误会显示在编辑器错误面板。不要用关闭校验、吞掉异常或把资源创建移到 `render()` 来规避错误。

## 交付前检查

- [ ] `main.lua` 只有静态资源声明和 `setup()` 创建图；动态值在 `render()` 更新。
- [ ] 资源路径存在于虚拟文件树，GLSL 使用 `#version 300 es`。
- [ ] 有一个从最终结果到 `screen` 的 Pass。
- [ ] 所有 sampler 依赖通过 `textures` 或正确的 sampler uniform 声明。
- [ ] 动态 Buffer 使用 `usage = "dynamic"`，更新不超出初始长度。
- [ ] Graph 不存在重复资源、重复生产者或环。
- [ ] 修改后运行 `npm run build`；改动运行时或 SVG 时，再运行项目已有的 `npm test` 和相关浏览器测试。

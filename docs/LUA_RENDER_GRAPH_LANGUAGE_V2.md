# Lua Render Graph 语言：当前运行时契约

本文档以 `src/core/runtime/lua-runtime.ts`、`src/core/render-graph/graph.ts` 和 `src/App.vue` 中的实际实现为准。文件名保留 `V2` 是为了兼容现有引用；这里描述的是当前可执行 API，不是未来设计。

## 1. 生命周期

`main.lua` 必须定义两个全局函数：

```lua
function setup()
    return {}
end

function render(ctx, state)
end
```

`setup()` 在 Compile 时执行一次，用来创建 DrawCell 和初始化状态。资源、Program 和 Pass 可以在脚本加载阶段或 `setup()` 中声明，但必须在第一次 `render()` 前完成。它的返回值会作为 `state` 传给每次 `render()`；如果返回的不是 table，运行时会使用空 table。

`render(ctx, state)` 每帧执行，用来更新动态 Buffer、uniform、纹理绑定和 DrawCell 的启用状态。不要在 `render()` 中声明资源或创建 Pass；当前 Graph 会在多帧之间复用，这样做会导致重复资源、重复 Pass 或多个生产者错误。

上下文只有以下字段：

```lua
ctx.FPS         -- 固定为 30
ctx.totalFrames -- config.json 中的 totalFrames
ctx.frame       -- 当前整数帧
ctx.width       -- 当前画布逻辑宽度（CSS 像素）
ctx.height      -- 当前画布逻辑高度（CSS 像素）
ctx.pixelRatio  -- 当前设备像素比，可用于 shader 的物理像素 uniform
```

Lua VM 只开放 Base、Table、String、Math 库。只能加载 `render_graph`：

```lua
local rg = require("render_graph")
```

IO、OS、Debug、DOM、WebGL 对象和其他 Lua 模块均不可用。

## 2. 资源 API

### 2.1 Program

```lua
local program = rg.program("meshProgram", {
    vertex = "shaders/mesh.vert",
    fragment = "shaders/mesh.frag",
    vertexInputs = {
        position = "a_position",
    }
})
```

`vertex` 和 `fragment` 是虚拟文件路径，文件必须存在。`program()` 返回传入的名称字符串。

### 2.2 Vertex / Index Buffer

```lua
local positions = rg.vertexBuffer({
    data = { -0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0 },
    type = "float32",
    usage = "dynamic"
})

local indices = rg.indexBuffer({
    data = { 0, 1, 2 },
    type = "uint16"
})
```

Buffer descriptor 支持：

```text
data: number[]，不能为空且必须是有限数
type: float32 | uint8 | uint16 | uint32
usage: static | dynamic，默认 static
```

`indexBuffer()` 只能使用 `uint16` 或 `uint32`，数据必须是非负整数。返回值是 Buffer 句柄：

```lua
positions:setData(newData)              -- 仅 dynamic，长度不能超过声明长度
positions:updateRange(0, partialData)   -- 仅 dynamic
```

### 2.3 Mesh

```lua
local triangle = rg.mesh({
    vertexBuffers = {
        position = positions,
    },
    indexBuffer = indices,
    topology = "triangles",
    vertexCount = 3,
    indexCount = 3,
    attributes = {
        position = { components = 3, type = "float32" }
    }
})
```

支持的 `topology`：`triangles`、`triangle-strip`、`lines`。`vertexBuffers` 的 key 是 semantic，当前默认 semantic 布局为：

```text
position: 3 个分量
normal:   3 个分量
uv0:      2 个分量
color0:   4 个分量
```

也可以通过 `attributes` 指定 `components`、`type`、`normalized`、`stride`、`offset` 和实例步进 `divisor`。有 index buffer 时必须提供正整数 `indexCount`。

`mesh()` 返回 Mesh 句柄，供 `addDrawCell()` 使用。

### 2.4 Font 和 TextCell

字体资源使用浏览器字体栈名称，也可以保留 `source` 字段供项目字体资产管理器使用：

```lua
local font = rg.font("ui", {
    family = "Inter, system-ui, sans-serif",
    source = "fonts/Inter-Regular.ttf",
    fallback = { "emoji" },
    features = { "kern", "liga" },
    variations = { wght = 450 },
    atlas = { mode = "msdf", pageSize = 2048, padding = 8 }
})
```

`fallback` 是其他 `rg.font()` 资源的 ID；当主字体没有对应 glyph 时，运行时按顺序选择备用字体。`features` 使用 OpenType feature tag，`variations` 使用四字符 axis tag（例如 `wght`、`wdth`、`slnt`）。`atlas.mode` 支持 `bitmap`、`msdf` 和 `color`，`pageSize` 与 `padding` 控制图集分页。

文字通过 Target 的 `addTextCell()` 绘制。文字使用逻辑像素坐标，原点在目标左上角；字体图集由运行时生成并作为只读采样纹理绑定。

```lua
local title = screen:addTextCell("title", {
    font = font,
    text = "Render Graph 字体渲染",
    size = 42,
    position = { 40, 48 },
    color = { 0.45, 0.85, 1.0, 1.0 },
    lineHeight = 1.2,
    align = "left",
    blend = "premultiplied"
})
```

`TextCell` 支持 `setText()`、`setPosition()`、`setColor()`、`setStyle()` 和 `setEnabled()`。文字资源应在 `setup()` 中创建，`render()` 中只更新动态字段。`blend` 支持 `alpha`、`premultiplied` 和 `additive`。

### 2.4 Texture、RenderTarget、HistoryTarget

普通纹理：

```lua
local sceneColor = rg.texture("sceneColor", {
    width = "viewport",
    height = "viewport",
    format = "rgba8",
    depth = true,
    minFilter = "linear",
    magFilter = "linear",
    wrapS = "clamp-to-edge",
    wrapT = "clamp-to-edge"
})
```

纹理 descriptor 支持：

```text
width / height: 正数或 viewport
format: rgba8
depth: boolean
minFilter / magFilter: nearest | linear
wrapS / wrapT: clamp-to-edge | repeat | mirrored-repeat
```

如果资源需要作为 Pass 的输出，直接使用 `rg.renderTarget()`、`rg.historyTarget()` 或 `rg.accumulationTarget()`。这些 API 会创建目标并返回可添加 DrawCell 的 Target 句柄。

`renderTarget()` 会创建一个同名离屏目标，并返回 Target 句柄：

```lua
local target = rg.renderTarget("sceneColor", {
    width = "viewport",
    height = "viewport",
    format = "rgba8",
    depth = true
})
target:clear({ 0.02, 0.03, 0.05, 1.0 })
```

`historyTarget()` 用于读取过去帧，`capacity` 必须至少为 2：

```lua
local trail = rg.historyTarget("trail", {
    capacity = 16,
    width = "viewport",
    height = "viewport",
    format = "rgba8"
})
```

`accumulationTarget()` 用于双缓冲累积反馈。两者都返回可添加 DrawCell 的目标句柄。

屏幕是运行时预注册的保留资源，使用字符串 `"screen"`，没有 Lua API `rg.screen()`。

## 3. Target 和 DrawCell

```lua
local screen = rg.renderTarget("screen")

screen:clear({ 0, 0, 0, 1 })

local cell = screen:addDrawCell("copy", {
    mesh = quad,
    program = "copyProgram",
    textures = {
        u_input = "sceneColor"
    },
    uniforms = {
        u_tint = { type = "vec4", value = { 1, 1, 1, 1 } }
    }
})
```

Target API 会在内部生成一个 Render Pass。Target 句柄支持 `clear()` 和 `addDrawCell()`；DrawCell 的 `textures` 会自动建立对输入纹理的读取依赖。

```text
renderTarget(name, descriptor)
historyTarget(name, descriptor)
accumulationTarget(name, descriptor)
```

每个 Target 内部对应一个只写一个目标的 Render Pass。最终必须有 Target 写入 `screen`。当前 Lua SDK 不提供 `rg.pass()`。

DrawCell 的静态字段是 `mesh` 和 `program`。动态操作包括：

```lua
cell:setUniform("u_tint", { type = "vec4", value = { 1, 0.5, 0.2, 1 } })
cell:setTextures({ u_input = "sceneColor" })
cell:setEnabled(false)
cell:update({
    uniforms = { u_tint = { type = "vec4", value = { 1, 1, 1, 1 } } },
    textures = { u_input = "sceneColor" }
})
```

实例化绘制通过 `instanceCount` 开启。它会重复绘制同一个 Mesh，顶点 Shader 可以使用 WebGL2 的 `gl_InstanceID` 区分实例：

```lua
local instances = screen:addDrawCell("instances", {
    mesh = quad,
    program = "instancedProgram",
    instanceCount = 100
})
```

`instanceCount` 必须是正整数，也可以通过句柄更新：

```lua
instances:setInstanceCount(200)
```

如果 Mesh 的 attribute layout 设置了 `divisor = 1`，该 attribute 会按实例推进；默认 `divisor = 0`，按顶点推进。

纹理绑定值可以是纹理名，也可以是历史/累积引用：

```lua
cell:setTextures({
    u_previous = { name = "trail", offset = 1 }
})
```

`sampler2D` 的 history offset 必须在资源容量范围内；普通纹理使用字符串即可。

## 4. Uniform 类型

支持：

```text
float, vec2, vec3, vec4
int, ivec2, ivec3, ivec4
mat4
sampler2D
```

数组长度必须匹配类型，例如 `vec4` 必须有 4 个数、`mat4` 必须有 16 个数。sampler2D 应优先通过 `textures` 设置。

## 5. 编译校验

Graph 编译时会检查：

1. 输出资源存在且有生产者。
2. 每个 Pass 恰好写一个目标。
3. 资源名和 Pass ID 不重复。
4. 所有资源引用有效。
5. 一个资源不能有多个 Pass 生产者。
6. Pass 依赖不能形成环。
7. Mesh 的 Buffer、拓扑、数量和 attribute layout 有效。
8. DrawCell 的 Program 存在。
9. uniform 类型和值长度有效。
10. depth enabled 的 target 有 depth attachment。

## 6. 最小完整示例

```lua
local rg = require("render_graph")

local program = rg.program("program", {
    vertex = "shaders/mesh.vert",
    fragment = "shaders/mesh.frag",
    vertexInputs = { position = "a_position" }
})

local positions
local cell

function setup()
    positions = rg.vertexBuffer({
        data = { -0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0 },
        type = "float32",
        usage = "dynamic"
    })

    local mesh = rg.mesh({
        vertexBuffers = { position = positions },
        topology = "triangles",
        vertexCount = 3
    })

    local screen = rg.renderTarget("screen")
    cell = screen:addDrawCell("triangle", {
        mesh = mesh,
        program = "program"
    })

    return {}
end

function render(ctx, state)
    local x = math.sin(ctx.frame / ctx.FPS) * 0.2
    positions:setData({
        -0.5 + x, -0.5, 0,
         0.5 + x, -0.5, 0,
         0.0 + x,  0.5, 0
    })
end
```

## 7. 当前不支持

当前没有图片、视频、摄像头纹理，Blend、Stencil、Cull、MRT、MSAA 控制、Compute、GPU simulation 和自动相机矩阵。纹理格式目前只有 `rgba8`。

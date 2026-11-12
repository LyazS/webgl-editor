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

Lua VM 只开放 Base、Table、String、Math 库。`require("render_graph")` 用来加载 Render Graph SDK；项目内的其他 Lua 文件也可以通过 `require` 加载：

```lua
local rg = require("render_graph")
local animation = require("lib/animation") -- 对应 lib/animation.lua
-- 也支持 require("lib.animation")
```

模块路径相对于项目根目录，只能读取虚拟文件树中已有的 `.lua` 文件。省略 `.lua` 时运行时会自动补上；模块只执行一次并缓存返回值，模块应使用 `return` 返回表或其他值。模块之间的循环依赖会报错。路径不能以 `/` 开头，也不能包含 `.` 或 `..` 路径段。IO、OS、Debug、DOM、WebGL 对象和外部 Lua 模块均不可用。

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

字体统一使用二进制字体和 MSDF 渲染，不读取系统字体或 Canvas 字形。底层自带 Noto Sans SC Regular（含中文和拉丁字符，OFL 授权），不填 `source` 时使用该字体；`family` 仅作为资源说明，不会解析浏览器 CSS 字体栈。

```lua
-- 使用底层默认字体
local font = rg.font("ui")
-- 或指定虚拟文件系统中的二进制资产 / 可 fetch 的字体 URL
local custom = rg.font("custom", {
    family = "My Font",
    source = "fonts/MyFont-Regular.otf",
    features = { "kern", "liga" },
    atlas = { pageSize = 2048, padding = 2 }
})
```

`source` 支持独立 TTF/OTF，在首次 `render()` 前加载、校验；失败会报错，不会回退系统字体。`features` 是 HarfBuzz OpenType feature 字符串。字形图集固定使用 MSDF；`atlas.mode = "msdf"` 可兼容传入，其他模式会报错。`pageSize` 必须容纳 64px 字形及两侧 `padding`。字重和斜体请提供相应的静态字体文件；当前不支持 `weight`、`style`、`fallback`、`variations` 或彩色 emoji。

文字通过 Target 的 `addTextCell()` 绘制。文字使用逻辑像素坐标，原点在目标左上角；字体图集由运行时按 glyph ID 增量生成并作为只读采样纹理绑定。支持显式换行、按 shaping cluster 折行（`maxWidth`）、`align` 和 `anchor`。`lineHeight` 是字号倍数，`letterSpacing` 加在 cluster 之间。

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

`TextCell` 支持 `setText()`、`setPosition()`、`setColor()`、`setStyle()` 和 `setEnabled()`。文字资源应在 `setup()` 中创建，`render()` 中只更新动态字段。`blend` 支持 `alpha`、`premultiplied` 和 `additive`。 `setPosition()`、`setColor()` 复用 shaping 和布局，仅更新对应实例属性；字号或折行参数变化会更新局部几何，仍复用 shaping 和字形图集。连续 TextCell 在图集页与混合模式一致时自动合批，保留原始命令顺序。

### 2.5 Texture、RenderTarget、HistoryTarget

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

## SVG 与程序化矢量路径

SVG/Path 资源在首次 `render()` 前创建。无需自行声明 GLSL Program 或 Mesh：矢量编译器生成几何和合成子图，并通过当前 Target 的 VectorCell 绘制。

```lua
local art = rg.svg("art", { source = "assets/art.svg" })
-- 或 rg.svg("art", { data = [[<svg>...</svg>]], font = "my-font" })
local screen = rg.renderTarget("screen")
local cell = screen:addVectorCell("art", {
    svg = art, width = 720, height = 440,
    transform = { 1, 0, 0, 1, 0, 0 }, opacity = 1
})
```

`source` 和 `data` 必须且只能指定一个；`source` 指向虚拟文本文件。`strict` 默认 true，拒绝未支持的元素。`font` 使用 `rg.font()` 的字体名；含文字且没有指定 font 时使用项目内置 OTF。SVG 文字通过 HarfBuzz 字形轮廓生成矢量几何。`fonts` 可将 CSS 字体名（含可选 `:weight:style`）映射到 `rg.font()` 名称；文档内 @font-face 可加载 TTF/OTF/WOFF1。

程序化路径：

```lua
local path = rg.path({ d = "M0 0H100V100H0Z", fill = "#69d8c5", stroke = "white", strokeWidth = 2, fillRule = "nonzero" })
local shape = screen:addVectorCell("shape", { path = path })
```

资源句柄：`setAttribute(elementId, name, value)`、`setText(elementId, text)`、`hitTest(x,y,width,height)`、`getDiagnostics()`；路径额外提供 `setData(d)`。Cell：`setTransform(matrix6)`、`setOpacity(value)`、`setEnabled(value)`、`setViewport(width,height)`。矩阵为 SVG affine `{a,b,c,d,e,f}`，坐标为左上角起点的逻辑像素；width/height 控制 SVG 根 viewport，省略时使用所在 Target 的尺寸。

SVG 时钟动画由 `ctx.frame / ctx.FPS` 驱动。绘制顺序遵循同一 Target 中 Mesh、Text、Vector 命令的添加顺序；可绘制到普通、History、Accumulation Target。

SVG 的动态属性与叶子文字纳入 runtime checkpoint，seek 可跨重新编译恢复；`setText` 对包含 tspan/textPath 的容器要求更新其叶子，保持结构稳定。

完整参数、兼容范围、预算和测试见 [SVG_RENDERING.md](./SVG_RENDERING.md)。本实现没有承诺浏览器完整 SVG2 支持；脚本、foreignObject、浏览器级 CSS/段落排版、WOFF2 和事件驱动 SMIL 不在支持范围。

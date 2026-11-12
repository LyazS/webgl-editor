# 自研 SVG / 矢量渲染

本文记录实际实现和兼容范围。入口是 `src/core/vector/index.ts`；Lua 入口以 `src/core/runtime/lua-runtime.ts` 为准。没有新增 SVG、路径、三角化或渲染第三方依赖。XML 由浏览器 DOMParser 解析，文字复用项目现有 HarfBuzz 字体能力，普通位图由浏览器解码。

## 架构与数据合同

```text
SVG XML → 样式/引用/单位解析 → VectorNode 树
                                 ↑
Lua rg.path → SVG 路径资源 ────────┘
                                 ↓
VectorCompiler → VectorPlan（有 reads 的依赖图）
                                 ↓
VectorRenderer → WebGL2 三角形 / 画笔 shader / MSAA / 离屏合成
                                 ↓
父 Render Graph 当前 Target
```

- SVG 是保留文档，保留元素 ID、层级和 revision；静态文档缓存按 revision 和 viewport 区分。
- Path 是规范化的 M/L/Q/C/Z 指令。相对坐标、平滑控制点和椭圆弧在解析时展开。
- 自适应 De Casteljau 细分按变换的最大奇异值和目标像素比例选择误差档位，几何保持局部坐标。
- 填充沿顶点和边交点建立扫描带；带内按 winding 构造互不重叠的梯形三角形，支持孔洞与自交，不依赖轮廓朝向猜测。
- 描边先构造线段、端点、连接和虚线的轮廓，再对其区域求并后绘制，避免半透明描边的交叠处重复累加 Alpha。
- 画笔与几何缓存分离。位置、颜色更新可以复用已有 GPU Buffer；滤镜区域与蒙版矩形共享单位 Quad。
- 每个离屏层、裁剪、遮罩、滤镜结果都是 VectorPlan 中的显式资源和依赖；高斯模糊和 morphology 的两个方向也分别展开为 Pass。生成计划拓扑排序后执行。父 Render Graph 中使用 `vector` 命令，矢量子图保持独立命名空间，不违反父图的单一生产者约束。
- SVG 的绘制顺序与所在 Pass 的 Mesh/Text 命令顺序一致。整体透明度在分组绘制完成后应用。矢量绘制采用二维叠加，期间关闭深度测试，结束后恢复父状态。
- 中间纹理采用预乘 Alpha；填充/描边的颜色输入为普通 RGBA。默认开启最多 4 samples 的离屏 MSAA，并 resolve 成可采样纹理。
- 后端保存并恢复它修改的 framebuffer、viewport、program、VAO、buffer、纹理单元、深度、混合、裁剪与颜色写入状态。

## Lua API

资源和绘制实例在首次 `render()` 前创建；修改已有资源不创建新的 Graph 资源。

```lua
local rg = require("render_graph")
-- 其他项目内 Lua 逻辑也可以拆到文件中：require("lib/animation")
local art = rg.svg("art", { source = "assets/art.svg" })
-- 或 rg.svg("art", { data = [[<svg>...</svg>]] })
-- source/data 必须且只能指定一个。

local screen = rg.renderTarget("screen")
screen:clear({ 0, 0, 0, 1 })
local cell = screen:addVectorCell("art", {
  svg = art,
  width = 720,
  height = 440,
  transform = { 1, 0, 0, 1, 0, 0 },
  opacity = 1
})

function setup() return {} end
function render(ctx, state)
  cell:setTransform({ 1, 0, 0, 1, 20, 30 })
end
```

`rg.svg(name, descriptor)`：

- `source`：虚拟项目中的 SVG 文本路径。
- `data`：内联 SVG 文本。
- `font`：已经通过 `rg.font()` 声明的默认字体名。没有显式字体或可用 font-face 时，加载项目自带的 Noto Sans SC OTF。
- `fonts`：CSS 字体名到 `rg.font()` 名称的映射。键可以是 `Family`、`Family:700`、`Family:700:italic`；会选择匹配字体，随后在已注册字体中按 grapheme 覆盖能力 fallback。
- 文档 `@font-face` 的相对 URL 按 SVG 文件路径解析；支持 TTF、OTF，以及通过自研解包器读取的 WOFF1。src 中可跳过明确的 WOFF2 候选、选择后续支持格式。`local()` 使用调用方注册字体，不读取操作系统字体文件。
- `strict`：默认 true，遇到不支持的元素或事件处理属性时报错。false 时保留诊断并跳过不支持的元素。

文档句柄支持：

```lua
art:setAttribute("element-id", "fill", "#69d8c5")
art:setAttribute("element-id", "transform", "rotate(30 50 50)")
art:setAttribute("element-id", "d", "M0 0L100 0L50 80Z")
art:setText("text-element-id", "中文 ffi")
local ids = art:hitTest(40, 50, 720, 440)
local diagnostics = art:getDiagnostics()
```

`setText` 更新叶子 text/tspan 的直接文字，并保留动画等子节点；包含 tspan/textPath 的父元素需分别更新叶子，保持资源层级稳定。

`setAttribute` 支持更新现有元素；id、class、style、href、xmlns 和事件属性不能通过此接口更新。改变文档结构或上述属性需要修改源文件并重新编译。矩阵和路径语法立即校验，非法更新回滚。

`hitTest(x, y, width, height)` 在文档 viewport 坐标中返回从前到后的元素 ID，考虑填充、描边、变换及 clipPath；use 返回实例 ID，图片使用矩形区域。这是几何命中，不对文字空白、图片/渐变 Alpha、mask 和滤镜输出做像素级拾取。

程序化路径：

```lua
local path = rg.path({
  d = "M0 0C40 -60 100 -60 140 0V100H0Z",
  fill = "#69d8c5",
  stroke = "white",
  strokeWidth = 3,
  fillRule = "nonzero"
})
local cell = screen:addVectorCell("shape", { path = path })
-- render() 中：
path:setData("M0 0C40 -80 100 -80 140 0V100H0Z")
```

Path 句柄也支持 `setAttribute("path", ...)`；资源共享意味着修改路径或其样式会影响所有引用该资源的 Cell。

Cell 支持 `setTransform(matrix6)`、`setOpacity(0..1)`、`setEnabled(boolean)`、`setViewport(width, height)`。矩阵采用 SVG 的 `{a,b,c,d,e,f}`，逻辑像素坐标左上角为原点。viewport 控制根 SVG 的布局区域，不改变父 Target；未指定时使用父 Target 的逻辑尺寸。宽高必须为正且有限。

SVG 可绘制到普通、History 或 Accumulation Target，并被后续 Mesh sampler2D 使用。

## 实际兼容范围

| 领域 | 已实现 |
| --- | --- |
| 结构 | svg、g、a、switch、defs、symbol、use、本地引用与循环检测；忽略编辑器 metadata 和非 SVG 命名空间，接受没有内部实体的标准 DOCTYPE |
| 图形 | path 全部标准指令、rect/圆角、circle、ellipse、line、polyline、polygon |
| 坐标 | affine transform、viewBox、嵌套 viewport、preserveAspectRatio、常见绝对/相对单位 |
| 样式 | presentation attributes、inline style、style 规则、选择器匹配、继承、重要声明、currentColor、CSS 变量、calc/min/max/clamp、几何属性、二维 CSS 变换与 shape transform-origin |
| 填充/描边 | nonzero/evenodd、孔洞、自交、线宽、cap、join、miterLimit、dasharray、dashoffset、non-scaling-stroke |
| 画笔 | 纯色、线性/径向渐变、焦点与内圆、stop opacity、渐变继承、gradientTransform、pad/repeat/reflect、sRGB/linearRGB 渐变 |
| 图案/复用 | pattern、patternUnits/contentUnits、patternTransform、viewBox、href 继承、自适应 pattern 分辨率、marker 起点/中点/终点、context-fill/context-stroke、marker viewport 裁剪和 paint-order |
| 合成 | 分组/对象透明度、clipPath、objectBoundingBox clip、Alpha/luminance mask、mask 区域、标准混合模式 |
| 滤镜 | SourceGraphic/SourceAlpha/FillPaint/StrokePaint；GaussianBlur、Offset、Flood、ColorMatrix、Blend、Composite、Merge、ComponentTransfer、Morphology、DropShadow、ConvolveMatrix、DisplacementMap、Tile、Image、Turbulence、DiffuseLighting、SpecularLighting；result/in/in2、primitive 区域、默认区域并集和 filter 区域 |
| 滤镜颜色 | 默认 linearRGB，可通过 color-interpolation-filters 切换 sRGB；component transfer 支持 identity/linear/gamma/table/discrete |
| 文字 | TTF/OTF/WOFF1 font-face、字体家族/字重/字形选择、注册字体 fallback、variable axes、HarfBuzz shaping、矢量轮廓、合成粗体/斜体、text/tspan/textPath、横/竖排、定位/旋转列表、textLength、字距、锚点、连续渐变及 span 裁剪/遮罩/滤镜 |
| 图片 | PNG/JPEG/WebP/GIF/AVIF/BMP 解码、preserveAspectRatio；Lua 虚拟二进制图片资源按 SVG 相对路径解析 |
| 动态 | Lua 更新、时钟驱动 animate/animateTransform/animateMotion/set、repeatCount/repeatDur、freeze、keyTimes、linear/discrete/spline/paced |

该实现面向 Render Graph 的二维矢量绘制，兼容承诺以上表和测试为准，不等同于浏览器完整 SVG2/HTML 引擎。明确边界如下：

- 不执行 JavaScript、DOM 事件或 foreignObject，不加载外部 SVG 文档引用。内联 SVG 使用 svg/use，feImage 支持本地矢量片段和普通位图。
- CSS 支持 SVG 绘制所需的已列出属性；不提供完整浏览器级层叠、media/container 查询、CSS animation/transition 或 HTML/flowed-text 布局。颜色以解析器支持的 sRGB 颜色为准。
- 时钟动画由帧号驱动；事件/同步基准的 begin/end、accumulate、keyPoints，以及不同路径拓扑间的 morph 不在兼容范围。适配这些交互时使用 Lua 更新接口。
- 字体只来自明确加载/注册的二进制资源；不发现系统字体。WOFF2、TTC、彩色字体渲染及完整 Unicode 段落双向算法不在兼容范围；复杂多脚本文本应分 run 或提供相应字体和定位。
- 滤镜工作域为所在 Target 的 viewport，域外源像素不保留；需要更大绘制边界时，显式创建更大的离屏 Target，再采样到最终 Target。BackgroundImage/BackgroundAlpha 输入未接入父画布。
- 普通图片作为静态位图解码，GIF/WebP 等动画资源使用解码帧；没有视频/摄像头时间纹理接口。

遇到不支持的元素，严格模式拒绝导入；未列出的属性不能假定有效。解析器不是完整 SVG Schema 验证器。命中测试是几何接口，文件和 DOM 结构变化需要重新编译。

## 动态状态与 seek

`SvgDocument.snapshot()/restore()` 保存和恢复经更新 API 修改的属性与叶子文字；不会执行浏览器动画时钟。`LuaRenderRuntime.snapshotState()` 返回带版本标记的 checkpoint，包含 Lua 数据 state 和各 SVG 文档的动态状态。`restoreState()` 也接受旧式纯 Lua state 表。

编辑器 seek 会重新编译资源，并从 checkpoint 或首帧重放；SVG 动态状态可以跨重新编译恢复。Lua state 应存放可克隆的数据，资源句柄放在脚本级变量中；动态 Buffer 等其它资源沿用原有的恢复边界。不可直接修改 `document.xml` 来更新画面，否则不会触发 revision、缓存失效或 checkpoint 记录。

## 生命周期与预算

- CPU 几何缓存：最多 1024 项或 32 MB（含键）；GPU 几何缓存：最多 1024 项或 32 MB。
- 可复用空闲 Surface 池：64 MB；活动与空闲中间 Surface 合计：256 MB，超过时明确报错。
- 位图缓存：合计 64 MB，最多保留 64 张；梯度/transfer/kernel/noise 表缓存有数量上限；图片加载随 renderer 销毁取消。
- 交叉检测最多 1600 万次；填充最多 12000 条非水平边；路径细分最多 20 万个点；单次编译最多 256 个子图 Pass；文档/引用嵌套最多 64。
- 滤镜每个变换轴的 blur sigma/morphology radius 最多 128 逻辑像素且最多 512 个实际渲染像素。中间尺寸同时受 GPU MAX_TEXTURE_SIZE 限制。
- 文档最多 8 MB UTF-8、20000 个元素；文字最多 20000 个 UTF-16 code unit、10000 个 glyph，span 层级最多 64。WOFF1 重建大小最多 64 MB；超出预算报错。
- `VectorRenderer.render()` 内部串行化；同一个 GL context 的宿主绘制应 await 它完成。
- `VectorRenderer.destroy()` 幂等，释放 Buffer、纹理、Framebuffer、Renderbuffer、VAO、Program 和 Shader；页面销毁会调用它。编辑器监听 WebGL context loss/restore，恢复时重建后端并重放帧。

## 验证

```bash
npm test
npm run test:svg:browser
npm run build
```

浏览器测试启动独立临时 Chrome 配置目录，不操作用户的浏览器。macOS 自动查找 Chrome，Linux 自动查找 Chromium/Chrome，也可指定 `CHROME_BIN`。测试结束清理进程和临时目录。

`tests/vector.test.mjs` 验证几何面积、绕行规则、自交、曲线精度、描边、CSS 数学、噪声表和依赖排序；`tests/svg-font.test.mjs` 验证 WOFF1 各表、全字体 checksum 和 axis 实例隔离。`tests/svg-browser.ts` 使用浏览器原生 SVG 作为测试参照，比较预乘 RGBA；允许边缘抗锯齿差异，另验证 Lua、文字轮廓、动画 seek、几何命中、状态恢复、静态帧上传、GPU 资源释放以及编辑器真实 context loss/restore。生产路径不调用浏览器 SVG 图片渲染。

编辑器下拉菜单提供“SVG · 自研矢量渲染”和“Path · 动态矢量路径”。综合示例源文件为 `src/examples/vector/main.lua`，对应资源位于同一项目根目录的 `src/examples/vector/assets/showcase.svg`。

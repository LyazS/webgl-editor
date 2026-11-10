# Mesh / Vertex Buffer 能力说明

本文档记录当前已经实现的 Mesh、Vertex Buffer、Index Buffer 和 WebGL VAO 链路。它不再描述未来方案。

## 1. 当前资源模型

当前 Lua 资源链路为：

~~~text
Lua Buffer 句柄
  → RenderGraph BufferResource
  → Lua Mesh 句柄
  → MeshResource
  → WebGLBuffer / VertexArrayObject
  → drawArrays 或 drawElements
~~~

Lua 不接触 WebGL 对象。Mesh 是逻辑资源，负责组合 vertex buffer、index buffer、topology、数量和 attribute layout。

## 2. Lua API

### 2.1 Vertex / Index Buffer

~~~lua
local positions = rg.vertexBuffer({
    data = {
        -0.6, -0.5, 0.0,
         0.6, -0.5, 0.0,
         0.0,  0.6, 0.0
    },
    type = "float32",
    usage = "dynamic"
})

local indices = rg.indexBuffer({
    data = { 0, 1, 2 },
    type = "uint16"
})
~~~

当前 Buffer 类型为 `float32`、`uint8`、`uint16`、`uint32`。Index Buffer 不能使用 `float32` 或 `uint8`，索引必须是非负整数。

Buffer API 不接收用户自定义名称，返回句柄：

~~~lua
positions:setData(newData)
positions:updateRange(offset, partialData)
~~~

只有 `usage = "dynamic"` 的 Buffer 可以更新，更新不能超出初始数组大小。

### 2.2 Mesh

~~~lua
local triangle = rg.mesh({
    vertexBuffers = {
        position = positions,
        uv0 = uvs,
        color0 = colors
    },
    indexBuffer = indices,
    topology = "triangles",
    vertexCount = 3,
    indexCount = 3,
    attributes = {
        color0 = {
            components = 4,
            type = "uint8",
            normalized = true
        }
    }
})
~~~

支持的 topology：

~~~text
triangles
triangle-strip
lines
~~~

默认 attribute layout：

~~~text
position: 3 components
normal:   3 components
uv0:      2 components
color0:   4 components
~~~

每个 semantic 也可以通过 `attributes` 指定：

~~~text
components: 1..4
type: 与 Buffer type 一致
normalized: boolean
stride: 非负整数
offset: 非负整数
~~~

没有 index buffer 时执行 `drawArrays`；有 index buffer 时执行 `drawElements`。

DrawCell 可以通过 `instanceCount` 启用实例化绘制：

```lua
screen:addDrawCell("instances", {
    mesh = quad,
    program = "instancedProgram",
    instanceCount = 100
})
```

WebGL2 后端根据 `instanceCount` 调用 `drawArraysInstanced` 或 `drawElementsInstanced`。顶点 Shader 可以通过 `gl_InstanceID` 计算实例位置；attribute layout 的 `divisor = 1` 可用于绑定逐实例属性。

## 3. Program 与 attribute 映射

~~~lua
local program = rg.program("meshProgram", {
    vertex = "shaders/mesh.vert",
    fragment = "shaders/mesh.frag",
    vertexInputs = {
        position = "a_position",
        uv0 = "a_uv"
    }
})
~~~

默认映射为：

~~~text
position → a_position
normal   → a_normal
uv0      → a_uv0
color0   → a_color0
~~~

显式 `vertexInputs` 会覆盖默认值。Shader 必须声明对应的 WebGL2 GLSL attribute。

## 4. DrawCell

Mesh 不直接绘制，必须通过 Pass 的 DrawCell：

~~~lua
local screen = rg.renderTarget("screen")

local cell = screen:addDrawCell("triangle", {
    mesh = triangle,
    program = "meshProgram"
})
~~~

DrawCell 创建后可以在 `render()` 中修改：

~~~lua
cell:setUniform("u_transform", {
    type = "mat4",
    value = {
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1
    }
})

cell:setEnabled(false)
~~~

Mesh 和 Program 属于静态绑定，应在脚本加载阶段或 `setup()` 中确定。

## 5. Graph 校验

Graph 编译时会检查：

- Mesh 至少有一个 vertex buffer。
- semantic 对应的 Buffer 必须是 vertex Buffer。
- indexBuffer 必须是 index Buffer。
- `vertexCount` 必须是正整数。
- 使用 indexBuffer 时 `indexCount` 必须是正整数。
- attribute components 必须在 1 到 4 之间。
- attribute type 必须和 Buffer type 一致。
- Program 必须存在。
- shader attribute 必须能匹配 Mesh semantic。

## 6. 当前边界

当前没有 GPU simulation、自动相机矩阵、复杂几何体生成、GPU Compute、Blend/Cull/Stencil 状态和更高级的顶点格式。资源生命周期和 VAO 会缓存，但没有自动 aliasing 或临时 Buffer 复用。

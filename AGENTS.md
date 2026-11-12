# AGENTS.md

## 项目定位

这是一个 Vue 3 + Vite 的浏览器端 WebGL2 Render Graph 原型。Lua 通过 Wasmoon 构建 Render Graph，WebGL2 执行离屏纹理、Mesh 和多 Pass 绘制。

## 常用命令

- `npm run dev`：启动开发服务器。
- `npm run typecheck`：运行 TypeScript 类型检查。
- `npm run build`：类型检查并构建生产包。

## 代码与文档约定

- Lua 运行时的权威实现是 `src/core/runtime/lua-runtime.ts`。
- Graph 类型、资源校验和拓扑排序位于 `src/core/render-graph/`。
- Lua 资源和 Target 在第一次 `render()` 前创建（通常放在脚本加载阶段或 `setup()`）；`render(ctx, state)` 只更新动态数据。Render Pass 只作为内部 Graph IR 存在。
- coding agent 编写 Lua 渲染脚本时先读 `docs/LUA_RENDERING_AGENT_GUIDE.md`；完整 Lua API 以 `docs/LUA_RENDER_GRAPH_LANGUAGE.md` 为准，能力清单以 `docs/RENDER_GRAPH_CAPABILITIES.md` 为准。
- 修改 Lua API 时，必须同时检查运行时、App 示例和 `docs/` 中受影响的现行文档。
- 修改后至少运行 `npm run build`。

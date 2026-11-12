# 文档入口

这里的文档只保留当前实现的使用合同和能力边界。未来设计、已完成的方案讨论和一次性开发笔记不放在 `docs/`。

## 按任务阅读

| 任务 | 文档 |
| --- | --- |
| 让 coding agent 编写或修改 Lua 渲染脚本 | [LUA_RENDERING_AGENT_GUIDE.md](./LUA_RENDERING_AGENT_GUIDE.md) |
| 查完整 Lua API 和参数 | [LUA_RENDER_GRAPH_LANGUAGE.md](./LUA_RENDER_GRAPH_LANGUAGE.md) |
| 查看项目当前能力、限制和文件合同 | [RENDER_GRAPH_CAPABILITIES.md](./RENDER_GRAPH_CAPABILITIES.md) |
| 编写 SVG 或程序化路径脚本 | [SVG_RENDERING.md](./SVG_RENDERING.md) |
| 让浏览器 Agent 读取某一帧画布 | [AGENT_CANVAS_API.md](./AGENT_CANVAS_API.md) |

`src/core/runtime/lua-runtime.ts` 是 Lua 运行时的实现真相；文档与代码不一致时，以代码为准，并同步修正上述现行文档。

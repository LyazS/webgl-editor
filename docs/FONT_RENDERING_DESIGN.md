# Font Rendering Design

字体不是 DOM 覆盖层，而是 Render Graph 中的独立资源和绘制命令。当前实现由 `FontResource`、`TextLayoutResource` 和 `DrawTextCommand` 组成。

```text
Lua font/text cell
  → TextLayoutResource
  → Canvas alpha glyph atlas (R8)
  → instanced quad
  → WebGL2 text shader
  → premultiplied alpha blend
```

`TextCell` 使用左上角原点的逻辑像素坐标，执行器根据当前目标尺寸转换为 NDC。文字命令保留在目标 Pass 的命令序列中，因此可以绘制到屏幕、普通 RenderTarget、HistoryTarget 和 AccumulationTarget，并参与后续采样和后处理。

字体资源支持 `fallback` 字体链、OpenType `features`、variable font `variations` 和 `atlas` 配置。带有二进制 `source` 的字体使用 HarfBuzz WASM 做 shaping，并由 msdfgen WASM 生成 MSDF glyph；`color` 模式使用字体的彩色 PNG glyph，图集按 `pageSize` 自动分页。没有二进制数据的开发环境字体仍使用浏览器字体栈作为兼容回退。图集资源保持在 TextRenderer 内部，Render Graph 只保存稳定的 Font/TextLayout 引用。

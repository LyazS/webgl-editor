# Agent 画布读取 API

页面挂载后会在 `window` 上暴露 `renderGraphAgent`，供浏览器 Agent 直接读取某一帧最终写入 `screen` 的画布内容：

```js
const capture = await window.renderGraphAgent.captureFrame(42)
// {
//   frame: 42,
//   width: 1280,
//   height: 720,
//   mimeType: "image/png",
//   dataUrl: "data:image/png;base64,..."
// }
```

`captureFrame(frame)` 会先把确定性时间线定位到指定帧，再捕获最后一个写入 `screen` 的 Pass。返回的 `dataUrl` 是可以直接交给视觉模型或浏览器 Agent 的 PNG。尺寸是 WebGL backing store 的像素尺寸，包含设备像素比；它可能大于 CSS 画布尺寸。

需要做程序化像素检查时可以请求 RGBA8 数据：

```js
const capture = await window.renderGraphAgent.captureFrame(42, { includePixels: true })
// capture.pixels: top-to-bottom rows, 4 values per pixel (R, G, B, A)
```

`frame` 必须是 `[0, totalFrames - 1]` 内的整数。捕获会暂停播放，并把编辑器时间线停在请求的帧；多个捕获请求会按调用顺序串行执行。


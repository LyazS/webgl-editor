local rg = require("render_graph")

local textCell

function setup()
  local font = rg.font("ui", { family = "Noto Sans SC" })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.015, 0.02, 0.045, 1.0 })
  textCell = screen:addTextCell("title", {
    font = font,
    text = "Render Graph 字体渲染",
    size = 42,
    position = { 40, 44 },
    color = { 0.45, 0.85, 1.0, 1.0 },
    lineHeight = 1.2,
    blend = "premultiplied"
  })
  return {}
end

function render(ctx, state)
  textCell:setText("Render Graph · Frame " .. ctx.frame)
  textCell:setPosition({ 40, 44 + math.sin(ctx.frame / ctx.FPS * 2.0) * 8 })
end
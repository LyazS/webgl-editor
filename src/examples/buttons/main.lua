local rg = require("render_graph")

local uiProgram = rg.program("buttonShowcase", {
  vertex = "shaders/buttons.vert",
  fragment = "shaders/buttons.frag",
  vertexInputs = { position = "a_position" }
})

local uiCell
local titleCell
local labels = {}
local designWidth, designHeight = 872, 550

local function place(cell, x, y, size, scale, ox, oy)
  cell:setPosition({ ox + x * scale, oy + y * scale })
  cell:setStyle({ size = size * scale })
end

function setup()
  local font = rg.font("button-ui", { family = "Noto Sans SC" })
  local positions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  local quad = rg.mesh({ vertexBuffers = { position = positions }, topology = "triangle-strip", vertexCount = 4 })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.067, 0.063, 0.078, 1.0 })
  uiCell = screen:addDrawCell("button-background", { mesh = quad, program = "buttonShowcase" })

  titleCell = screen:addTextCell("button-title", { font = font, text = "次次要按钮", size = 38, position = { 82, 73 }, color = { 0.91, 0.90, 0.93, 1.0 }, blend = "premultiplied" })
  local texts = {
    { "Default", 110, 181, 30, { 0.86, 0.85, 0.88, 1.0 } }, { "Primary", 285, 181, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Info", 467, 181, 30, { 0.43, 0.77, 0.95, 1.0 } }, { "Success", 598, 181, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Warning", 110, 265, 30, { 0.96, 0.79, 0.42, 1.0 } }, { "Error", 298, 265, 30, { 0.95, 0.47, 0.51, 1.0 } },
    { "Default", 450, 265, 30, { 0.86, 0.85, 0.88, 1.0 } }, { "Primary", 640, 265, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Info", 116, 349, 30, { 0.43, 0.77, 0.95, 1.0 } }, { "Success", 263, 349, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Warning", 470, 349, 30, { 0.96, 0.79, 0.42, 1.0 } }, { "Error", 675, 349, 30, { 0.95, 0.47, 0.51, 1.0 } }
  }
  for i, item in ipairs(texts) do
    labels[i] = screen:addTextCell("label" .. i, { font = font, text = item[1], size = item[4], position = { item[2], item[3] }, color = item[5], blend = "premultiplied" })
  end
  return {}
end

function render(ctx, state)
  local scale = math.min(ctx.width / designWidth, ctx.height / designHeight)
  local ox = (ctx.width - designWidth * scale) * 0.5
  local oy = (ctx.height - designHeight * scale) * 0.5
  uiCell:setUniform("u_resolution", { type = "vec2", value = { ctx.width * (ctx.pixelRatio or 1), ctx.height * (ctx.pixelRatio or 1) } })
  place(titleCell, 82, 73, 38, scale, ox, oy)
  local positions = {
    { 110, 181, 30 }, { 285, 181, 30 }, { 467, 181, 30 }, { 598, 181, 30 },
    { 110, 265, 30 }, { 298, 265, 30 }, { 450, 265, 30 }, { 640, 265, 30 },
    { 116, 349, 30 }, { 263, 349, 30 }, { 470, 349, 30 }, { 675, 349, 30 }
  }
  for i, item in ipairs(positions) do place(labels[i], item[1], item[2], item[3], scale, ox, oy) end
end
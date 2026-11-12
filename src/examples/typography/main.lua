local rg = require("render_graph")

local program = rg.program("typography", {
  vertex = "shaders/typography.vert",
  fragment = "shaders/typography.frag",
  vertexInputs = { position = "a_position" }
})
local backgroundCell
local texts = {}
local designWidth, designHeight = 1740, 1042

local function place(cell, x, y, size, scale, ox, oy)
  cell:setPosition({ ox + x * scale, oy + y * scale })
  cell:setStyle({ size = size * scale })
end

function setup()
  local font = rg.font("typography-ui", { family = "Noto Sans SC" })
  local positions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local quad = rg.mesh({ vertexBuffers = { position = positions }, topology = "triangle-strip", vertexCount = 4 })
  local textLayer = rg.renderTarget("textLayer")
  textLayer:clear({ 0.0, 0.0, 0.0, 0.0 })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.063, 0.059, 0.075, 1.0 })
  backgroundCell = screen:addDrawCell("background", { mesh = quad, program = "typography", textures = { u_text = "textLayer" } })

  texts[1] = textLayer:addTextCell("basic-title", { font=font, text="基础用法", size=38, position={80,78}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[2] = textLayer:addTextCell("basic-body", { font=font, text="它有不同的类型。", size=28, position={80,174}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[3] = textLayer:addTextCell("basic-error", { font=font, text="炸了", size=30, position={80,250}, color={.96,.32,.38,1}, blend="premultiplied" })
  texts[4] = textLayer:addTextCell("basic-info", { font=font, text="噢", size=30, position={80,294}, color={.25,.62,.86,1}, blend="premultiplied" })
  texts[5] = textLayer:addTextCell("basic-warning", { font=font, text="注意", size=30, position={80,338}, color={1,.58,.08,1}, blend="premultiplied" })
  texts[6] = textLayer:addTextCell("basic-success", { font=font, text="成了", size=30, position={80,382}, color={.18,.76,.58,1}, blend="premultiplied" })

  texts[7] = textLayer:addTextCell("size-title", { font=font, text="尺寸", size=38, position={940,78}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[8] = textLayer:addTextCell("size-body", { font=font, text="其实用 CSS 也挺方便的。", size=28, position={940,174}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[9] = textLayer:addTextCell("live-blue", { font=font, text="Live Forever", size=72, position={940,273}, color={.29,.62,.86,1}, blend="premultiplied" })
  texts[10] = textLayer:addTextCell("live-red", { font=font, text="Live Forever", size=72, position={940,387}, color={.88,.28,.37,1}, blend="premultiplied" })
  texts[11] = textLayer:addTextCell("married", { font=font, text="Married with Children", size=48, position={940,491}, color={1,.58,.08,1}, blend="premultiplied" })
  texts[12] = textLayer:addTextCell("ussr", { font=font, text="Back in the USSR", size=48, position={940,568}, color={.22,.78,.63,1}, blend="premultiplied" })

  texts[13] = textLayer:addTextCell("custom-title", { font=font, text="定制", size=38, position={80,548}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[14] = textLayer:addTextCell("custom-body", { font=font, text="靠你了。", size=28, position={80,643}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[15] = textLayer:addTextCell("custom-one", { font=font, text="定制颜色", size=48, position={80,726}, color={.55,.54,.57,1}, blend="premultiplied" })
  texts[16] = textLayer:addTextCell("custom-two", { font=font, text="定制颜色", size=48, position={80,807}, color={.55,.54,.57,1}, blend="premultiplied" })
  texts[17] = textLayer:addTextCell("rainbow-text", { font=font, text="瞎写的颜色", size=48, position={80,883}, color={.88,.88,.88,1}, blend="premultiplied" })
  return {}
end

function render(ctx, state)
  local scale = math.min(ctx.width / designWidth, ctx.height / designHeight)
  local ox = (ctx.width - designWidth * scale) * 0.5
  local oy = (ctx.height - designHeight * scale) * 0.5
  backgroundCell:setUniform("u_resolution", { type="vec2", value={ctx.width * (ctx.pixelRatio or 1), ctx.height * (ctx.pixelRatio or 1)} })
  local positions = {
    {80,78,38},{80,174,28},{80,250,30},{80,294,30},{80,338,30},{80,382,30},
    {940,78,38},{940,174,28},{940,273,72},{940,387,72},{940,491,48},{940,568,48},
    {80,548,38},{80,643,28},{80,726,48},{80,807,48},{80,883,48}
  }
  for i, item in ipairs(positions) do place(texts[i], item[1], item[2], item[3], scale, ox, oy) end
end
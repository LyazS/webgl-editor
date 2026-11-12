local rg = require("render_graph")
local svg = rg.svg("showcase", { source = "assets/showcase.svg" })
local screen = rg.renderTarget("screen")
screen:clear({ 0.025, 0.035, 0.06, 1 })
local cell = screen:addVectorCell("showcase", { svg = svg, width = 720, height = 440 })
function setup() return {} end
function render(ctx, state)
  local s = math.min(ctx.width / 760, ctx.height / 480)
  cell:setTransform({ s, 0, 0, s, (ctx.width - 720 * s) / 2, (ctx.height - 440 * s) / 2 })
end
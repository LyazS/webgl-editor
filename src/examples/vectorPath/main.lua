local rg = require("render_graph")
local animation = require("animation")
local path = rg.path({ d = "M0 0H100V100H0Z", fill = "#69d8c5", stroke = "#c4fbef", strokeWidth = 3 })
local screen = rg.renderTarget("screen")
screen:clear({ 0.025, 0.035, 0.06, 1 })
local cell = screen:addVectorCell("path", { path = path })
function setup() return {} end
function render(ctx, state)
  animation.update(path, cell, ctx)
end

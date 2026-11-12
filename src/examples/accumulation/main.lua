local rg = require("render_graph")

local accumProgram = rg.program("accumProgram", { vertex="shaders/feedback.vert", fragment="shaders/accum.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local copyProgram = rg.program("copyProgram", { vertex="shaders/copy.vert", fragment="shaders/copy.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local accumulationCell

function setup()
  local quadPositions = rg.vertexBuffer({ data={-1,-1,0, 1,-1,0, -1,1,0, 1,1,0}, type="float32" })
  local quadUvs = rg.vertexBuffer({ data={0,0, 1,0, 0,1, 1,1}, type="float32" })
  local quad = rg.mesh({ vertexBuffers={position=quadPositions, uv0=quadUvs}, topology="triangle-strip", vertexCount=4 })
  local accumulation = rg.accumulationTarget("paint", { width="viewport", height="viewport", format="rgba8" })
  accumulationCell = accumulation:addDrawCell("accumulate", { mesh=quad, program="accumProgram", textures={ u_previous={name="paint", offset=1} } })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="paint" } })
  return {}
end

function render(ctx, state)
  local x = 0.5 + math.sin(ctx.frame / ctx.FPS * 1.5) * 0.35
  local y = 0.5 + math.cos(ctx.frame / ctx.FPS * 1.2) * 0.25
  accumulationCell:setUniform("u_center", { type="vec2", value={x,y} })
end
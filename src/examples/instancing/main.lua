local rg = require("render_graph")

local instancedProgram = rg.program("instancedProgram", {
  vertex = "shaders/instanced.vert",
  fragment = "shaders/instanced.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local instanceCell

function setup()
  local positions = rg.vertexBuffer({
    data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 },
    type = "float32"
  })
  local uvs = rg.vertexBuffer({
    data = { 0,0, 1,0, 0,1, 1,1 },
    type = "float32"
  })
  local quad = rg.mesh({
    vertexBuffers = { position = positions, uv0 = uvs },
    topology = "triangle-strip",
    vertexCount = 4
  })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.015, 0.02, 0.045, 1.0 })
  instanceCell = screen:addDrawCell("instances", {
    mesh = quad,
    program = "instancedProgram",
    instanceCount = 100
  })
  return {}
end

function render(ctx, state)
  instanceCell:setUniform("u_time", {
    type = "float",
    value = ctx.frame / ctx.FPS
  })
end
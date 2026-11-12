local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = { position = "a_position", normal = "a_normal", uv0 = "a_uv", color0 = "a_color" }
})
local copyProgram = rg.program("copyProgram", {
  vertex = "shaders/copy.vert",
  fragment = "shaders/copy.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local positions
local triangleCell

function setup()
  positions = rg.vertexBuffer({ data = { -0.58, -0.38, 0, 0.58, -0.38, 0, 0, 0.58, 0 }, type = "float32", usage = "dynamic" })
  local normals = rg.vertexBuffer({ data = { 0,0,1, 0,0,1, 0,0,1 }, type = "float32" })
  local uvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0.5,1 }, type = "float32" })
  local colors = rg.vertexBuffer({ data = { 255,80,80,255, 80,220,255,255, 180,100,255,255 }, type = "uint8" })
  local indices = rg.indexBuffer({ data = { 0,1,2 }, type = "uint16" })
  local quadPositions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local quadUvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0,1, 1,1 }, type = "float32" })
  local triangle = rg.mesh({ vertexBuffers = { position=positions, normal=normals, uv0=uvs, color0=colors }, indexBuffer=indices, topology="triangles", vertexCount=3, indexCount=3, attributes={ color0={components=4,type="uint8",normalized=true} } })
  local quad = rg.mesh({ vertexBuffers = { position=quadPositions, uv0=quadUvs }, topology="triangle-strip", vertexCount=4 })
  local target = rg.renderTarget("sceneColor", { width="viewport", height="viewport", format="rgba8", depth=true })
  target:clear({ 0.02, 0.03, 0.05, 1.0 })
  triangleCell = target:addDrawCell("triangle", { mesh=triangle, program="meshProgram" })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="sceneColor" } })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.3
  positions:setData({ -0.58+offset,-0.38,0, 0.58+offset,-0.38,0, 0+offset,0.58,0 })
  triangleCell:setUniform("u_transform", { type="mat4", value={1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1} })
  triangleCell:setUniform("u_tint", { type="vec4", value={1,1,1,1} })
end
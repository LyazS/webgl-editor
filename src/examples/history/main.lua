local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = {
    position = "a_position",
    normal = "a_normal",
    uv0 = "a_uv",
    color0 = "a_color"
  }
})

local lineProgram = rg.program("lineProgram", {
  vertex = "shaders/line.vert",
  fragment = "shaders/line.frag"
})

local feedbackProgram = rg.program("feedbackProgram", {
  vertex = "shaders/feedback.vert",
  fragment = "shaders/feedback.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})

local positions
local normals
local uvs
local colors
local indices
local linePositions
local quadPositions
local quadUvs
local trailCell
local screenCell
local lineCell

function setup()
  positions = rg.vertexBuffer({
    data = {
      -0.58, -0.38, -0.2,
       0.58, -0.38, -0.2,
       0.0,  0.58, -0.2
    },
    type = "float32",
    usage = "dynamic"
  })
  normals = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 0, 0, 1 },
    type = "float32"
  })
  uvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0.5, 1 },
    type = "float32"
  })
  colors = rg.vertexBuffer({
    data = { 255, 80, 80, 255, 80, 220, 255, 255, 180, 100, 255, 255 },
    type = "uint8"
  })
  indices = rg.indexBuffer({ data = { 0, 1, 2 }, type = "uint16" })
  linePositions = rg.vertexBuffer({
    data = { -0.9, -0.78, 0.1, 0.9, -0.78, 0.1 },
    type = "float32"
  })
  quadPositions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  quadUvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 1, 1 },
    type = "float32"
  })

  local triangle = rg.mesh({
    vertexBuffers = { position = positions, normal = normals, uv0 = uvs, color0 = colors },
    indexBuffer = indices,
    topology = "triangles",
    vertexCount = 3,
    indexCount = 3,
    attributes = { color0 = { components = 4, type = "uint8", normalized = true } }
  })
  local line = rg.mesh({
    vertexBuffers = { position = linePositions },
    topology = "lines",
    vertexCount = 2
  })
  local screenQuad = rg.mesh({
    vertexBuffers = { position = quadPositions, uv0 = quadUvs },
    topology = "triangle-strip",
    vertexCount = 4
  })

  local trail = rg.historyTarget("trail", {
    capacity = 16,
    width = "viewport",
    height = "viewport",
    format = "rgba8"
  })
  trail:clear({ 0.0, 0.0, 0.0, 1.0 })
  trailCell = trail:addDrawCell("trailCell", { mesh = triangle, program = meshProgram })

  local screen = rg.renderTarget("screen")
  screen:clear({ 0.025, 0.035, 0.06, 1.0 })
  screenCell = screen:addDrawCell("screenCell", {
    mesh = screenQuad,
    program = feedbackProgram,
    textures = {
      u_history1 = { name = "trail", offset = 1 },
      u_history2 = { name = "trail", offset = 2 },
      u_history3 = { name = "trail", offset = 3 },
      u_history4 = { name = "trail", offset = 4 },
      u_history5 = { name = "trail", offset = 5 },
      u_history6 = { name = "trail", offset = 6 },
      u_history7 = { name = "trail", offset = 7 },
      u_history8 = { name = "trail", offset = 8 }
    }
  })
  lineCell = screen:addDrawCell("lineCell", { mesh = line, program = lineProgram })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.32
  positions:setData({
    -0.58 + offset, -0.38, -0.2,
     0.58 + offset, -0.38, -0.2,
     0.0 + offset,  0.58, -0.2
  })
  trailCell:setUniform("u_transform", {
    type = "mat4",
    value = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }
  })
  trailCell:setUniform("u_tint", { type = "vec4", value = { 1, 1, 1, 1 } })
  lineCell:setUniform("u_color", { type = "vec4", value = { 0.95, 0.82, 0.25, 1.0 } })
end
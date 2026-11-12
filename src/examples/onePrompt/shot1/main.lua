local rg = require("render_graph")
local M = {}
local geometry = require("shot1/lib/geometry")
local animation = require("shot1/lib/animation")

local W, H = 1920, 1080
local B = 60 / 122
local T1 = 0.10
local TLINE = 0.54
local DOWN = 0.102 + 2 * B
local HIT = 0.102 + 4 * B

local unfoldProgram = rg.program("unfoldProgram", {
  vertex = "shared/shaders/fullscreen.vert",
  fragment = "shot1/shaders/unfold.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local compositeProgram = rg.program("compositeProgram", {
  vertex = "shared/shaders/fullscreen.vert",
  fragment = "shot1/shaders/composite.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local montageProgram = rg.program("montageProgram", {
  vertex = "shot1/shaders/montage.vert",
  fragment = "shot1/shaders/montage.frag",
  vertexInputs = { position = "a_position" }
})

local quad
local backgroundCell
local wordOne
local wordLine
local montageCell
local montagePositions
local finalCell
local montageId
local montageFrames
local footer

local rgba = animation.rgba
local icons = geometry.makeIcons()

function M.setup(outputTarget)
  local positions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  local uvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 1, 1 },
    type = "float32"
  })
  local empty = {}
  for i=1,2400 do empty[i] = 2 end
  montagePositions = rg.vertexBuffer({ data = empty, type = "float32", usage = "dynamic" })
  quad = rg.mesh({
    vertexBuffers = { position = positions, uv0 = uvs },
    topology = "triangle-strip",
    vertexCount = 4
  })
  local montageMesh = rg.mesh({ vertexBuffers = { position = montagePositions }, topology = "lines", vertexCount = 800 })

  local font = rg.font("archivo", { family = "Archivo Black Condensed", source = "/fonts/Archivo-Black-Condensed.ttf" })
  local scene = rg.renderTarget("sceneColor", { width = "viewport", height = "viewport", format = "rgba8" })
  scene:clear({ 0.0392, 0.0392, 0.0431, 1 })
  backgroundCell = scene:addDrawCell("unfold-background", {
    mesh = quad,
    program = unfoldProgram,
    uniforms = {
      u_time = { type = "float", value = 0 },
      u_width = { type = "float", value = W },
      u_height = { type = "float", value = H },
      u_first_word = { type = "float", value = 0.10 },
      u_second_word = { type = "float", value = 0.54 },
      u_downbeat = { type = "float", value = DOWN },
      u_hit = { type = "float", value = HIT },
    }
  })
  montageCell = scene:addDrawCell("rewind-montage", { mesh = montageMesh, program = montageProgram, uniforms = { u_color = { type="vec4", value={0.93,0.91,0.87,1} } } })

  local screen = outputTarget or rg.renderTarget("screen")
  screen:clear({ 0.0392, 0.0392, 0.0431, 1 })
  finalCell = screen:addDrawCell("unfold-composite", {
    mesh = quad,
    program = compositeProgram,
    textures = { u_input = "sceneColor" },
    uniforms = {
      u_time = { type = "float", value = 0 },
      u_width = { type = "float", value = W },
      u_height = { type = "float", value = H }
    }
  })
  wordOne = screen:addTextCell("word-one", {
    font = font, text = "One", size = 150, position = { 316, 540 },
    color = rgba(0.93, 0.91, 0.87, 1), anchor = "baseline", blend = "premultiplied"
  })
  wordLine = screen:addTextCell("word-line", {
    font = font, text = "line", size = 150, position = { 316, 540 },
    color = rgba(0.93, 0.91, 0.87, 1), anchor = "baseline", blend = "premultiplied"
  })
  local mono = rg.font("mono", { family = "IBM Plex Mono", source = "/fonts/IBMPlexMono-Medium.ttf" })
  montageId = screen:addTextCell("montage-id", { font=mono, text="", size=14, position={300,596}, color=rgba(0.93,0.91,0.87,0), anchor="top-left", blend="premultiplied" })
  montageFrames = screen:addTextCell("montage-frames", { font=mono, text="", size=14, position={300,620}, color=rgba(1,.35,.12,0), anchor="top-left", blend="premultiplied" })
  footer = screen:addTextCell("montage-footer", { font=mono, text="REEL 1 · UNWINDING · 1 PROMPT · 16 PLATES", size=13, position={96,1012}, color=rgba(.55,.52,.48,.7), anchor="top-left", blend="premultiplied" })
  return {}
end

function M.render(ctx, state)
  local t = ctx.frame / ctx.FPS
  local active = ctx.active ~= false
  backgroundCell:setEnabled(active); finalCell:setEnabled(active); wordOne:setEnabled(active); wordLine:setEnabled(active)
  montageCell:setEnabled(active); montageId:setEnabled(active); montageFrames:setEnabled(active); footer:setEnabled(active)
  if not active then return end
  backgroundCell:setUniform("u_time", { type = "float", value = t })
  finalCell:setUniform("u_time", { type = "float", value = t })

  animation.updateWord(wordOne, t, T1, 316, ctx, DOWN)
  -- Archivo 900 / wdth 87.5: keep the shaped word advance explicit.
  animation.updateWord(wordLine, t, TLINE, 550, ctx, DOWN)

  local montageStart, montageEnd = 1.2372, 2.0492
  local active = t >= montageStart and t < montageEnd
  montageCell:setEnabled(active)
  montageId:setEnabled(active); montageFrames:setEnabled(active); footer:setEnabled(active)
  if active then
    local plan = animation.montage(t, montageStart, montageEnd, icons, geometry.revDur)
    local slot, radius, cx, cy, e = plan.slot, plan.radius, plan.cx, plan.cy, plan.e
    local data = {}
    local function put(x,y) data[#data+1] = x / W * 2 - 1; data[#data+1] = 1 - y / H * 2; data[#data+1] = 0 end
    for _,poly in ipairs(icons[slot]) do
      for i=2,#poly do
        local a,b=poly[i-1],poly[i]; put(cx+a.x*radius,cy+a.y*radius); put(cx+b.x*radius,cy+b.y*radius)
      end
    end
    put(300,540); put(cx,540)
    while #data < 2400 do data[#data+1] = 2 end
    montagePositions:setData(data)
    local u = plan.progress
    local n = math.floor(2137 * (u ^ 1.5))
    montageId:setText(string.format("%02d  %s", slot, geometry.names[slot]))
    montageFrames:setText(n > 0 and ("FRAMES " .. tostring(n)) or "TOKENS 0")
    montageId:setColor({0.93,0.91,0.87,0.9}); montageFrames:setColor({1,.35,.12,0.95}); footer:setColor({.55,.52,.48,.7})
    local scale = ctx.width / W
    montageId:setPosition({300*scale,596*scale}); montageFrames:setPosition({300*scale,620*scale}); footer:setPosition({96*scale,1012*scale})
    montageId:setStyle({size=18*scale}); montageFrames:setStyle({size=14*scale}); footer:setStyle({size=13*scale})
  end
end

return M

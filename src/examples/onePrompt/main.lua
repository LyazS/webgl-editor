local rg = require("render_graph")
local shot1 = require("shot1/main")
local shot2 = require("shot2/main")

local SHOT1_FRAMES = 63
local screen
local state1
local state2

function setup()
  screen = rg.renderTarget("screen")
  state1 = shot1.setup(screen)
  state2 = shot2.setup(screen)
  return {}
end

function render(ctx, state)
  local inShot1 = ctx.frame < SHOT1_FRAMES
  shot1.render({
    FPS=ctx.FPS, totalFrames=SHOT1_FRAMES, frame=ctx.frame,
    width=ctx.width, height=ctx.height, pixelRatio=ctx.pixelRatio, active=inShot1,
  }, state1)
  shot2.render({
    FPS=ctx.FPS, totalFrames=ctx.totalFrames-SHOT1_FRAMES, frame=ctx.frame-SHOT1_FRAMES,
    width=ctx.width, height=ctx.height, pixelRatio=ctx.pixelRatio, active=not inShot1,
  }, state2)
end

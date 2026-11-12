local rg = require("render_graph")

local chartProgram = rg.program("timelineChart", {
  vertex = "shaders/timeline.vert",
  fragment = "shaders/timeline.frag",
  vertexInputs = { position = "a_position" }
})
local pointProgram = rg.program("timelinePoint", {
  vertex = "shaders/timeline-point.vert",
  fragment = "shaders/timeline-point.frag",
  vertexInputs = { position = "a_position" }
})
local flashProgram = rg.program("timelineFlash", {
  vertex = "shaders/timeline-flash.vert",
  fragment = "shaders/timeline-flash.frag",
  vertexInputs = { position = "a_position" }
})

local data = {
  { 1958, "感知机", 3, "3" },
  { 1992, "SVM*", 2000, "2K" },
  { 1998, "LeNet-5", 60000, "60K" },
  { 2012, "AlexNet", 60000000, "60M" },
  { 2014, "VGG-19", 144000000, "144M" },
  { 2015, "ResNet-152", 60000000, "60M" },
  { 2017, "Transformer", 65000000, "65M" },
  { 2018, "BERT-L", 340000000, "340M" },
  { 2020, "GPT-3", 175000000000, "175B" },
  { 2022, "PaLM", 540000000000, "540B" },
  { 2023, "GPT-4*", 1760000000000, "1.76T" },
  { 2026, "GPT-6*", 10000000000000, "10T" }
}
local minYear, maxYear = 1958, 2026
local maxLog = 13.2
local function xOf(year)
  return (year - minYear) / (maxYear - minYear)
end
local function yOf(parameters)
  return 1.0 - math.log(parameters) / math.log(10) / maxLog
end

local backgroundCell
local gridCell
local segmentCells = {}
local segmentBuffers = {}
local pointCells = {}
local pointLabels = {}
local currentPoint
local flashCell
local titleCell
local subtitleCell
local yLabels = {}
local xLabels = {}
local designWidth, designHeight = 1280, 720
local chartX, chartY, chartWidth, chartHeight = 120, 172, 1080, 430

local function lineUniforms(origin, size, resolution, color)
  return {
    u_origin = { type = "vec2", value = origin },
    u_size = { type = "vec2", value = size },
    u_resolution = { type = "vec2", value = resolution },
    u_color = { type = "vec4", value = color }
  }
end

function setup()
  local font = rg.font("timeline-ui", { family = "Noto Sans SC" })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.018, 0.027, 0.045, 1.0 })

  local quadPositions = rg.vertexBuffer({ data = { 0,0,0, 1,0,0, 0,1,0, 1,1,0 }, type = "float32" })
  local quad = rg.mesh({ vertexBuffers = { position = quadPositions }, topology = "triangle-strip", vertexCount = 4 })
  backgroundCell = screen:addDrawCell("chart-background", { mesh = quad, program = "timelineChart" })

  local gridData = {}
  for i = 0, 5 do
    local value = i / 5
    table.insert(gridData, value); table.insert(gridData, 0); table.insert(gridData, 0)
    table.insert(gridData, value); table.insert(gridData, 1); table.insert(gridData, 0)
    table.insert(gridData, 0); table.insert(gridData, value); table.insert(gridData, 0)
    table.insert(gridData, 1); table.insert(gridData, value); table.insert(gridData, 0)
  end
  local gridPositions = rg.vertexBuffer({ data = gridData, type = "float32" })
  local gridMesh = rg.mesh({ vertexBuffers = { position = gridPositions }, topology = "lines", vertexCount = #gridData / 3 })
  gridCell = screen:addDrawCell("chart-grid", { mesh = gridMesh, program = "timelineChart" })

  local pointPositions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local pointMesh = rg.mesh({ vertexBuffers = { position = pointPositions }, topology = "triangle-strip", vertexCount = 4 })
  for i, item in ipairs(data) do
    local pointX, pointY = xOf(item[1]), yOf(item[3])
    pointCells[i] = screen:addDrawCell("point-" .. i, { mesh = pointMesh, program = "timelinePoint" })
    pointCells[i]:setEnabled(false)
    pointLabels[i] = screen:addTextCell("point-label-" .. i, {
      font = font, text = item[2], size = 14, position = { 0, 0 },
      color = { 0.67, 0.78, 0.89, 1.0 }, blend = "premultiplied"
    })
    pointLabels[i]:setEnabled(false)
    if i > 1 then
      local previousX, previousY = xOf(data[i - 1][1]), yOf(data[i - 1][3])
      segmentBuffers[i - 1] = rg.vertexBuffer({
        data = { previousX, previousY, 0, pointX, pointY, 0 },
        type = "float32", usage = "dynamic"
      })
      local segmentMesh = rg.mesh({ vertexBuffers = { position = segmentBuffers[i - 1] }, topology = "lines", vertexCount = 2 })
      segmentCells[i - 1] = screen:addDrawCell("segment-" .. (i - 1), { mesh = segmentMesh, program = "timelineChart" })
      segmentCells[i - 1]:setEnabled(false)
    end
  end
  currentPoint = screen:addDrawCell("current-point", { mesh = pointMesh, program = "timelinePoint" })
  flashCell = screen:addDrawCell("milestone-flash", { mesh = quad, program = "timelineFlash" })

  titleCell = screen:addTextCell("title", {
    font = font, text = "模型参数量 · 时间线", size = 32, position = { 0, 0 },
    color = { 0.91, 0.96, 1.0, 1.0 }, blend = "premultiplied"
  })
  subtitleCell = screen:addTextCell("subtitle", {
    font = font, text = "从感知机与 SVM 到 GPT-6 · 对数刻度 · * 为公开估算或示意值",
    size = 15, position = { 0, 0 }, color = { 0.47, 0.62, 0.74, 1.0 }, blend = "premultiplied"
  })
  local axisValues = { { 1, "1" }, { 1000, "1K" }, { 1000000, "1M" }, { 1000000000, "1B" }, { 1000000000000, "1T" }, { 10000000000000, "10T" } }
  for i, axis in ipairs(axisValues) do
    yLabels[i] = screen:addTextCell("y-label-" .. i, { font = font, text = axis[2], size = 13, position = { 0, 0 }, color = { 0.47, 0.62, 0.74, 1.0 }, blend = "premultiplied" })
  end
  for i, year in ipairs({ 1958, 1990, 2010, 2020, 2026 }) do
    xLabels[i] = screen:addTextCell("x-label-" .. i, { font = font, text = tostring(year), size = 13, position = { 0, 0 }, color = { 0.47, 0.62, 0.74, 1.0 }, blend = "premultiplied" })
  end
  return {}
end

function render(ctx, state)
  local scale = math.min(ctx.width / designWidth, ctx.height / designHeight)
  local ox = (ctx.width - designWidth * scale) * 0.5
  local oy = (ctx.height - designHeight * scale) * 0.5
  local pixelRatio = ctx.pixelRatio or 1
  local resolution = { ctx.width * pixelRatio, ctx.height * pixelRatio }
  local origin = { (ox + chartX * scale) * pixelRatio, (oy + chartY * scale) * pixelRatio }
  local size = { chartWidth * scale * pixelRatio, chartHeight * scale * pixelRatio }

  backgroundCell:setUniform("u_origin", { type = "vec2", value = origin })
  backgroundCell:setUniform("u_size", { type = "vec2", value = size })
  backgroundCell:setUniform("u_resolution", { type = "vec2", value = resolution })
  backgroundCell:setUniform("u_color", { type = "vec4", value = { 0.035, 0.065, 0.095, 1.0 } })
  gridCell:setUniform("u_origin", { type = "vec2", value = origin })
  gridCell:setUniform("u_size", { type = "vec2", value = size })
  gridCell:setUniform("u_resolution", { type = "vec2", value = resolution })
  gridCell:setUniform("u_color", { type = "vec4", value = { 0.13, 0.22, 0.30, 1.0 } })
  for i, cell in ipairs(segmentCells) do
    cell:setUniform("u_origin", { type = "vec2", value = origin })
    cell:setUniform("u_size", { type = "vec2", value = size })
    cell:setUniform("u_resolution", { type = "vec2", value = resolution })
    cell:setUniform("u_color", { type = "vec4", value = { 0.22, 0.84, 0.95, 1.0 } })
  end

  local progress = (ctx.frame / math.max(ctx.totalFrames - 1, 1)) * (#data - 1)
  local completed = math.floor(progress)
  local milestone = math.min(completed + 1, #data)
  state.lastMilestone = state.lastMilestone or 1
  state.flash = math.max(0, (state.flash or 0) - 1 / 18)
  if milestone > state.lastMilestone then
    state.lastMilestone = milestone
    state.flash = 1.0
  end
  local flare = state.flash or 0
  backgroundCell:setUniform("u_color", { type = "vec4", value = { 0.035 + flare * 0.20, 0.065 + flare * 0.15, 0.095 + flare * 0.10, 1.0 } })
  gridCell:setUniform("u_color", { type = "vec4", value = { 0.13 + flare * 0.26, 0.22 + flare * 0.22, 0.30 + flare * 0.18, 1.0 } })
  for i, cell in ipairs(segmentCells) do
    cell:setUniform("u_color", { type = "vec4", value = { 0.22 + flare * 0.55, 0.84 + flare * 0.12, 0.95, 1.0 } })
  end
  flashCell:setUniform("u_resolution", { type = "vec2", value = resolution })
  flashCell:setUniform("u_intensity", { type = "float", value = flare })

  for i = 1, #segmentCells do
    local startX, startY = xOf(data[i][1]), yOf(data[i][3])
    local endX, endY = xOf(data[i + 1][1]), yOf(data[i + 1][3])
    local segmentProgress = progress - (i - 1)
    if segmentProgress > 0 and segmentProgress < 1 then
      endX = startX + (endX - startX) * segmentProgress
      endY = startY + (endY - startY) * segmentProgress
    end
    segmentBuffers[i]:setData({ startX, startY, 0, endX, endY, 0 })
    segmentCells[i]:setEnabled(segmentProgress >= 0)
  end

  local activeIndex = math.min(completed + 1, #data)
  local activeProgress = progress - completed
  local activeX, activeY = xOf(data[activeIndex][1]), yOf(data[activeIndex][3])
  if activeIndex < #data then
    local nextX, nextY = xOf(data[activeIndex + 1][1]), yOf(data[activeIndex + 1][3])
    activeX = activeX + (nextX - activeX) * activeProgress
    activeY = activeY + (nextY - activeY) * activeProgress
  end
  currentPoint:setUniform("u_origin", { type = "vec2", value = origin })
  currentPoint:setUniform("u_size", { type = "vec2", value = size })
  currentPoint:setUniform("u_resolution", { type = "vec2", value = resolution })
  currentPoint:setUniform("u_center", { type = "vec2", value = { activeX, activeY } })
  currentPoint:setUniform("u_radius", { type = "vec2", value = { 0.012, 0.018 } })
  currentPoint:setUniform("u_color", { type = "vec4", value = { 1.0, 0.76, 0.30, 1.0 } })

  for i, item in ipairs(data) do
    local px, py = xOf(item[1]), yOf(item[3])
    local visible = i <= completed + 1
    pointCells[i]:setEnabled(visible)
    pointCells[i]:setUniform("u_origin", { type = "vec2", value = origin })
    pointCells[i]:setUniform("u_size", { type = "vec2", value = size })
    pointCells[i]:setUniform("u_resolution", { type = "vec2", value = resolution })
    pointCells[i]:setUniform("u_center", { type = "vec2", value = { px, py } })
    pointCells[i]:setUniform("u_radius", { type = "vec2", value = { 0.007, 0.011 } })
    pointCells[i]:setUniform("u_color", { type = "vec4", value = { 0.34, 0.74, 0.90, 1.0 } })
    pointLabels[i]:setEnabled(visible)
    pointLabels[i]:setPosition({ ox + (chartX + px * chartWidth) * scale - 18, oy + (chartY + py * chartHeight) * scale - (i % 2 == 0 and 26 or -8) })
    pointLabels[i]:setStyle({ size = 13 * scale })
  end
  currentPoint:setEnabled(true)

  titleCell:setPosition({ ox + 54 * scale, oy + 48 * scale })
  titleCell:setStyle({ size = 32 * scale })
  subtitleCell:setPosition({ ox + 56 * scale, oy + 98 * scale })
  subtitleCell:setStyle({ size = 15 * scale })
  for i, axis in ipairs({ { 1, "1" }, { 1000, "1K" }, { 1000000, "1M" }, { 1000000000, "1B" }, { 1000000000000, "1T" }, { 10000000000000, "10T" } }) do
    local y = 1.0 - math.log(axis[1]) / math.log(10) / maxLog
    yLabels[i]:setPosition({ ox + (chartX - 44) * scale, oy + (chartY + y * chartHeight - 8) * scale })
    yLabels[i]:setStyle({ size = 13 * scale })
  end
  for i, year in ipairs({ 1958, 1990, 2010, 2020, 2026 }) do
    xLabels[i]:setPosition({ ox + (chartX + xOf(year) * chartWidth - 15) * scale, oy + (chartY + chartHeight + 18) * scale })
    xLabels[i]:setStyle({ size = 13 * scale })
  end
end
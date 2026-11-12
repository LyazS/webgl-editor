local M = {}

function M.update(path, cell, ctx)
  local y = 70 + math.sin(ctx.frame / 30) * 60
  path:setData("M0 0C30 " .. -y .. " 100 " .. -y .. " 140 0V100H0Z")
  cell:setTransform({ 1.5, 0, 0, 1.5, ctx.width / 2 - 105, ctx.height / 2 - 50 })
end

return M

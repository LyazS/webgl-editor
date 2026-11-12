local M = {}

function M.rgba(r, g, b, a) return { r, g, b, a or 1 } end
function M.mix(a, b, t)
  return { a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t }
end
function M.clamp01(x) if x < 0 then return 0 elseif x > 1 then return 1 else return x end end
function M.segment(t, a, b) return M.clamp01((t - a) / math.max(0.0001, b - a)) end
function M.easeOutExpo(x) x=M.clamp01(x); return x >= 1 and 1 or 1 - math.exp(-10*x) end
function M.easeInCubic(x) x=M.clamp01(x); return x*x*x end

function M.updateWord(cell, t, start, x, ctx, down)
  local rise = M.easeOutExpo(M.segment(t, start, start + 0.13))
  local sink = M.easeInCubic(M.segment(t, down - 0.22, down - 0.12))
  local visible = t >= start and sink < 1
  cell:setEnabled(visible)
  if not visible then return end
  local scale = ctx.width / 1920
  cell:setStyle({ size = 105 * scale })
  cell:setPosition({ x * scale, (520 + (1 - rise) * 180 + sink * 180) * scale })
  local ember, orange, bone = M.rgba(1,.6039,.302,1), M.rgba(1,.3529,.1216,1), M.rgba(.93,.91,.87,1)
  local age = t - start
  cell:setColor(age < .05 and M.mix(ember, orange, M.segment(age,0,.05)) or M.mix(orange,bone,M.segment(age,.05,.30)))
end

function M.montage(t, startTime, endTime, icons, durations)
  if t < startTime or t >= endTime then return nil end
  local elapsed, slot, acc = t - startTime, 1, 0
  for i,d in ipairs(durations) do if elapsed < acc + d then slot=i; break end; acc=acc+d; slot=i+1 end
  local reverse = 1 - M.clamp01((elapsed - acc) / durations[slot])
  local e = slot == 1 and (reverse*reverse*(3-2*reverse)) or reverse*reverse
  return { slot=slot, e=e, radius=330*(1-e)+2, cx=960-660*e, cy=540, progress=M.clamp01((t-startTime)/(endTime-startTime)) }
end

return M

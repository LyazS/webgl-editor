local modules = {
  "01-leader", "02-prompt", "03-ridge", "04-city",
  "05-lighting-plot", "06-hook", "07-zoetrope", "08-projection",
  "09-marquee", "10-matte", "11-murmuration", "12-mix",
  "13-stadium", "14-edit", "15-nightside", "16-premiere",
}
local M = {}
function M.makeIcons()
  local icons = {}
  for i, name in ipairs(modules) do icons[i] = require("shot1/lib/icons/" .. name) end
  return icons
end
M.names = { "LEADER", "PROMPT", "RIDGE", "CITY", "LIGHTING PLOT", "HOOK", "ZOETROPE", "PROJECTION", "MARQUEE", "MATTE", "MURMURATION", "MIX", "STADIUM", "EDIT", "NIGHTSIDE", "PREMIERE" }
M.revDur = { .16, .07, .055, .045, .038, .033, .03, .028, .028, .03, .032, .036, .042, .05, .06, .075 }
return M

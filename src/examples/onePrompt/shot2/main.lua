local rg = require("render_graph")
local titleData = require("shot2/lib/title-contours")
local M = {}

local W,H=1920,1080
local B=60/122
local START=0
local FILL=3.93
local TITLE=5.0
local EXIT=6.95

local constructProgram=rg.program("constructProgram",{vertex="shot2/shaders/fullscreen.vert",fragment="shot2/shaders/construct.frag",vertexInputs={position="a_position",uv0="a_uv"}})
local lineProgram=rg.program("constructLines",{vertex="shot2/shaders/lines.vert",fragment="shot2/shaders/lines.frag",vertexInputs={position="a_position"}})

local positions,uvs,quad,background,lines,lineBuffer,outline,fillText,titleCell,caret,copyCell
local titleTimes = { 3.052, 3.544, 3.790, 4.037, 4.529, 5.021, 5.513, 6.004, 6.496 }

local function pt(x,y) return {x=x,y=y} end
local function add(data,x,y) data[#data+1]=x/W*2-1; data[#data+1]=1-y/H*2; data[#data+1]=0 end
local function line(data,a,b) add(data,a.x,a.y); add(data,b.x,b.y) end
local function circle(data,cx,cy,r,n)
  local prev=pt(cx+r,cy)
  for i=1,n do local a=math.pi*2*i/n; local cur=pt(cx+math.cos(a)*r,cy+math.sin(a)*r); line(data,prev,cur); prev=cur end
end
local function camera(t)
  local Wt,ocx,ocy,zf=5.7,.30,.36,1560/5.7
  local k={{2.069,0,0,2400,.30},{2.519,.25,.30,900,.06},{2.541,ocx-.05,ocy,1000,.02},{2.961,ocx,ocy,1250,0},{3.032,ocx+.05,ocy,1300,-.01},{3.353,ocx+.35,ocy+.05,980,-.025},{4.006,1,ocy+.05,900,-.035},{4.356,Wt*.5+.1,.45,zf*.86,.02},{5.493,Wt*.5+.05,.42,zf*.93,.015},{5.985,Wt*.5,.36,zf*.97,0},{6.115,Wt*.5,.36,zf*1.05,0},{6.967,Wt*.5,.36,zf*1.09,0},{7.479,Wt*.5,.36,zf*1.12,0}}
  if t<=k[1][1] then return k[1] end
  for i=2,#k do local a,b=k[i-1],k[i]; if t<=b[1] then local u=math.max(0,math.min(1,(t-a[1])/(b[1]-a[1]))); return {t,a[2]+(b[2]-a[2])*u,a[3]+(b[3]-a[3])*u,math.exp(math.log(a[4])+(math.log(b[4])-math.log(a[4]))*u),a[5]+(b[5]-a[5])*u} end end
  return k[#k]
end
local function w2s(c,x,y)
  local dx=(x-c[2])*c[4]; local dy=-(y-c[3])*c[4]; local co,si=math.cos(c[5]),math.sin(c[5]); return 960+co*dx-si*dy,540+si*dx+co*dy
end
local function addWorldLine(data,c,a,b) local ax,ay=w2s(c,a.x,a.y); local bx,by=w2s(c,b.x,b.y); line(data,pt(ax,ay),pt(bx,by)) end
local function addTitle(data,c,gt)
  local x=0; local glyphIndex=0
  for _,g in ipairs(titleData.glyphs) do
    if g.ch ~= " " then
      glyphIndex=glyphIndex+1
      local t0=titleTimes[glyphIndex]; local dur=glyphIndex<=3 and .34 or .20
      for _,contour in ipairs(g.contours) do
        local pts={}; for _,q in ipairs(contour) do pts[#pts+1]=pt(x+q[1],q[2]) end
        local total=0; for i=2,#pts do total=total+math.sqrt((pts[i].x-pts[i-1].x)^2+(pts[i].y-pts[i-1].y)^2) end
        local acc=0; local prev=nil
        for i=2,#pts do
          local a,b=pts[i-1],pts[i]; local len=math.sqrt((b.x-a.x)^2+(b.y-a.y)^2)
          local ta=t0+dur*(acc/total); local tb=t0+dur*((acc+len)/total)
          if gt>=ta then
            local endp=b
            if gt<tb then local u=(gt-ta)/math.max(.0001,tb-ta); endp=pt(a.x+(b.x-a.x)*u,a.y+(b.y-a.y)*u) end
            if prev then addWorldLine(data,c,prev,endp) end
            prev=endp
          end
          acc=acc+len
          if gt<tb then break end
        end
      end
      x=x+g.advance
    else x=x+g.advance end
  end
end
local function addOutline(data,c,gt)
  local Wt,ocx,ocy=5.7,.30,.36
  addWorldLine(data,c,pt(0,0),pt(Wt+1.2,0)); addWorldLine(data,c,pt(0,0),pt(0,1.25)); addWorldLine(data,c,pt(0,0),pt(0,-.7))
  if gt>=2.09 then
    for deg=30,330,30 do
      if deg%90~=0 then
        local a=math.pi*deg/180
        for j=0,7,2 do
          local r0=.15+j*.42; local r1=r0+.22
          addWorldLine(data,c,pt(math.cos(a)*r0,math.sin(a)*r0),pt(math.cos(a)*r1,math.sin(a)*r1))
        end
      end
    end
  end
  if gt>=2.56 then
    local prev=pt(ocx+.38,ocy); for i=1,128 do local a=math.pi*2*i/128; local cur=pt(ocx+math.cos(a)*.38,ocy+math.sin(a)*.38); addWorldLine(data,c,prev,cur); prev=cur end
    prev=pt(ocx+.19,ocy); for i=1,96 do local a=math.pi*2*i/96; local cur=pt(ocx+math.cos(a)*.19,ocy+math.sin(a)*.19); addWorldLine(data,c,prev,cur); prev=cur end
  end
  if gt>=2.80 then
    addWorldLine(data,c,pt(-.3,-.1),pt(Wt+.3,-.1)); addWorldLine(data,c,pt(-.3,.79),pt(Wt+.3,.79)); addWorldLine(data,c,pt(-.3,-.21),pt(Wt+.3,-.21))
  end
  if gt>=3.0 then addTitle(data,c,gt) end
end

function M.setup(outputTarget)
  positions=rg.vertexBuffer({data={-1,-1,0,1,-1,0,-1,1,0,1,1,0},type="float32"})
  uvs=rg.vertexBuffer({data={0,0,1,0,0,1,1,1},type="float32"})
  quad=rg.mesh({vertexBuffers={position=positions,uv0=uvs},topology="triangle-strip",vertexCount=4})
  local empty={}; for i=1,12000 do empty[i]=2 end
  lineBuffer=rg.vertexBuffer({data=empty,type="float32",usage="dynamic"})
  local lineMesh=rg.mesh({vertexBuffers={position=lineBuffer},topology="lines",vertexCount=4000})
  local font=rg.font("archivo2",{family="Archivo Black Condensed",source="/fonts/Archivo-Black-Condensed.ttf"})
  local scene=rg.renderTarget("sceneColorShot2",{width="viewport",height="viewport",format="rgba8"}); scene:clear({0.0392,0.0392,0.0431,1})
  background=scene:addDrawCell("construct-background",{mesh=quad,program=constructProgram,uniforms={u_time={type="float",value=0},u_width={type="float",value=W},u_height={type="float",value=H},u_camera={type="vec4",value={0,0,2400,.3}}}})
  lines=scene:addDrawCell("construct-lines",{mesh=lineMesh,program=lineProgram,uniforms={u_color={type="vec4",value={.93,.91,.87,1}}}})
  local screen=outputTarget or rg.renderTarget("screen")
  if not outputTarget then screen:clear({0.0392,0.0392,0.0431,1}) end
  local copy=rg.program("constructCopy",{vertex="shot2/shaders/fullscreen.vert",fragment="shot2/shaders/copy.frag",vertexInputs={position="a_position",uv0="a_uv"}})
  -- Screen receives the scene directly; the line pass carries the construction drawing.
  copyCell=screen:addDrawCell("construct-copy",{mesh=quad,program="constructCopy",textures={u_input="sceneColorShot2"}})
  fillText=screen:addTextCell("construct-title",{font=font,text="ONE PROMPT",size=225,position={120,760},color={.93,.91,.87,1},anchor="baseline",blend="premultiplied"})
  fillText:setEnabled(false)
  return {}
end

function M.render(ctx,state)
  local t=ctx.frame/ctx.FPS
  local active = ctx.active ~= false
  background:setEnabled(active); lines:setEnabled(active); fillText:setEnabled(active); copyCell:setEnabled(active)
  if not active then return end
  local c=camera(2.069+t)
  background:setUniform("u_time",{type="float",value=t})
  background:setUniform("u_camera",{type="vec4",value={c[2],c[3],c[4],c[5]}})
  local data={}; addOutline(data,c,2.069+t)
  while #data<12000 do data[#data+1]=2 end
  lineBuffer:setData(data)
  lines:setEnabled(t>=0 and t<EXIT)
  local fill=t>=FILL and t<EXIT
  fillText:setEnabled(fill)
  local fillK=math.min(1,1-math.exp(-10*math.max(0,(t-FILL)/.08)))
  fillText:setColor({.93,.91,.87,fillK})
  local scale=ctx.width/W
  fillText:setStyle({size=225*scale}); fillText:setPosition({120*scale,760*scale})
end

return M

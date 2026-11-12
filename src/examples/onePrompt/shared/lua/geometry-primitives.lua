local M = {}
function M.seg(x0,y0,x1,y1) return {{x=x0,y=y0},{x=x1,y=y1}} end
function M.rect(x0,y0,x1,y1) return {{x=x0,y=y0},{x=x1,y=y0},{x=x1,y=y1},{x=x0,y=y1},{x=x0,y=y0}} end
function M.circ(cx,cy,rx,ry,n,a0,a1)
  local out={}; n=n or 32; ry=ry or rx; a0=a0 or 0; a1=a1 or math.pi*2
  for i=0,n do local a=a0+(a1-a0)*i/n; out[#out+1]={x=cx+math.cos(a)*rx,y=cy+math.sin(a)*ry} end
  return out
end
function M.dots(points,d)
  local out={}; d=d or .012
  for _,p in ipairs(points) do out[#out+1]=M.seg(p.x-d,p.y,p.x+d,p.y) end
  return out
end
return M

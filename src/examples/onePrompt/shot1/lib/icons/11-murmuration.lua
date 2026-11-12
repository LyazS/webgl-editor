local p=require("shared/lua/geometry-primitives"); local points={}
for i=0,89 do local a=i*.37; local r=.15+.8*i/90; points[#points+1]={x=math.cos(a)*r,y=math.sin(a)*r*.6} end
return p.dots(points,.018)

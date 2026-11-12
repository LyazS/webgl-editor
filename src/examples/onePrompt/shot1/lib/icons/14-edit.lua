local p=require("shared/lua/geometry-primitives"); local out={}
for _,y in ipairs({-.45,0,.45}) do out[#out+1]=p.seg(-1,y,1,y); for k=0,2 do local x=-.95+k*.66+y*.1; out[#out+1]=p.rect(x,y-.14,x+.5,y+.14) end end
out[#out+1]=p.seg(.1,-.8,.1,.8); return out

local p=require("shared/lua/geometry-primitives"); local out={}
for i=0,6 do local x=-.84+i*.28; local y=-.5+.9*math.abs(math.sin(i*1.7)); out[#out+1]=p.seg(x,-.8,x,.8); out[#out+1]=p.rect(x-.08,y-.05,x+.08,y+.05) end
return out

local p=require("shared/lua/geometry-primitives"); local out={p.rect(-1,-.5,1,.5),p.rect(-.85,-.3,.85,.3)}; local bulbs={}
for i=0,20 do bulbs[#bulbs+1]={x=-.95+1.9*i/20,y=-.42}; bulbs[#bulbs+1]={x=-.95+1.9*i/20,y=.42} end
for _,line in ipairs(p.dots(bulbs,.02)) do out[#out+1]=line end
return out

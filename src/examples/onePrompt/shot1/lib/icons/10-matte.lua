local p=require("shared/lua/geometry-primitives"); local out={p.seg(-1,.6,1,.6)}
for k=0,3 do local line={}; for i=0,20 do line[#line+1]={x=-.9+i*.09,y=-.5+k*.25+.06*math.sin(i*.7+k)} end; out[#out+1]=line end
return out

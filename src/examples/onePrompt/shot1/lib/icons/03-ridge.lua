local p=require("shared/lua/geometry-primitives"); local out={}
for r=0,6 do local line={}; for i=0,40 do local x=-1+i/20; line[#line+1]={x=x,y=-.6+r*.2-.22*math.exp(-((x-.2*math.sin(r))^2)*6)*math.abs(math.sin(i*.9+r))} end; out[#out+1]=line end
return out

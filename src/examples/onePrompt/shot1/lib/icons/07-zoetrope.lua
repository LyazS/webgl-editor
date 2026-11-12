local p=require("shared/lua/geometry-primitives"); local out={p.circ(0,-.55,.85,.22),p.circ(0,.55,.85,.22,32,0,math.pi),p.seg(-.85,-.55,-.85,.55),p.seg(.85,-.55,.85,.55)}
for i=1,11 do local x=-.85+1.7*i/12; out[#out+1]=p.seg(x,-.5,x,-.2) end
return out

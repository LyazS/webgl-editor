local p=require("shared/lua/geometry-primitives"); local out={}
for i=0,23 do local a=i*math.pi*2/24; out[#out+1]=p.seg(math.cos(a)*.15,-.3+math.sin(a)*.15,math.cos(a)*.6,-.3+math.sin(a)*.6) end
out[#out+1]={{x=-1,y=.8},{x=-.7,y=.8},{x=-.7,y=.45},{x=-.45,y=.45},{x=-.45,y=.6},{x=-.1,y=.6},{x=-.1,y=.3},{x=.1,y=.3},{x=.1,y=.55},{x=.5,y=.55},{x=.5,y=.4},{x=.75,y=.4},{x=.75,y=.8},{x=1,y=.8}}
return out

#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform sampler2D u_text;
in vec2 v_uv;
out vec4 outColor;
float box(vec2 p, vec2 c, vec2 h, float r) { vec2 q=abs(p-c)-h+vec2(r); return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r; }
float lineSeg(vec2 p, vec2 a, vec2 b, float w) { vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return smoothstep(w,w*.35,length(pa-ba*h)); }
vec3 c(vec3 v) { return v/255.0; }
void icon(inout vec3 color, vec2 p, float x, float y) {
  vec3 ink=c(vec3(220.0));
  color=mix(color,ink,lineSeg(p,vec2(x,y),vec2(x,y+18.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x,y),vec2(x+16.0,y+9.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x+16.0,y+9.0),vec2(x,y+18.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+3.0),vec2(x+46.0,y-2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+46.0,y-2.0),vec2(x+56.0,y+3.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+3.0),vec2(x+37.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+56.0,y+3.0),vec2(x+56.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+15.0),vec2(x+46.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+46.0,y+21.0),vec2(x+56.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+79.0,y+2.0),vec2(x+95.0,y+2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+79.0,y+2.0),vec2(x+79.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+95.0,y+2.0),vec2(x+95.0,y+16.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+95.0,y+16.0),vec2(x+87.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+87.0,y+21.0),vec2(x+79.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+124.0,y),vec2(x+136.0,y),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+136.0,y),vec2(x+144.0,y+8.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+144.0,y+8.0),vec2(x+136.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+136.0,y+18.0),vec2(x+124.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+160.0,y+9.0),vec2(x+167.0,y+2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+167.0,y+2.0),vec2(x+174.0,y+9.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+160.0,y+9.0),vec2(x+167.0,y+16.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+167.0,y+16.0),vec2(x+174.0,y+9.0),1.2));
}
void main() {
  vec2 design=vec2(1740.0,1042.0); float s=min(u_resolution.x/design.x,u_resolution.y/design.y); vec2 o=(u_resolution-design*s)*.5; vec2 p=(gl_FragCoord.xy-o)/s; p.y=design.y-p.y;
  vec3 color=c(vec3(16.0,15.0,19.0));
  if(p.x>=0.0&&p.x<=design.x&&p.y>=0.0&&p.y<=design.y){
    vec2 cards[3]; cards[0]=vec2(443.0,245.0); cards[1]=vec2(1307.0,348.0); cards[2]=vec2(443.0,739.0); vec2 sizes[3]; sizes[0]=vec2(413.0,217.0); sizes[1]=vec2(413.0,320.0); sizes[2]=vec2(413.0,243.0);
    for(int i=0;i<3;i++){float d=box(p,cards[i],sizes[i],6.0);float fill=1.0-smoothstep(0.0,1.0,d);float edge=1.0-smoothstep(0.0,1.3,abs(d));color=mix(color,c(vec3(23.0,23.0,27.0)),fill);color=mix(color,c(vec3(54.0,54.0,61.0)),edge);}
    icon(color,p,630.0,86.0); icon(color,p,1492.0,86.0); icon(color,p,630.0,580.0);
  }
  vec4 textSample = texture(u_text, v_uv);
  float gradientRegion = step(65.0, p.x) * step(p.x, 400.0) * step(865.0, p.y) * step(p.y, 950.0);
  vec3 gradientColor = mix(c(vec3(240.0,45.0,35.0)), c(vec3(50.0,75.0,245.0)), clamp((p.x - 65.0) / 335.0, 0.0, 1.0));
  vec3 textColor = mix(textSample.rgb, gradientColor * textSample.a, gradientRegion);
  outColor = vec4(mix(color, textColor, textSample.a), 1.0);
}
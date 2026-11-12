export const advancedFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input,u_second,u_table;
uniform int u_mode,u_edge,u_lightType,u_octaves;
uniform bool u_linear,u_preserve,u_stitch;
uniform vec2 u_size,u_kernelStep,u_frequency;
uniform ivec2 u_order,u_target;
uniform mat3 u_world,u_inverse;
uniform vec4 u_region,u_inputRegion,u_values[4];
uniform vec3 u_light,u_lightTarget;
uniform vec2 u_lightParams;
out vec4 outColor;
vec3 decode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
vec3 encode(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec2 localToUV(vec2 p){vec2 w=(u_world*vec3(p,1)).xy/u_size;return vec2(w.x,1.-w.y);}
vec4 sampleAt(sampler2D image,vec2 p,int edge){
 if(edge==0)p=clamp(p,vec2(0),vec2(1));else if(edge==1)p=fract(p);else if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1))))return vec4(0);
 vec4 c=texture(image,p);if(u_linear&&c.a>0.)c.rgb=decode(c.rgb/c.a)*c.a;return c;
}
int permutation(int i){return int(texelFetch(u_table,ivec2(i&255,0),0).r);}
float noise(int channel,vec2 p,ivec2 period,ivec2 wrap){
 vec2 shifted=p+4096.;ivec2 a=ivec2(floor(shifted)),b=a+1;vec2 r=fract(shifted),s=r*r*(3.-2.*r);
 if(u_stitch){if(a.x>=wrap.x)a.x-=period.x;if(b.x>=wrap.x)b.x-=period.x;if(a.y>=wrap.y)a.y-=period.y;if(b.y>=wrap.y)b.y-=period.y;}
 int px=permutation(a.x),qx=permutation(b.x);
 vec2 g00=texelFetch(u_table,ivec2(permutation(px+(a.y&255)),channel+1),0).xy;
 vec2 g10=texelFetch(u_table,ivec2(permutation(qx+(a.y&255)),channel+1),0).xy;
 vec2 g01=texelFetch(u_table,ivec2(permutation(px+(b.y&255)),channel+1),0).xy;
 vec2 g11=texelFetch(u_table,ivec2(permutation(qx+(b.y&255)),channel+1),0).xy;
 return mix(mix(dot(g00,r),dot(g10,r-vec2(1,0)),s.x),mix(dot(g01,r-vec2(0,1)),dot(g11,r-1.),s.x),s.y);
}
float heightAt(vec2 local){return sampleAt(u_input,localToUV(local),2).a;}
void main(){
 vec2 world=vec2(v_uv.x,1.-v_uv.y)*u_size,local=(u_inverse*vec3(world,1)).xy;
 vec4 original=sampleAt(u_input,v_uv,2),result=original;
 if(u_mode==1){
  vec4 sum=vec4(0);
  for(int y=0;y<u_order.y;y++)for(int x=0;x<u_order.x;x++){
   vec2 p=local+vec2(x-u_target.x,y-u_target.y)*u_kernelStep;
   vec4 c=sampleAt(u_input,localToUV(p),u_edge);if(u_preserve&&c.a>0.)c.rgb/=c.a;
   int index=(u_order.y-1-y)*u_order.x+u_order.x-1-x;
   sum+=c*texelFetch(u_table,ivec2(index,0),0).r;
  }
  result=sum/u_values[0].x;
  result.a=u_preserve?original.a:clamp(result.a+u_values[0].y,0.,1.);
  result.rgb=u_preserve?clamp(result.rgb+u_values[0].y,0.,1.)*result.a:clamp(result.rgb+u_values[0].y*result.a,vec3(0),vec3(result.a));
 }
 else if(u_mode==2){vec4 map=sampleAt(u_second,v_uv,2);if(map.a>0.)map.rgb/=map.a;vec2 offset=vec2(map[u_order.x],map[u_order.y])-.5;result=sampleAt(u_input,localToUV(local+offset*u_values[0].x),2);}
 else if(u_mode==3){vec2 p=u_inputRegion.xy+mod(local-u_inputRegion.xy,u_inputRegion.zw);result=sampleAt(u_input,localToUV(p),2);}
 else if(u_mode==4){
  vec2 p=local*u_frequency;float amplitude=1.;vec4 value=vec4(0);
  ivec2 period=ivec2(floor(u_region.zw*u_frequency+.5)),wrap=ivec2(u_region.xy*u_frequency+4096.)+period;
  for(int octave=0;octave<u_octaves;octave++){for(int channel=0;channel<4;channel++){float n=noise(channel,p,period,wrap);value[channel]+=(u_values[0].x==1.?n:abs(n))*amplitude;}p*=2.;amplitude*=.5;period*=2;wrap=2*wrap-4096;}
  if(u_values[0].x==1.)value=(value+1.)*.5;value=clamp(value,0.,1.);result=vec4(value.rgb*value.a,value.a);
 }
 else if(u_mode==5||u_mode==6){
  vec2 k=u_kernelStep;
  float tl=heightAt(local-k),tc=heightAt(local+vec2(0,-k.y)),tr=heightAt(local+vec2(k.x,-k.y));
  float ml=heightAt(local+vec2(-k.x,0)),mr=heightAt(local+vec2(k.x,0));
  float bl=heightAt(local+vec2(-k.x,k.y)),bc=heightAt(local+vec2(0,k.y)),br=heightAt(local+k);
  vec3 normal=normalize(vec3(-u_values[0].x*(tr+2.*mr+br-tl-2.*ml-bl)/(4.*k.x),-u_values[0].x*(bl+2.*bc+br-tl-2.*tc-tr)/(4.*k.y),1));
  vec3 light=u_lightType==0?normalize(u_light):normalize(u_light-vec3(local,heightAt(local)*u_values[0].x));float attenuation=1.;
  if(u_lightType==2){float cosine=dot(-light,normalize(u_lightTarget-u_light));attenuation=cosine>=u_lightParams.y?pow(max(cosine,0.),u_lightParams.x):0.;}
  if(u_mode==5){vec3 c=clamp(u_values[1].rgb*u_values[0].y*max(dot(normal,light),0.)*attenuation,0.,1.);result=vec4(c,1.);}
  else{vec3 halfVector=normalize(light+vec3(0,0,1));vec3 c=clamp(u_values[1].rgb*u_values[0].z*pow(max(dot(normal,halfVector),0.),u_values[0].w)*attenuation,0.,1.);result=vec4(c,max(c.r,max(c.g,c.b)));}
 }
 if(u_linear&&result.a>0.)result.rgb=encode(clamp(result.rgb/result.a,0.,1.))*result.a;
 outColor=result;
}`;

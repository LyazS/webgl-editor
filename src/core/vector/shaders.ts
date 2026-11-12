export const geometryVertex = `#version 300 es
layout(location=0) in vec2 a_position;
uniform mat3 u_matrix;
uniform vec2 u_viewport;
out vec2 v_world;
void main(){v_world=(u_matrix*vec3(a_position,1)).xy;gl_Position=vec4(v_world.x/u_viewport.x*2.-1.,1.-v_world.y/u_viewport.y*2.,0,1);}`;
export const geometryFragment = `#version 300 es
precision highp float;
in vec2 v_world;
uniform int u_kind;
uniform vec4 u_color;
uniform mat3 u_inverse;
uniform vec4 u_coordinates;
uniform vec2 u_focus;
uniform float u_fr;
uniform sampler2D u_stops;
uniform sampler2D u_image;
uniform int u_count;
uniform int u_spread;
uniform bool u_linear;uniform float u_alpha;uniform bool u_isImage;uniform vec2 u_imageScale;uniform vec2 u_imageOffset;
uniform vec2 u_tile;
out vec4 outColor;
vec3 linearize(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
vec3 delinearize(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec4 stopColor(float t){
  if(u_count==0)return vec4(0);int lo=0,hi=u_count;
  for(int j=0;j<16;j++){if(lo>=hi)break;int mid=(lo+hi)/2;if(texelFetch(u_stops,ivec2(mid,1),0).r<=t)lo=mid+1;else hi=mid;}
  int left=max(0,lo-1),right=min(u_count-1,lo);vec4 a=texelFetch(u_stops,ivec2(left,0),0),b=texelFetch(u_stops,ivec2(right,0),0);
  float p=texelFetch(u_stops,ivec2(left,1),0).r,q=texelFetch(u_stops,ivec2(right,1),0).r;
  float f=q>p?clamp((t-p)/(q-p),0.,1.):0.;if(u_linear){a.rgb=linearize(a.rgb);b.rgb=linearize(b.rgb);}vec4 c=mix(a,b,f);if(u_linear)c.rgb=delinearize(c.rgb);return c;
}
void main(){
 vec4 c=u_color;
 if(u_kind==3){vec2 p=(u_inverse*vec3(v_world,1)).xy/u_tile;if(u_isImage){p=(p-u_imageOffset)/u_imageScale;if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1)))){outColor=vec4(0);return;}}else p=fract(p);vec4 s=texture(u_image,vec2(p.x,1.-p.y));outColor=s*u_alpha;return;}
 if(u_kind==1||u_kind==2){vec2 p=(u_inverse*vec3(v_world,1)).xy;float t=0.;
  if(u_kind==1){vec2 d=u_coordinates.zw-u_coordinates.xy;float len=dot(d,d);t=len>0.?dot(p-u_coordinates.xy,d)/len:1.;}
  else{vec2 center=u_coordinates.xy;float radius=u_coordinates.z;vec2 f=u_focus;vec2 d=center-f,q=p-f;float dr=radius-u_fr;
   float a=dot(d,d)-dr*dr,b=-2.*(dot(q,d)+u_fr*dr),cc=dot(q,q)-u_fr*u_fr;
   if(radius<=0.)t=1.;else if(abs(a)<1e-8)t=abs(b)>1e-8?-cc/b:0.;else{float disc=b*b-4.*a*cc;if(disc<0.){outColor=vec4(0);return;}float x=(-b-sqrt(disc))/(2.*a),y=(-b+sqrt(disc))/(2.*a);t=max(x,y);}
  }
  if(u_spread==1)t=fract(t);else if(u_spread==2){t=mod(t,2.);if(t>1.)t=2.-t;}else t=clamp(t,0.,1.);
  c=stopColor(t);
 }
 outColor=vec4(c.rgb*c.a,c.a);
}`;
export const quadVertex = `#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);v_uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
export const compositeFragment = `#version 300 es
precision highp float;
in vec2 v_uv;uniform sampler2D u_input;uniform sampler2D u_mask;uniform float u_opacity;uniform int u_maskMode;out vec4 outColor;
void main(){vec4 c=texture(u_input,v_uv);float a=1.;if(u_maskMode>0){vec4 m=texture(u_mask,v_uv);a=u_maskMode==2?dot(m.rgb,vec3(.2126,.7152,.0722)):m.a;}outColor=c*(u_opacity*a);}`;
export const effectFragment = `#version 300 es
precision highp float;
in vec2 v_uv;uniform sampler2D u_input;uniform sampler2D u_second;uniform int u_mode;uniform int u_operator;uniform vec2 u_step;uniform vec2 u_delta;uniform vec4 u_color;uniform vec4 u_k;uniform mat4 u_matrix;uniform vec4 u_bias;uniform vec4 u_transfer[4];uniform vec4 u_transferExtra[4];uniform bool u_linearRGB;uniform sampler2D u_functions;out vec4 outColor;
vec3 decode(vec3 c){return mix(c/12.92,pow((c+.055)/1.055,vec3(2.4)),step(vec3(.04045),c));}
vec3 encode(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec4 sampleAt(sampler2D image,vec2 p){vec4 c=any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1)))?vec4(0):texture(image,p);if(u_linearRGB&&c.a>0.)c.rgb=decode(c.rgb/c.a)*c.a;return c;}
float lum(vec3 c){return dot(c,vec3(.3,.59,.11));}
vec3 clipColor(vec3 c){float l=lum(c),n=min(c.r,min(c.g,c.b)),x=max(c.r,max(c.g,c.b));if(n<0.)c=l+((c-l)*l)/max(l-n,1e-8);if(x>1.)c=l+((c-l)*(1.-l))/max(x-l,1e-8);return c;}
vec3 setLum(vec3 c,float l){return clipColor(c+(l-lum(c)));}
vec3 setSat(vec3 c,float s){float lo=min(c.r,min(c.g,c.b)),hi=max(c.r,max(c.g,c.b));return hi>lo?(c-lo)*s/(hi-lo):vec3(0);}
float sat(vec3 c){return max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b));}
void main(){vec4 a=sampleAt(u_input,v_uv),b=sampleAt(u_second,v_uv);vec4 c=a;
 if(u_mode==1){float sigma=u_k.x;vec4 sum=vec4(0);float weight=0.;for(int i=-int(ceil(3.*sigma));i<=int(ceil(3.*sigma));i++){float x=float(i);float w=exp(-x*x/(2.*sigma*sigma));sum+=sampleAt(u_input,v_uv+u_step*x)*w;weight+=w;}c=sum/max(weight,1e-8);}
 else if(u_mode==2)c=sampleAt(u_input,v_uv+u_delta);
 else if(u_mode==3)c=vec4((u_linearRGB?decode(u_color.rgb):u_color.rgb)*u_color.a,u_color.a);
 else if(u_mode==4){vec4 straight=a.a>0.?vec4(a.rgb/a.a,a.a):vec4(0);straight=clamp(u_matrix*straight+u_bias,0.,1.);c=vec4(straight.rgb*straight.a,straight.a);}
 else if(u_mode==5){vec3 x=a.a>0.?a.rgb/a.a:vec3(0),y=b.a>0.?b.rgb/b.a:vec3(0),blend=x;if(u_operator==1)blend=x*y;else if(u_operator==2)blend=x+y-x*y;else if(u_operator==3)blend=min(x,y);else if(u_operator==4)blend=max(x,y);else if(u_operator==5)blend=abs(x-y);else if(u_operator==6)blend=x+y-2.*x*y;else if(u_operator==7)blend=mix(2.*x*y,1.-2.*(1.-x)*(1.-y),step(vec3(.5),y));else if(u_operator==8)blend=mix(min(vec3(1),y/max(vec3(1e-8),1.-x)),vec3(1),step(vec3(1),x));else if(u_operator==9)blend=mix(1.-min(vec3(1),(1.-y)/max(x,vec3(1e-8))),vec3(0),step(x,vec3(0)));else if(u_operator==10)blend=mix(2.*x*y,1.-2.*(1.-x)*(1.-y),step(vec3(.5),x));else if(u_operator==11){vec3 d=mix(((16.*y-12.)*y+4.)*y,sqrt(y),step(vec3(.25),y));blend=mix(y-(1.-2.*x)*y*(1.-y),y+(2.*x-1.)*(d-y),step(vec3(.5),x));}else if(u_operator==12)blend=setLum(setSat(x,sat(y)),lum(y));else if(u_operator==13)blend=setLum(setSat(y,sat(x)),lum(y));else if(u_operator==14)blend=setLum(x,lum(y));else if(u_operator==15)blend=setLum(y,lum(x));c=vec4((1.-a.a)*b.rgb+(1.-b.a)*a.rgb+a.a*b.a*blend,a.a+b.a-a.a*b.a);}
 else if(u_mode==6){if(u_operator==0)c=a+b*(1.-a.a);else if(u_operator==1)c=a*b.a;else if(u_operator==2)c=a*(1.-b.a);else if(u_operator==3)c=a*b.a+b*(1.-a.a);else if(u_operator==4)c=a*(1.-b.a)+b*(1.-a.a);else if(u_operator==5)c=clamp(u_k.x*a*b+u_k.y*a+u_k.z*b+u_k.w,0.,1.);else c=min(a+b,vec4(1));c.rgb=min(c.rgb,vec3(c.a));}
 else if(u_mode==7)c=vec4(0,0,0,a.a);
 else if(u_mode==8){c=u_operator==0?vec4(1):vec4(0);for(int i=-int(floor(u_k.x));i<=int(floor(u_k.x));i++){vec4 v=sampleAt(u_input,v_uv+float(i)*u_step);c=u_operator==0?min(c,v):max(c,v);}}
 else if(u_mode==9){vec4 s=a.a>0.?vec4(a.rgb/a.a,a.a):vec4(0);for(int i=0;i<4;i++){vec4 t=u_transfer[i],e=u_transferExtra[i];if(t.x==1.)s[i]=t.y*s[i]+t.z;else if(t.x==2.)s[i]=t.y*pow(max(s[i],0.),t.z)+t.w;else if(t.x==3.||t.x==4.){float x=clamp(s[i],0.,1.)*(t.x==3.?t.y-1.:t.y);int k=min(int(floor(x)),int(t.y)-1);float a=texelFetch(u_functions,ivec2(k,0),0)[i],b=texelFetch(u_functions,ivec2(min(k+1,int(t.y)-1),0),0)[i];s[i]=t.x==3.?mix(a,b,fract(x)):a;}}s=clamp(s,0.,1.);c=vec4(s.rgb*s.a,s.a);}
 else if(u_mode==10){float alpha=sampleAt(u_input,v_uv+u_delta).a*u_color.a;c=vec4((u_linearRGB?decode(u_color.rgb):u_color.rgb)*alpha,alpha);}
 if(u_linearRGB&&c.a>0.)c.rgb=encode(clamp(c.rgb/c.a,0.,1.))*c.a;
 outColor=c;
}`;

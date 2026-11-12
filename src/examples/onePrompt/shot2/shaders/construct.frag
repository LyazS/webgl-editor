#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
uniform float u_width;
uniform float u_height;
uniform vec4 u_camera;
out vec4 outColor;

const vec3 INK = vec3(0.0392, 0.0392, 0.0431);
const vec3 BONE = vec3(0.93, 0.91, 0.87);
const vec3 SIGNAL = vec3(1.0, 0.3529, 0.1216);
const vec3 ASH = vec3(0.32, 0.30, 0.28);

float clamp01(float x) { return clamp(x, 0.0, 1.0); }
float seg(float t, float a, float b) { return clamp01((t-a)/max(0.0001,b-a)); }
float expo(float x) { x=clamp01(x); return x>=1.0 ? 1.0 : 1.0-exp(-10.0*x); }

void main() {
  vec2 p = vec2(v_uv.x*u_width, (1.0-v_uv.y)*u_height);
  float t = u_time;
  vec2 d = p - vec2(960.0,540.0);
  float zoom = max(1.0, u_camera.z);
  float co = cos(-u_camera.w), si = sin(-u_camera.w);
  d = vec2(co*d.x-si*d.y, si*d.x+co*d.y);
  vec2 w = u_camera.xy + vec2(d.x, -d.y) / zoom;
  vec3 col = INK;

  vec2 g = abs(fract(w/0.1+0.5)-0.5)*0.1;
  vec2 G = abs(fract(w/0.5+0.5)-0.5)*0.5;
  float minor = max(1.0-smoothstep(0.0,1.0,g.x),1.0-smoothstep(0.0,1.0,g.y));
  float major = max(1.0-smoothstep(0.25,1.25,G.x),1.0-smoothstep(0.25,1.25,G.y));
  float gridFade = max(0.22, smoothstep(0.0,1.0,seg(t,0.1,1.0)));
  col += BONE * (minor*0.004 + major*0.012) * gridFade;

  float axis = 1.0-smoothstep(0.0,0.012,abs(w.y));
  float axisX = 1.0-smoothstep(0.0,0.012,abs(w.x));
  col += SIGNAL * (axis+axisX) * 0.42 * gridFade;

  float fade = 1.0-smoothstep(6.95,7.45,t);
  col *= fade;
  outColor = vec4(col,1.0);
}

#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_history1;
uniform sampler2D u_history2;
uniform sampler2D u_history3;
uniform sampler2D u_history4;
uniform sampler2D u_history5;
uniform sampler2D u_history6;
uniform sampler2D u_history7;
uniform sampler2D u_history8;
out vec4 outColor;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 trail = vec4(0.0);
  trail += texture(u_history1, uv) * 0.34;
  trail += texture(u_history2, uv) * 0.24;
  trail += texture(u_history3, uv) * 0.16;
  trail += texture(u_history4, uv) * 0.10;
  trail += texture(u_history5, uv) * 0.065;
  trail += texture(u_history6, uv) * 0.04;
  trail += texture(u_history7, uv) * 0.025;
  trail += texture(u_history8, uv) * 0.015;
  outColor = trail;
}
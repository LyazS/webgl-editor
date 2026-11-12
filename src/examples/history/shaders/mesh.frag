#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in vec4 v_color;
uniform vec4 u_tint;
out vec4 outColor;
void main() {
  float light = 0.65 + max(v_normal.z, 0.0) * 0.35;
  outColor = vec4(v_uv, 0.72, 1.0) * v_color * u_tint * light;
}
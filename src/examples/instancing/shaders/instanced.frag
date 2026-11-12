#version 300 es
precision highp float;
in vec2 v_uv;
flat in int v_instance;
out vec4 outColor;
void main() {
  float phase = float(v_instance) * 0.17;
  vec3 color = 0.5 + 0.5 * cos(vec3(phase, phase + 2.0, phase + 4.0));
  float glow = 0.75 + 0.25 * sin(v_uv.x * 3.14159);
  outColor = vec4(color * glow, 1.0);
}
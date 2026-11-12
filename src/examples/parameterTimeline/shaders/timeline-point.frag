#version 300 es
precision highp float;
uniform vec4 u_color;
in vec2 v_unit;
out vec4 outColor;
void main() {
  float distanceToCenter = dot(v_unit, v_unit);
  if (distanceToCenter > 1.0) discard;
  float edge = 1.0 - smoothstep(0.72, 1.0, distanceToCenter);
  outColor = vec4(u_color.rgb, u_color.a * edge);
}
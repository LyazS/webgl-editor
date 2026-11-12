#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_previous;
uniform vec2 u_center;
out vec4 outColor;
void main() {
  vec4 previous = texture(u_previous, vec2(v_uv.x, 1.0 - v_uv.y));
  float distanceToCenter = distance(v_uv, u_center);
  float stamp = exp(-distanceToCenter * 90.0);
  vec3 ink = vec3(0.18, 0.72, 1.0) * stamp;
  outColor = vec4(previous.rgb * 0.94 + ink, max(previous.a * 0.94, stamp));
}
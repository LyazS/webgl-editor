#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_intensity;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float border = 1.0 - smoothstep(0.0, 0.055 + u_intensity * 0.065, edge);
  float pulse = border * u_intensity;
  if (pulse < 0.025) discard;
  vec3 warmWhite = mix(vec3(1.0, 0.52, 0.20), vec3(1.0), u_intensity * 0.65);
  outColor = vec4(warmWhite, 1.0);
}
#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_input;
uniform float u_time;
uniform float u_width;
uniform float u_height;
out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 texel = vec2(1.0 / u_width, 1.0 / u_height);
  vec3 base = texture(u_input, v_uv).rgb;
  vec3 halo = vec3(0.0);
  halo += texture(u_input, v_uv + texel * vec2(-3.0, 0.0)).rgb;
  halo += texture(u_input, v_uv + texel * vec2(3.0, 0.0)).rgb;
  halo += texture(u_input, v_uv + texel * vec2(0.0, -3.0)).rgb;
  halo += texture(u_input, v_uv + texel * vec2(0.0, 3.0)).rgb;
  halo += texture(u_input, v_uv + texel * vec2(-2.0, -2.0)).rgb;
  halo += texture(u_input, v_uv + texel * vec2(2.0, 2.0)).rgb;
  halo *= 0.045;
  vec2 d = v_uv - 0.5;
  float vignette = 1.0 - 0.22 * smoothstep(0.25, 0.75, length(d * vec2(1.0, 0.8)));
  float grain = (hash12(gl_FragCoord.xy + fract(u_time * 13.37) * 1000.0) - 0.5) * 0.025;
  outColor = vec4(max(vec3(0.0), (base + halo) * vignette + grain), 1.0);
}

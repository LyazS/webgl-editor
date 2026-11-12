#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
out vec4 outColor;
void main() {
  outColor = texture(u_input, vec2(v_uv.x, 1.0 - v_uv.y));
}
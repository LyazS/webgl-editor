#version 300 es
in vec3 a_position;
uniform vec2 u_origin;
uniform vec2 u_size;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform vec2 u_radius;
out vec2 v_unit;
void main() {
  v_unit = a_position.xy;
  vec2 local = u_center + a_position.xy * u_radius;
  vec2 pixel = u_origin + local * u_size;
  vec2 clip = vec2(pixel.x / u_resolution.x * 2.0 - 1.0, 1.0 - pixel.y / u_resolution.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}
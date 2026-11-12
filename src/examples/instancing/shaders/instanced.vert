#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
flat out int v_instance;
uniform float u_time;
void main() {
  const int columns = 10;
  int column = gl_InstanceID % columns;
  int row = gl_InstanceID / columns;
  vec2 grid = vec2(float(column), float(row));
  vec2 center = (grid + vec2(0.5) - vec2(5.0)) / vec2(5.0);
  float wave = sin(u_time * 2.0 + float(gl_InstanceID) * 0.35) * 0.035;
  vec2 position = a_position.xy * 0.075 + center + vec2(0.0, wave);
  gl_Position = vec4(position, a_position.z, 1.0);
  v_uv = a_uv;
  v_instance = gl_InstanceID;
}
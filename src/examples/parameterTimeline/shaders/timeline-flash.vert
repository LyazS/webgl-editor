#version 300 es
in vec3 a_position;
void main() { gl_Position = vec4(a_position.xy * 2.0 - 1.0, 0.0, 1.0); }
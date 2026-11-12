#version 300 es
precision highp float;

in vec2 v_uv;
uniform float u_time;
uniform float u_width;
uniform float u_height;
uniform float u_first_word;
uniform float u_second_word;
uniform float u_downbeat;
uniform float u_hit;
out vec4 outColor;

const vec3 INK = vec3(0.0392, 0.0392, 0.0431);
const vec3 SIGNAL = vec3(1.0, 0.3529, 0.1216);
const vec3 EMBER = vec3(1.0, 0.6039, 0.302);

float clamp01(float x) { return clamp(x, 0.0, 1.0); }
float easeOutExpo(float x) { return x >= 1.0 ? 1.0 : 1.0 - exp(-10.0 * x); }
float easeInCubic(float x) { return x * x * x; }
float easeInQuad(float x) { return x * x; }

float segment(float x, float a, float b) {
  return clamp01((x - a) / max(0.0001, b - a));
}

float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float iconSdf(vec2 p, int icon) {
  float circle = abs(length(p) - 0.72) - 0.055;
  float box = roundedBox(p, vec2(0.63), 0.08);
  float cross = min(abs(p.x) - 0.06, abs(p.y) - 0.06);
  float diag = min(abs(p.x + p.y) - 0.055, abs(p.x - p.y) - 0.055);
  float dot = length(p) - 0.12;
  if (icon == 0 || icon == 5 || icon == 10 || icon == 15) return circle;
  if (icon == 1 || icon == 6 || icon == 11) return box;
  if (icon == 2 || icon == 7 || icon == 12) return min(circle, cross);
  if (icon == 3 || icon == 8 || icon == 13) return min(box, diag);
  return min(circle, dot);
}

float sdStroke(vec2 p, vec2 a, vec2 b, float w) {
  vec2 q = p - a, v = b - a;
  float h = clamp(dot(q, v) / max(dot(v, v), 0.0001), 0.0, 1.0);
  return length(q - v * h) - w;
}

float glyphInk(vec2 p, int glyph) {
  float w = 0.055;
  if (glyph == 0) return abs(length(p - vec2(0.05, 0.0)) - 0.38) - w;
  if (glyph == 1) return min(sdStroke(p, vec2(-0.28, 0.48), vec2(-0.28, -0.36), w),
    min(sdStroke(p, vec2(-0.28, -0.12), vec2(-0.02, -0.34), w), sdStroke(p, vec2(-0.02, -0.34), vec2(0.30, 0.44), w)));
  if (glyph == 2) return min(sdStroke(p, vec2(-0.28, 0.06), vec2(0.30, 0.06), w),
    min(sdStroke(p, vec2(-0.28, 0.06), vec2(-0.02, -0.34), w), sdStroke(p, vec2(-0.02, -0.34), vec2(0.30, 0.44), w)));
  if (glyph == 3) return sdStroke(p, vec2(0.0, -0.52), vec2(0.0, 0.52), w);
  if (glyph == 4) return min(sdStroke(p, vec2(0.0, -0.28), vec2(0.0, 0.50), w), length(p - vec2(0.0, -0.50)) - 0.09);
  if (glyph == 5) return min(sdStroke(p, vec2(-0.28, 0.48), vec2(-0.28, -0.36), w),
    min(sdStroke(p, vec2(-0.28, -0.02), vec2(0.02, -0.34), w), sdStroke(p, vec2(0.02, -0.34), vec2(0.30, 0.44), w)));
  return min(sdStroke(p, vec2(0.0, -0.28), vec2(0.0, 0.50), w), length(p - vec2(0.0, -0.50)) - 0.09);
}

float glyphReveal(vec2 p, int glyph, float start, float t) {
  float rise = easeOutExpo(segment(t, start, start + 0.13));
  float delay = u_downbeat - 0.22 + (float(glyph % 3) / 3.0) * 0.14;
  float sink = easeInCubic(segment(t, delay, delay + 0.1));
  if (t < start || sink >= 1.0) return 0.0;
  p.y = (p.y - ((1.0 - rise) * 1.2 + sink * 1.2));
  float inside = step(-0.72, p.x) * step(p.x, 0.72) * step(-0.72, p.y) * step(p.y, 0.72);
  return (1.0 - smoothstep(0.0, 0.04, abs(glyphInk(p, glyph)))) * inside;
}

void main() {
  vec2 p = vec2(v_uv.x * u_width, (1.0 - v_uv.y) * u_height);
  vec3 col = INK;

  float t = u_time;
  float lineStart = 0.10;
  float lineEnd = 0.42;
  float retractStart = u_downbeat;
  float retractEnd = u_downbeat + 0.28;
  float head = 300.0;
  float lineAlpha = 0.0;
  if (t >= lineStart && t < retractEnd) {
    if (t < retractStart) {
      head = mix(300.0, 1500.0, easeOutExpo(segment(t, lineStart, lineEnd)));
    } else {
      float k = easeOutExpo(segment(t, retractStart, retractEnd));
      head = mix(1500.0, 300.0, k);
    }
    lineAlpha = 1.0 - 0.22 * segment(t, retractStart, retractEnd);
  }

  // The warm hairline and its soft halo.
  float lineDist = abs(p.y - 540.0);
  float inLine = step(300.0, p.x) * step(p.x, head) * (1.0 - smoothstep(1.0, 4.0, lineDist));
  float halo = step(300.0, p.x) * step(p.x, head) * exp(-lineDist * lineDist / 130.0);
  col += SIGNAL * inLine * lineAlpha * 0.90;
  col += SIGNAL * halo * lineAlpha * 0.10;

  // Caret: the H1 handoff block.
  float caret = 1.0 - smoothstep(0.0, 1.5, roundedBox(p - vec2(300.0, 540.0), vec2(7.0, 29.0), 1.5));
  float caretAlpha = t < lineStart + 0.05 ? 1.0 : 0.0;
  if (t >= retractStart - 0.04 && t < u_hit) caretAlpha = 0.82;
  col += SIGNAL * caret * caretAlpha;

  // The pen head and deterministic sputter, matching the original additive motif.
  float sparkX = head;
  float spark = exp(-dot(p - vec2(sparkX, 540.0), p - vec2(sparkX, 540.0)) / 130.0);
  if (t >= lineStart) col += EMBER * spark * (0.8 + 0.2 * sin(t * 91.7) * sin(t * 57.3));
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float birth = lineStart + fi * 0.043;
    float age = t - birth;
    if (age >= 0.0 && age < 0.42) {
      float h = hash12(vec2(fi, 17.0));
      float ang = 6.2831853 * hash12(vec2(fi, 29.0));
      vec2 origin = vec2(mix(300.0, sparkX, clamp01((birth - lineStart) / 0.32)), 540.0);
      vec2 q = origin + vec2(cos(ang), sin(ang) - 0.3) * (220.0 + 420.0 * h) * age + vec2(0.0, 260.0 * age * age);
      float streak = exp(-dot(p - q, p - q) / 18.0) * (1.0 - age / 0.42);
      col += EMBER * streak * 0.45;
    }
  }

  col = min(col, vec3(1.0));
  outColor = vec4(col, 1.0);
}

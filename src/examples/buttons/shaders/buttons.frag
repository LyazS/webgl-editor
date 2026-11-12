#version 300 es
precision highp float;
uniform vec2 u_resolution;
out vec4 outColor;

float roundedBox(vec2 p, vec2 center, vec2 halfSize, float radius) {
  vec2 q = abs(p - center) - halfSize + vec2(radius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
float lineSegment(vec2 p, vec2 a, vec2 b, float width) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return smoothstep(width, width * 0.35, length(pa - ba * h));
}
float circle(vec2 p, vec2 center, float radius) {
  return 1.0 - smoothstep(radius - 1.2, radius + 1.2, distance(p, center));
}
vec3 hexColor(vec3 color) { return color / 255.0; }

void main() {
  vec2 design = vec2(872.0, 550.0);
  float scale = min(u_resolution.x / design.x, u_resolution.y / design.y);
  vec2 origin = (u_resolution - design * scale) * 0.5;
  vec2 p = (gl_FragCoord.xy - origin) / scale;
  p.y = design.y - p.y;
  vec3 color = hexColor(vec3(17.0, 16.0, 20.0));
  if (p.x >= 0.0 && p.x <= design.x && p.y >= 0.0 && p.y <= design.y) {
    float card = 1.0 - smoothstep(0.0, 1.0, roundedBox(p, vec2(436.0, 271.0), vec2(414.0, 249.0), 6.0));
    color = mix(color, hexColor(vec3(23.0, 23.0, 27.0)), card);
    float edge = 1.0 - smoothstep(0.0, 1.2, abs(roundedBox(p, vec2(436.0, 271.0), vec2(414.0, 249.0), 6.0)));
    color = mix(color, hexColor(vec3(54.0, 54.0, 61.0)), edge);

    vec3 button = hexColor(vec3(45.0, 44.0, 49.0));
    vec2 centers[12];
    centers[0]=vec2(157.5,193.0); centers[1]=vec2(335.0,193.0); centers[2]=vec2(491.0,193.0); centers[3]=vec2(652.0,193.0);
    centers[4]=vec2(164.0,277.0); centers[5]=vec2(330.0,277.0); centers[6]=vec2(497.0,277.0); centers[7]=vec2(692.0,277.0);
    centers[8]=vec2(143.0,361.0); centers[9]=vec2(320.0,361.0); centers[10]=vec2(525.0,361.0); centers[11]=vec2(690.0,361.0);
    vec2 sizes[12];
    sizes[0]=vec2(75.5,34.0); sizes[1]=vec2(78.5,34.0); sizes[2]=vec2(54.0,34.0); sizes[3]=vec2(83.5,34.0);
    sizes[4]=vec2(82.0,34.0); sizes[5]=vec2(60.0,34.0); sizes[6]=vec2(84.0,34.0); sizes[7]=vec2(85.0,34.0);
    sizes[8]=vec2(61.0,34.0); sizes[9]=vec2(91.0,34.0); sizes[10]=vec2(90.0,34.0); sizes[11]=vec2(80.0,34.0);
    for (int i=0; i<12; i++) {
      float radius = i >= 6 ? 34.0 : 5.0;
      float mask = 1.0 - smoothstep(0.0, 1.2, roundedBox(p, centers[i], sizes[i], radius));
      color = mix(color, button, mask);
    }

    vec2 dots[6]; dots[0]=vec2(116.0,445.0); dots[1]=vec2(206.0,445.0); dots[2]=vec2(300.0,445.0); dots[3]=vec2(392.0,445.0); dots[4]=vec2(484.0,445.0); dots[5]=vec2(576.0,445.0);
    vec3 accent[6]; accent[0]=hexColor(vec3(220.0,220.0,225.0)); accent[1]=hexColor(vec3(83.0,232.0,185.0)); accent[2]=hexColor(vec3(108.0,197.0,241.0)); accent[3]=hexColor(vec3(83.0,232.0,185.0)); accent[4]=hexColor(vec3(245.0,202.0,107.0)); accent[5]=hexColor(vec3(242.0,121.0,130.0));
    for (int i=0; i<6; i++) {
      float disk = circle(p, dots[i], 34.0);
      color = mix(color, button, disk);
      float bill = 1.0 - smoothstep(2.0, 3.8, abs(distance(p, dots[i] + vec2(0.0, 1.0)) - 14.0));
      bill *= step(abs(p.y - dots[i].y), 9.0);
      color = mix(color, accent[i], bill);
      float top = lineSegment(p, dots[i] + vec2(-14.0,-10.0), dots[i] + vec2(14.0,-10.0), 1.8);
      float bottom = lineSegment(p, dots[i] + vec2(-14.0,10.0), dots[i] + vec2(14.0,10.0), 1.8);
      color = mix(color, accent[i], max(top,bottom));
      color = mix(color, accent[i], circle(p, dots[i] + vec2(-7.0,0.0), 2.8));
      color = mix(color, accent[i], circle(p, dots[i] + vec2(7.0,0.0), 2.8));
    }

    vec3 icon = hexColor(vec3(220.0,220.0,225.0));
    color = mix(color, icon, lineSegment(p, vec2(630.0,81.0), vec2(630.0,99.0), 1.4));
    color = mix(color, icon, lineSegment(p, vec2(630.0,81.0), vec2(646.0,90.0), 1.4));
    color = mix(color, icon, lineSegment(p, vec2(646.0,90.0), vec2(630.0,99.0), 1.4));
    color = mix(color, icon, lineSegment(p, vec2(667.0,84.0), vec2(676.0,79.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(676.0,79.0), vec2(686.0,84.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(667.0,84.0), vec2(667.0,96.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(686.0,84.0), vec2(686.0,96.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(667.0,96.0), vec2(676.0,102.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(676.0,102.0), vec2(686.0,96.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(708.0,82.0), vec2(708.0,98.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(708.0,82.0), vec2(724.0,82.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(724.0,82.0), vec2(724.0,96.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(724.0,96.0), vec2(716.0,101.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(716.0,101.0), vec2(708.0,101.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(754.0,80.0), vec2(766.0,80.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(766.0,80.0), vec2(774.0,88.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(774.0,88.0), vec2(766.0,98.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(766.0,98.0), vec2(754.0,98.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(790.0,90.0), vec2(797.0,83.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(797.0,83.0), vec2(804.0,90.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(790.0,90.0), vec2(797.0,97.0), 1.3));
    color = mix(color, icon, lineSegment(p, vec2(797.0,97.0), vec2(804.0,90.0), 1.3));
  }
  outColor = vec4(color, 1.0);
}
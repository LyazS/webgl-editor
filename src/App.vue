<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { WebGLExecutor } from "./core/render-graph/webgl-executor";
import type { TemporalCheckpoint } from "./core/render-graph/webgl-executor";
import { LuaRenderRuntime } from "./core/runtime/lua-runtime";

const canvas = ref<HTMLCanvasElement>();
const virtualFiles = reactive<Record<string, string>>({
  "config.json": `{
  "totalFrames": 240
}`,
  "main.lua": `local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = {
    position = "a_position",
    normal = "a_normal",
    uv0 = "a_uv",
    color0 = "a_color"
  }
})

local lineProgram = rg.program("lineProgram", {
  vertex = "shaders/line.vert",
  fragment = "shaders/line.frag"
})

local feedbackProgram = rg.program("feedbackProgram", {
  vertex = "shaders/feedback.vert",
  fragment = "shaders/feedback.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})

local positions
local normals
local uvs
local colors
local indices
local linePositions
local quadPositions
local quadUvs
local trailCell
local screenCell
local lineCell

function setup()
  positions = rg.vertexBuffer({
    data = {
      -0.58, -0.38, -0.2,
       0.58, -0.38, -0.2,
       0.0,  0.58, -0.2
    },
    type = "float32",
    usage = "dynamic"
  })
  normals = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 0, 0, 1 },
    type = "float32"
  })
  uvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0.5, 1 },
    type = "float32"
  })
  colors = rg.vertexBuffer({
    data = { 255, 80, 80, 255, 80, 220, 255, 255, 180, 100, 255, 255 },
    type = "uint8"
  })
  indices = rg.indexBuffer({ data = { 0, 1, 2 }, type = "uint16" })
  linePositions = rg.vertexBuffer({
    data = { -0.9, -0.78, 0.1, 0.9, -0.78, 0.1 },
    type = "float32"
  })
  quadPositions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  quadUvs = rg.vertexBuffer({
    data = { 0, 0, 1, 0, 0, 1, 1, 1 },
    type = "float32"
  })

  local triangle = rg.mesh({
    vertexBuffers = { position = positions, normal = normals, uv0 = uvs, color0 = colors },
    indexBuffer = indices,
    topology = "triangles",
    vertexCount = 3,
    indexCount = 3,
    attributes = { color0 = { components = 4, type = "uint8", normalized = true } }
  })
  local line = rg.mesh({
    vertexBuffers = { position = linePositions },
    topology = "lines",
    vertexCount = 2
  })
  local screenQuad = rg.mesh({
    vertexBuffers = { position = quadPositions, uv0 = quadUvs },
    topology = "triangle-strip",
    vertexCount = 4
  })

  local trail = rg.historyTarget("trail", {
    capacity = 16,
    width = "viewport",
    height = "viewport",
    format = "rgba8"
  })
  trail:clear({ 0.0, 0.0, 0.0, 1.0 })
  trailCell = trail:addDrawCell("trailCell", { mesh = triangle, program = meshProgram })

  local screen = rg.renderTarget("screen")
  screen:clear({ 0.025, 0.035, 0.06, 1.0 })
  screenCell = screen:addDrawCell("screenCell", {
    mesh = screenQuad,
    program = feedbackProgram,
    textures = {
      u_history1 = { name = "trail", offset = 1 },
      u_history2 = { name = "trail", offset = 2 },
      u_history3 = { name = "trail", offset = 3 },
      u_history4 = { name = "trail", offset = 4 },
      u_history5 = { name = "trail", offset = 5 },
      u_history6 = { name = "trail", offset = 6 },
      u_history7 = { name = "trail", offset = 7 },
      u_history8 = { name = "trail", offset = 8 }
    }
  })
  lineCell = screen:addDrawCell("lineCell", { mesh = line, program = lineProgram })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.32
  positions:setData({
    -0.58 + offset, -0.38, -0.2,
     0.58 + offset, -0.38, -0.2,
     0.0 + offset,  0.58, -0.2
  })
  trailCell:setUniform("u_transform", {
    type = "mat4",
    value = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 }
  })
  trailCell:setUniform("u_tint", { type = "vec4", value = { 1, 1, 1, 1 } })
  lineCell:setUniform("u_color", { type = "vec4", value = { 0.95, 0.82, 0.25, 1.0 } })
end`
  ,
  "shaders/mesh.vert": `#version 300 es
in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;
in vec4 a_color;
uniform mat4 u_transform;
out vec3 v_normal;
out vec2 v_uv;
out vec4 v_color;
void main() {
  gl_Position = u_transform * vec4(a_position, 1.0);
  v_normal = a_normal;
  v_uv = a_uv;
  v_color = a_color;
}`,
  "shaders/mesh.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_normal;
in vec4 v_color;
uniform vec4 u_tint;
out vec4 outColor;
void main() {
  float light = 0.65 + max(v_normal.z, 0.0) * 0.35;
  outColor = vec4(v_uv, 0.72, 1.0) * v_color * u_tint * light;
}`,
  "shaders/line.vert": `#version 300 es
in vec3 a_position;
void main() {
  gl_Position = vec4(a_position, 1.0);
}`,
  "shaders/line.frag": `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`,
  "shaders/feedback.vert": `#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 1.0);
  v_uv = a_uv;
}`,
  "shaders/feedback.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_history1;
uniform sampler2D u_history2;
uniform sampler2D u_history3;
uniform sampler2D u_history4;
uniform sampler2D u_history5;
uniform sampler2D u_history6;
uniform sampler2D u_history7;
uniform sampler2D u_history8;
out vec4 outColor;
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 trail = vec4(0.0);
  trail += texture(u_history1, uv) * 0.34;
  trail += texture(u_history2, uv) * 0.24;
  trail += texture(u_history3, uv) * 0.16;
  trail += texture(u_history4, uv) * 0.10;
  trail += texture(u_history5, uv) * 0.065;
  trail += texture(u_history6, uv) * 0.04;
  trail += texture(u_history7, uv) * 0.025;
  trail += texture(u_history8, uv) * 0.015;
  outColor = trail;
}`,
  "shaders/copy.vert": `#version 300 es
in vec3 a_position;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 1.0);
  v_uv = a_uv;
}`,
  "shaders/copy.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_input;
out vec4 outColor;
void main() {
  outColor = texture(u_input, vec2(v_uv.x, 1.0 - v_uv.y));
}`,
  "shaders/accum.frag": `#version 300 es
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
}`,
  "shaders/instanced.vert": `#version 300 es
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
}`,
  "shaders/instanced.frag": `#version 300 es
precision highp float;
in vec2 v_uv;
flat in int v_instance;
out vec4 outColor;
void main() {
  float phase = float(v_instance) * 0.17;
  vec3 color = 0.5 + 0.5 * cos(vec3(phase, phase + 2.0, phase + 4.0));
  float glow = 0.75 + 0.25 * sin(v_uv.x * 3.14159);
  outColor = vec4(color * glow, 1.0);
}`,
  "shaders/buttons.vert": `#version 300 es
in vec3 a_position;
void main() { gl_Position = vec4(a_position, 1.0); }`,
  "shaders/buttons.frag": `#version 300 es
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
}`,
  "shaders/typography.vert": `#version 300 es
in vec3 a_position;
out vec2 v_uv;
void main() { gl_Position = vec4(a_position, 1.0); v_uv = a_position.xy * 0.5 + 0.5; }`,
  "shaders/typography.frag": `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform sampler2D u_text;
in vec2 v_uv;
out vec4 outColor;
float box(vec2 p, vec2 c, vec2 h, float r) { vec2 q=abs(p-c)-h+vec2(r); return length(max(q,0.0))+min(max(q.x,q.y),0.0)-r; }
float lineSeg(vec2 p, vec2 a, vec2 b, float w) { vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return smoothstep(w,w*.35,length(pa-ba*h)); }
vec3 c(vec3 v) { return v/255.0; }
void icon(inout vec3 color, vec2 p, float x, float y) {
  vec3 ink=c(vec3(220.0));
  color=mix(color,ink,lineSeg(p,vec2(x,y),vec2(x,y+18.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x,y),vec2(x+16.0,y+9.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x+16.0,y+9.0),vec2(x,y+18.0),1.3));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+3.0),vec2(x+46.0,y-2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+46.0,y-2.0),vec2(x+56.0,y+3.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+3.0),vec2(x+37.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+56.0,y+3.0),vec2(x+56.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+37.0,y+15.0),vec2(x+46.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+46.0,y+21.0),vec2(x+56.0,y+15.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+79.0,y+2.0),vec2(x+95.0,y+2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+79.0,y+2.0),vec2(x+79.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+95.0,y+2.0),vec2(x+95.0,y+16.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+95.0,y+16.0),vec2(x+87.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+87.0,y+21.0),vec2(x+79.0,y+21.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+124.0,y),vec2(x+136.0,y),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+136.0,y),vec2(x+144.0,y+8.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+144.0,y+8.0),vec2(x+136.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+136.0,y+18.0),vec2(x+124.0,y+18.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+160.0,y+9.0),vec2(x+167.0,y+2.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+167.0,y+2.0),vec2(x+174.0,y+9.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+160.0,y+9.0),vec2(x+167.0,y+16.0),1.2));
  color=mix(color,ink,lineSeg(p,vec2(x+167.0,y+16.0),vec2(x+174.0,y+9.0),1.2));
}
void main() {
  vec2 design=vec2(1740.0,1042.0); float s=min(u_resolution.x/design.x,u_resolution.y/design.y); vec2 o=(u_resolution-design*s)*.5; vec2 p=(gl_FragCoord.xy-o)/s; p.y=design.y-p.y;
  vec3 color=c(vec3(16.0,15.0,19.0));
  if(p.x>=0.0&&p.x<=design.x&&p.y>=0.0&&p.y<=design.y){
    vec2 cards[3]; cards[0]=vec2(443.0,245.0); cards[1]=vec2(1307.0,348.0); cards[2]=vec2(443.0,739.0); vec2 sizes[3]; sizes[0]=vec2(413.0,217.0); sizes[1]=vec2(413.0,320.0); sizes[2]=vec2(413.0,243.0);
    for(int i=0;i<3;i++){float d=box(p,cards[i],sizes[i],6.0);float fill=1.0-smoothstep(0.0,1.0,d);float edge=1.0-smoothstep(0.0,1.3,abs(d));color=mix(color,c(vec3(23.0,23.0,27.0)),fill);color=mix(color,c(vec3(54.0,54.0,61.0)),edge);}
    icon(color,p,630.0,86.0); icon(color,p,1492.0,86.0); icon(color,p,630.0,580.0);
  }
  vec4 textSample = texture(u_text, v_uv);
  float gradientRegion = step(65.0, p.x) * step(p.x, 400.0) * step(865.0, p.y) * step(p.y, 950.0);
  vec3 gradientColor = mix(c(vec3(240.0,45.0,35.0)), c(vec3(50.0,75.0,245.0)), clamp((p.x - 65.0) / 335.0, 0.0, 1.0));
  vec3 textColor = mix(textSample.rgb, gradientColor * textSample.a, gradientRegion);
  outColor = vec4(mix(color, textColor, textSample.a), 1.0);
}`,
});
const fileNames = [
  "config.json",
  "main.lua",
  "shaders/mesh.vert",
  "shaders/mesh.frag",
  "shaders/line.vert",
  "shaders/line.frag",
  "shaders/feedback.vert",
  "shaders/feedback.frag",
  "shaders/copy.vert",
  "shaders/copy.frag",
  "shaders/accum.frag",
  "shaders/instanced.vert",
  "shaders/instanced.frag",
  "shaders/buttons.vert",
  "shaders/buttons.frag",
  "shaders/typography.vert",
  "shaders/typography.frag",
];
const examples: Record<string, { label: string; main: string }> = {
  history: { label: "HistoryTarget · 8 帧拖影", main: virtualFiles["main.lua"] },
  renderTarget: {
    label: "RenderTarget · 普通离屏渲染",
    main: `local rg = require("render_graph")

local meshProgram = rg.program("meshProgram", {
  vertex = "shaders/mesh.vert",
  fragment = "shaders/mesh.frag",
  vertexInputs = { position = "a_position", normal = "a_normal", uv0 = "a_uv", color0 = "a_color" }
})
local copyProgram = rg.program("copyProgram", {
  vertex = "shaders/copy.vert",
  fragment = "shaders/copy.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local positions
local triangleCell

function setup()
  positions = rg.vertexBuffer({ data = { -0.58, -0.38, 0, 0.58, -0.38, 0, 0, 0.58, 0 }, type = "float32", usage = "dynamic" })
  local normals = rg.vertexBuffer({ data = { 0,0,1, 0,0,1, 0,0,1 }, type = "float32" })
  local uvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0.5,1 }, type = "float32" })
  local colors = rg.vertexBuffer({ data = { 255,80,80,255, 80,220,255,255, 180,100,255,255 }, type = "uint8" })
  local indices = rg.indexBuffer({ data = { 0,1,2 }, type = "uint16" })
  local quadPositions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local quadUvs = rg.vertexBuffer({ data = { 0,0, 1,0, 0,1, 1,1 }, type = "float32" })
  local triangle = rg.mesh({ vertexBuffers = { position=positions, normal=normals, uv0=uvs, color0=colors }, indexBuffer=indices, topology="triangles", vertexCount=3, indexCount=3, attributes={ color0={components=4,type="uint8",normalized=true} } })
  local quad = rg.mesh({ vertexBuffers = { position=quadPositions, uv0=quadUvs }, topology="triangle-strip", vertexCount=4 })
  local target = rg.renderTarget("sceneColor", { width="viewport", height="viewport", format="rgba8", depth=true })
  target:clear({ 0.02, 0.03, 0.05, 1.0 })
  triangleCell = target:addDrawCell("triangle", { mesh=triangle, program="meshProgram" })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="sceneColor" } })
  return {}
end

function render(ctx, state)
  local offset = math.sin(ctx.frame / ctx.FPS * 1.5) * 0.3
  positions:setData({ -0.58+offset,-0.38,0, 0.58+offset,-0.38,0, 0+offset,0.58,0 })
  triangleCell:setUniform("u_transform", { type="mat4", value={1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1} })
  triangleCell:setUniform("u_tint", { type="vec4", value={1,1,1,1} })
end`
  },
  accumulation: {
    label: "AccumulationTarget · 累积反馈",
    main: `local rg = require("render_graph")

local accumProgram = rg.program("accumProgram", { vertex="shaders/feedback.vert", fragment="shaders/accum.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local copyProgram = rg.program("copyProgram", { vertex="shaders/copy.vert", fragment="shaders/copy.frag", vertexInputs={position="a_position", uv0="a_uv"} })
local accumulationCell

function setup()
  local quadPositions = rg.vertexBuffer({ data={-1,-1,0, 1,-1,0, -1,1,0, 1,1,0}, type="float32" })
  local quadUvs = rg.vertexBuffer({ data={0,0, 1,0, 0,1, 1,1}, type="float32" })
  local quad = rg.mesh({ vertexBuffers={position=quadPositions, uv0=quadUvs}, topology="triangle-strip", vertexCount=4 })
  local accumulation = rg.accumulationTarget("paint", { width="viewport", height="viewport", format="rgba8" })
  accumulationCell = accumulation:addDrawCell("accumulate", { mesh=quad, program="accumProgram", textures={ u_previous={name="paint", offset=1} } })
  local screen = rg.renderTarget("screen")
  screen:addDrawCell("copy", { mesh=quad, program="copyProgram", textures={ u_input="paint" } })
  return {}
end

function render(ctx, state)
  local x = 0.5 + math.sin(ctx.frame / ctx.FPS * 1.5) * 0.35
  local y = 0.5 + math.cos(ctx.frame / ctx.FPS * 1.2) * 0.25
  accumulationCell:setUniform("u_center", { type="vec2", value={x,y} })
end`
  },
  instancing: {
    label: "Instancing · 100 个实例",
    main: `local rg = require("render_graph")

local instancedProgram = rg.program("instancedProgram", {
  vertex = "shaders/instanced.vert",
  fragment = "shaders/instanced.frag",
  vertexInputs = { position = "a_position", uv0 = "a_uv" }
})
local instanceCell

function setup()
  local positions = rg.vertexBuffer({
    data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 },
    type = "float32"
  })
  local uvs = rg.vertexBuffer({
    data = { 0,0, 1,0, 0,1, 1,1 },
    type = "float32"
  })
  local quad = rg.mesh({
    vertexBuffers = { position = positions, uv0 = uvs },
    topology = "triangle-strip",
    vertexCount = 4
  })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.015, 0.02, 0.045, 1.0 })
  instanceCell = screen:addDrawCell("instances", {
    mesh = quad,
    program = "instancedProgram",
    instanceCount = 100
  })
  return {}
end

function render(ctx, state)
  instanceCell:setUniform("u_time", {
    type = "float",
    value = ctx.frame / ctx.FPS
  })
end`
  },
  buttons: {
    label: "Button Showcase · 参考图复刻",
    main: `local rg = require("render_graph")

local uiProgram = rg.program("buttonShowcase", {
  vertex = "shaders/buttons.vert",
  fragment = "shaders/buttons.frag",
  vertexInputs = { position = "a_position" }
})

local uiCell
local titleCell
local labels = {}
local designWidth, designHeight = 872, 550

local function place(cell, x, y, size, scale, ox, oy)
  cell:setPosition({ ox + x * scale, oy + y * scale })
  cell:setStyle({ size = size * scale })
end

function setup()
  local font = rg.font("button-ui", { family = "Arial, sans-serif" })
  local positions = rg.vertexBuffer({
    data = { -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0 },
    type = "float32"
  })
  local quad = rg.mesh({ vertexBuffers = { position = positions }, topology = "triangle-strip", vertexCount = 4 })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.067, 0.063, 0.078, 1.0 })
  uiCell = screen:addDrawCell("button-background", { mesh = quad, program = "buttonShowcase" })

  titleCell = screen:addTextCell("button-title", { font = font, text = "次次要按钮", size = 38, position = { 82, 73 }, color = { 0.91, 0.90, 0.93, 1.0 }, blend = "premultiplied" })
  local texts = {
    { "Default", 110, 181, 30, { 0.86, 0.85, 0.88, 1.0 } }, { "Primary", 285, 181, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Info", 467, 181, 30, { 0.43, 0.77, 0.95, 1.0 } }, { "Success", 598, 181, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Warning", 110, 265, 30, { 0.96, 0.79, 0.42, 1.0 } }, { "Error", 298, 265, 30, { 0.95, 0.47, 0.51, 1.0 } },
    { "Default", 450, 265, 30, { 0.86, 0.85, 0.88, 1.0 } }, { "Primary", 640, 265, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Info", 116, 349, 30, { 0.43, 0.77, 0.95, 1.0 } }, { "Success", 263, 349, 30, { 0.36, 0.91, 0.75, 1.0 } },
    { "Warning", 470, 349, 30, { 0.96, 0.79, 0.42, 1.0 } }, { "Error", 675, 349, 30, { 0.95, 0.47, 0.51, 1.0 } }
  }
  for i, item in ipairs(texts) do
    labels[i] = screen:addTextCell("label" .. i, { font = font, text = item[1], size = item[4], position = { item[2], item[3] }, color = item[5], blend = "premultiplied" })
  end
  return {}
end

function render(ctx, state)
  local scale = math.min(ctx.width / designWidth, ctx.height / designHeight)
  local ox = (ctx.width - designWidth * scale) * 0.5
  local oy = (ctx.height - designHeight * scale) * 0.5
  uiCell:setUniform("u_resolution", { type = "vec2", value = { ctx.width * (ctx.pixelRatio or 1), ctx.height * (ctx.pixelRatio or 1) } })
  place(titleCell, 82, 73, 38, scale, ox, oy)
  local positions = {
    { 110, 181, 30 }, { 285, 181, 30 }, { 467, 181, 30 }, { 598, 181, 30 },
    { 110, 265, 30 }, { 298, 265, 30 }, { 450, 265, 30 }, { 640, 265, 30 },
    { 116, 349, 30 }, { 263, 349, 30 }, { 470, 349, 30 }, { 675, 349, 30 }
  }
  for i, item in ipairs(positions) do place(labels[i], item[1], item[2], item[3], scale, ox, oy) end
end`
  },
  typography: {
    label: "Typography Showcase · 字体样式",
    main: `local rg = require("render_graph")

local program = rg.program("typography", {
  vertex = "shaders/typography.vert",
  fragment = "shaders/typography.frag",
  vertexInputs = { position = "a_position" }
})
local backgroundCell
local texts = {}
local designWidth, designHeight = 1740, 1042

local function place(cell, x, y, size, scale, ox, oy)
  cell:setPosition({ ox + x * scale, oy + y * scale })
  cell:setStyle({ size = size * scale })
end

function setup()
  local font = rg.font("typography-ui", { family = "Arial, sans-serif" })
  local positions = rg.vertexBuffer({ data = { -1,-1,0, 1,-1,0, -1,1,0, 1,1,0 }, type = "float32" })
  local quad = rg.mesh({ vertexBuffers = { position = positions }, topology = "triangle-strip", vertexCount = 4 })
  local textLayer = rg.renderTarget("textLayer")
  textLayer:clear({ 0.0, 0.0, 0.0, 0.0 })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.063, 0.059, 0.075, 1.0 })
  backgroundCell = screen:addDrawCell("background", { mesh = quad, program = "typography", textures = { u_text = "textLayer" } })

  texts[1] = textLayer:addTextCell("basic-title", { font=font, text="基础用法", size=38, position={80,78}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[2] = textLayer:addTextCell("basic-body", { font=font, text="它有不同的类型。", size=28, position={80,174}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[3] = textLayer:addTextCell("basic-error", { font=font, text="炸了", size=30, position={80,250}, color={.96,.32,.38,1}, blend="premultiplied" })
  texts[4] = textLayer:addTextCell("basic-info", { font=font, text="噢", size=30, position={80,294}, color={.25,.62,.86,1}, blend="premultiplied" })
  texts[5] = textLayer:addTextCell("basic-warning", { font=font, text="注意", size=30, position={80,338}, color={1,.58,.08,1}, blend="premultiplied" })
  texts[6] = textLayer:addTextCell("basic-success", { font=font, text="成了", size=30, position={80,382}, color={.18,.76,.58,1}, blend="premultiplied" })

  texts[7] = textLayer:addTextCell("size-title", { font=font, text="尺寸", size=38, position={940,78}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[8] = textLayer:addTextCell("size-body", { font=font, text="其实用 CSS 也挺方便的。", size=28, position={940,174}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[9] = textLayer:addTextCell("live-blue", { font=font, text="Live Forever", size=72, position={940,273}, color={.29,.62,.86,1}, blend="premultiplied" })
  texts[10] = textLayer:addTextCell("live-red", { font=font, text="Live Forever", size=72, position={940,387}, color={.88,.28,.37,1}, blend="premultiplied" })
  texts[11] = textLayer:addTextCell("married", { font=font, text="Married with Children", size=48, position={940,491}, color={1,.58,.08,1}, blend="premultiplied" })
  texts[12] = textLayer:addTextCell("ussr", { font=font, text="Back in the USSR", size=48, position={940,568}, color={.22,.78,.63,1}, blend="premultiplied" })

  texts[13] = textLayer:addTextCell("custom-title", { font=font, text="定制", size=38, position={80,548}, color={.92,.91,.94,1}, blend="premultiplied" })
  texts[14] = textLayer:addTextCell("custom-body", { font=font, text="靠你了。", size=28, position={80,643}, color={.82,.81,.84,1}, blend="premultiplied" })
  texts[15] = textLayer:addTextCell("custom-one", { font=font, text="定制颜色", size=48, position={80,726}, color={.55,.54,.57,1}, blend="premultiplied" })
  texts[16] = textLayer:addTextCell("custom-two", { font=font, text="定制颜色", size=48, position={80,807}, color={.55,.54,.57,1}, blend="premultiplied" })
  texts[17] = textLayer:addTextCell("rainbow-text", { font=font, text="瞎写的颜色", size=48, position={80,883}, color={.88,.88,.88,1}, blend="premultiplied" })
  return {}
end

function render(ctx, state)
  local scale = math.min(ctx.width / designWidth, ctx.height / designHeight)
  local ox = (ctx.width - designWidth * scale) * 0.5
  local oy = (ctx.height - designHeight * scale) * 0.5
  backgroundCell:setUniform("u_resolution", { type="vec2", value={ctx.width * (ctx.pixelRatio or 1), ctx.height * (ctx.pixelRatio or 1)} })
  local positions = {
    {80,78,38},{80,174,28},{80,250,30},{80,294,30},{80,338,30},{80,382,30},
    {940,78,38},{940,174,28},{940,273,72},{940,387,72},{940,491,48},{940,568,48},
    {80,548,38},{80,643,28},{80,726,48},{80,807,48},{80,883,48}
  }
  for i, item in ipairs(positions) do place(texts[i], item[1], item[2], item[3], scale, ox, oy) end
end`
  },
  text: {
    label: "Text · 动态字体图层",
    main: `local rg = require("render_graph")

local textCell

function setup()
  local font = rg.font("ui", { family = "Inter, system-ui, sans-serif" })
  local screen = rg.renderTarget("screen")
  screen:clear({ 0.015, 0.02, 0.045, 1.0 })
  textCell = screen:addTextCell("title", {
    font = font,
    text = "Render Graph 字体渲染",
    size = 42,
    position = { 40, 44 },
    color = { 0.45, 0.85, 1.0, 1.0 },
    lineHeight = 1.2,
    blend = "premultiplied"
  })
  return {}
end

function render(ctx, state)
  textCell:setText("Render Graph · Frame " .. ctx.frame)
  textCell:setPosition({ 40, 44 + math.sin(ctx.frame / ctx.FPS * 2.0) * 8 })
end`
  }
};
const selectedExample = ref("history");
const activeFile = ref("main.lua");
const activeContent = computed(() => virtualFiles[activeFile.value] ?? "");
const currentFrame = ref(0);
const playing = ref(false);
const loopPlayback = ref(true);
const FPS = 30;
const totalFrames = ref(240);
const maxFrame = computed(() => totalFrames.value - 1);
const status = ref("Ready");
const passCount = ref(0);
const resourceCount = ref(0);
const luaRuntime = new LuaRenderRuntime();
const checkpointInterval = 30;
const checkpoints = new Map<number, { state: unknown; temporal: TemporalCheckpoint }>();
let executor: WebGLExecutor | undefined;
let animationFrame = 0;

async function buildGraph() {
  const graph = await luaRuntime.buildGraph(
    currentFrame.value,
    canvas.value?.clientWidth ?? 1,
    canvas.value?.clientHeight ?? 1,
    totalFrames.value,
    window.devicePixelRatio || 1
  );
  passCount.value = graph.passes.length;
  resourceCount.value = graph.resources.size;
  return graph;
}

async function render(updateStatus = true): Promise<boolean> {
  if (!executor || !canvas.value) return false;
  try {
    const graph = await buildGraph();
    await executor.execute(graph, canvas.value.clientWidth, canvas.value.clientHeight, currentFrame.value);
    const nextFrame = currentFrame.value + 1;
    if (nextFrame % checkpointInterval === 0) {
      checkpoints.set(nextFrame, {
        state: luaRuntime.snapshotState(),
        temporal: executor.createTemporalCheckpoint()
      });
    }
    if (updateStatus) status.value = `Frame ${currentFrame.value} · ${graph.passes.length} pass`;
    return true;
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

async function compile() {
  try {
    const config = JSON.parse(virtualFiles["config.json"]) as { totalFrames?: unknown };
    if (typeof config.totalFrames !== "number" || !Number.isInteger(config.totalFrames) || config.totalFrames <= 0) {
      throw new Error("config.json: totalFrames must be a positive integer");
    }
    await luaRuntime.compile(virtualFiles["main.lua"], virtualFiles);
    checkpoints.clear();
    executor?.resetHistory();
    totalFrames.value = config.totalFrames;
    currentFrame.value = Math.min(currentFrame.value, totalFrames.value - 1);
    status.value = "Graph compiled";
    await render();
  } catch (error) {
    status.value = error instanceof Error ? `Compile error: ${error.message}` : String(error);
  }
}

async function changeExample(name: string): Promise<void> {
  const example = examples[name];
  if (!example) return;
  selectedExample.value = name;
  virtualFiles["main.lua"] = example.main;
  activeFile.value = "main.lua";
  await compile();
}

function onExampleChange(event: Event): void {
  void changeExample((event.target as HTMLSelectElement).value);
}

async function seekToFrame(targetFrame: number): Promise<void> {
  const previousFrame = currentFrame.value;
  playing.value = false;
  cancelAnimationFrame(animationFrame);
  if (targetFrame === previousFrame + 1) {
    currentFrame.value = targetFrame;
    await render();
    return;
  }

  status.value = `Rebuilding history to frame ${targetFrame}`;
  const checkpointFrame = [...checkpoints.keys()]
    .filter((frame) => frame <= targetFrame)
    .sort((a, b) => b - a)[0];
  const checkpoint = checkpointFrame === undefined ? undefined : checkpoints.get(checkpointFrame);
  await luaRuntime.recompile();
  executor?.resetHistory();
  currentFrame.value = 0;
  if (!(await render(false))) return;
  let firstFrame = 1;
  if (checkpoint && checkpointFrame !== undefined && executor) {
    luaRuntime.restoreState(checkpoint.state);
    executor.restoreTemporalCheckpoint(checkpoint.temporal);
    currentFrame.value = checkpointFrame;
    firstFrame = checkpointFrame;
  }
  for (let frame = firstFrame; frame <= targetFrame; frame += 1) {
    currentFrame.value = frame;
    if (!(await render(false))) return;
  }
  status.value = `Frame ${targetFrame} · history rebuilt`;
}

async function seek(event: Event) {
  await seekToFrame(Number((event.target as HTMLInputElement).value));
}

function tick() {
  if (!playing.value) return;
  if (currentFrame.value + 1 >= totalFrames.value) {
    if (!loopPlayback.value) {
      playing.value = false;
      status.value = `Finished at frame ${currentFrame.value}`;
      return;
    }
    void seekToFrame(0).then(() => {
      if (loopPlayback.value) {
        playing.value = true;
        animationFrame = requestAnimationFrame(tick);
      }
    });
    return;
  } else {
    currentFrame.value += 1;
  }
  void render();
  animationFrame = requestAnimationFrame(tick);
}

function updateActiveFile(event: Event) {
  virtualFiles[activeFile.value] = (event.target as HTMLTextAreaElement).value;
}

function selectFile(fileName: string) {
  activeFile.value = fileName;
}

function togglePlayback() {
  playing.value = !playing.value;
  if (playing.value) {
    status.value = "Playing";
    animationFrame = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(animationFrame);
    status.value = `Paused at frame ${currentFrame.value}`;
  }
}

onMounted(async () => {
  await nextTick();
  if (!canvas.value) return;
  try {
    executor = new WebGLExecutor(canvas.value);
    const config = JSON.parse(virtualFiles["config.json"]) as { totalFrames?: unknown };
    if (typeof config.totalFrames !== "number" || !Number.isInteger(config.totalFrames) || config.totalFrames <= 0) {
      throw new Error("config.json: totalFrames must be a positive integer");
    }
    await luaRuntime.compile(virtualFiles["main.lua"], virtualFiles);
    totalFrames.value = config.totalFrames;
    await render();
  } catch (error) {
    status.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame);
  void luaRuntime.close();
});
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">WEBGL / RENDER GRAPH</div>
        <h1>Deterministic Canvas</h1>
      </div>
      <div class="topbar-actions">
        <select :value="selectedExample" aria-label="Render target example" @change="onExampleChange">
          <option v-for="(example, name) in examples" :key="name" :value="name">{{ example.label }}</option>
        </select>
        <div class="status-pill"><span class="status-dot" />{{ status }}</div>
      </div>
    </header>

    <section class="workspace">
      <aside class="editor-panel panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">SCRIPT</span>
            <strong>{{ activeFile }}</strong>
          </div>
          <button class="compile-button" @click="compile">Compile</button>
        </div>
        <div class="editor-body">
          <nav class="file-tree" aria-label="Virtual project files">
            <div class="tree-title">PROJECT</div>
            <button
              v-for="fileName in fileNames"
              :key="fileName"
              class="file-item"
              :class="{ active: activeFile === fileName }"
              @click="selectFile(fileName)"
            >
              <span class="file-icon">{{ fileName.endsWith(".json") ? "{}" : "◈" }}</span>{{ fileName }}
            </button>
          </nav>
          <textarea :value="activeContent" spellcheck="false" :aria-label="activeFile" @input="updateActiveFile" />
        </div>
        <div class="editor-footer">
          <span>Lua SDK boundary</span>
          <span>Graph IR ready</span>
        </div>
      </aside>

      <section class="preview-panel panel">
        <div class="panel-header">
          <div>
            <span class="panel-kicker">PREVIEW</span>
            <strong>WebGL2 Canvas</strong>
          </div>
          <div class="preview-actions">
            <div class="graph-stats">{{ passCount }} pass · {{ resourceCount }} resource</div>
            <button class="play-button" @click="togglePlayback">{{ playing ? "Pause" : "Play" }}</button>
          </div>
        </div>
        <div class="canvas-wrap"><canvas ref="canvas" /></div>
        <div class="timeline">
          <div class="timeline-label"><span>FRAME</span><strong>{{ currentFrame }} / {{ maxFrame }}</strong></div>
          <input type="range" min="0" :max="maxFrame" :value="currentFrame" @input="seek" />
          <div class="timeline-end">{{ maxFrame }}</div>
          <label class="loop-control"><input v-model="loopPlayback" type="checkbox" /> Loop</label>
          <span class="timeline-config">{{ totalFrames }} frames · {{ FPS }} FPS</span>
        </div>
      </section>
    </section>
  </main>
</template>

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';

const wasmPath = fileURLToPath(new URL('../node_modules/@playcanvas/msdfgen-wasm/dist/msdfgen.wasm', import.meta.url));
const server = await createServer({
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{
    name: 'node-msdf-test-url', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/msdfgen.wasm?url')) return '\0node-msdf-test-url'; },
    load(id) { if (id === '\0node-msdf-test-url') return `export default ${JSON.stringify(wasmPath)}`; }
  }]
});
let TextRenderer, TextFont, WebGLExecutor;
try {
  ({ TextRenderer } = await server.ssrLoadModule('/src/core/render-graph/text-renderer.ts'));
  ({ TextFont } = await server.ssrLoadModule('/src/core/render-graph/text-layout.ts'));
  ({ WebGLExecutor } = await server.ssrLoadModule('/src/core/render-graph/webgl-executor.ts'));
} finally { await server.close(); }
const data = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC-Regular.otf', import.meta.url)));

// Record resource lifetime and actual uploads rather than assuming dirty flags work.
function mockGl() {
  let nextId = 0, boundBuffer, boundTexture;
  const buffers = new Set(), textures = new Set();
  const uploads = [], allocations = [], draws = [], glyphUploads = [];
  const gl = new Proxy({
    buffers, textures, uploads, allocations, draws, glyphUploads,
    createBuffer: () => { const b = { id: ++nextId }; buffers.add(b); return b; },
    deleteBuffer: (b) => buffers.delete(b),
    createTexture: () => { const t = { id: ++nextId }; textures.add(t); return t; },
    deleteTexture: (t) => textures.delete(t),
    bindTexture: (_, t) => { boundTexture = t; },
    createProgram: () => ({}), createShader: () => ({}), createVertexArray: () => ({}),
    getShaderParameter: () => true, getProgramParameter: () => true,
    getAttribLocation: (_, name) => ['a_corner', 'a_rect', 'a_uvRect', 'a_offset', 'a_color'].indexOf(name),
    getUniformLocation: (_, name) => name,
    getParameter: () => 4096,
    bindBuffer: (_, b) => { boundBuffer = b; },
    bufferData: (_, value) => allocations.push({ buffer: boundBuffer, value }),
    bufferSubData: (_, offset, value) => uploads.push({ buffer: boundBuffer, offset, data: new Float32Array(value) }),
    drawArraysInstanced: (...args) => { assert.ok(textures.has(boundTexture), "draw must not sample an evicted atlas"); draws.push(args); },
    texSubImage2D: (...args) => glyphUploads.push(args),
    reset() { uploads.length = allocations.length = draws.length = glyphUploads.length = 0; }
  }, { get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'string' && prop.toUpperCase() === prop) return prop;
    return () => {};
  }});
  return gl;
}
function fixture(atlas) {
  const font = { id: 'font', kind: 'font', family: 'Noto', data, atlas };
  const graph = { resources: new Map([['font', font]]) };
  const a = { id: 'a', kind: 'text-layout', font: 'font', text: 'ffi中文', position: [10, 20], style: { size: 32, color: [1, 0, 0, 0.5] } };
  const b = { id: 'b', kind: 'text-layout', font: 'font', text: 'ffi中文', position: [80, 20], style: { size: 32, color: [0, 1, 0, 0.5] } };
  return { font, graph, a, b };
}

test('layout cache ignores position/color; resizing and wrapping reuse font shaping', () => {
  const font = new TextFont(data), style = { size: 32, color: [1, 1, 1, 1] };
  const local = font.layout('ffi中文', style);
  assert.strictEqual(font.layout('ffi中文', { ...style, color: [0, 0, 0, 0.2] }), local);
  const shaped = [...font.shapes.values()][0];
  assert.notStrictEqual(font.layout('ffi中文', { ...style, size: 64, maxWidth: 90 }), local);
  assert.equal(font.shapes.size, 1);
  assert.strictEqual([...font.shapes.values()][0], shaped);
  assert.equal(local.glyphs.length, 3, 'ffi remains one shaped glyph');
  assert.equal(font.layout('ffi中文', style, ['liga=0']).glyphs.length, 5);
  for (let i = 0; i < 270; i++) font.layout(String(i), style);
  assert.equal(font.shapes.size, 256); assert.equal(font.layouts.size, 256);
});

test('adjacent cells batch across colors; unchanged frames upload nothing; paint changes only update the affected cell', async () => {
  const gl = mockGl(), renderer = new TextRenderer(gl), { graph, a, b } = fixture(), key = {};
  const cells = [{ layout: a }, { layout: b }];
  try {
    await renderer.renderBatch(cells, graph, 300, 100, key);
    assert.equal(gl.draws.length, 1);
    const batch = renderer.runs.get(key).batches[0];
    gl.reset();
    await renderer.renderBatch(cells, graph, 300, 100, key);
    assert.equal(gl.draws.length, 1); assert.equal(gl.uploads.length, 0); assert.equal(gl.allocations.length, 0); assert.equal(gl.glyphUploads.length, 0);
    b.position[0] = 100; b.style.color[2] = 0.75;
    gl.reset(); await renderer.renderBatch(cells, graph, 600, 200, key);
    assert.equal(gl.uploads.length, 1);
    assert.strictEqual(gl.uploads[0].buffer, batch.paint);
    assert.equal(gl.uploads[0].offset, 3 * 6 * 4);
    assert.deepEqual([...gl.uploads[0].data.slice(0, 6)], [100, 20, 0, 1, 0.75, 0.5]);
    assert.equal(gl.glyphUploads.length, 0);
    const font = [...renderer.fonts.values()][0].text, shape = [...font.shapes.values()][0];
    gl.reset(); a.style.size = 48;
    await renderer.renderBatch(cells, graph, 300, 100, key);
    assert.ok(gl.uploads.some(u => u.buffer === batch.geometry));
    assert.equal(gl.glyphUploads.length, 0); assert.strictEqual([...font.shapes.values()][0], shape);
  } finally { renderer.destroy(); }
  assert.equal(gl.buffers.size, 0); assert.equal(gl.textures.size, 0);
});

test('blend/page changes split batches and font data replacement invalidates cached geometry', async () => {
  const gl = mockGl(), renderer = new TextRenderer(gl), { graph, a, b, font } = fixture({ pageSize: 80, padding: 2 }), key = {};
  try {
    a.text = 'A'; b.text = 'B';
    await renderer.renderBatch([{ layout: a }, { layout: b }, { layout: a }], graph, 300, 100, key);
    assert.equal(gl.draws.length, 3, 'page A -> B -> A must retain draw order');
    font.atlas = { pageSize: 2048 };
    gl.reset(); await renderer.renderBatch([{ layout: a }, { layout: b, blend: 'alpha' }, { layout: a }], graph, 300, 100, key);
    assert.equal(gl.draws.length, 3, 'blend boundaries must retain draw order');
    assert.equal(renderer.fonts.size, 1, 'atlas settings do not recreate the HarfBuzz font');
    const old = renderer.runs.get(key).batches[0].parts[0].chunk;
    font.data = new Uint8Array(data);
    gl.reset(); await renderer.renderBatch([{ layout: a }], graph, 300, 100, key);
    assert.notStrictEqual(renderer.runs.get(key).batches[0].parts[0].chunk, old);
    assert.equal(gl.glyphUploads.length, 1);
  } finally { renderer.destroy(); }
});

test('clear/mesh/pass boundaries flush text; disabled cells produce no draws', async () => {
  const executor = Object.create(WebGLExecutor.prototype), events = [], { graph, a, b } = fixture();
  graph.resources.set('a', a); graph.resources.set('b', b);
  executor.gl = { clearColor() {}, clear() { events.push('clear'); } };
  executor.textRenderer = { async renderBatch(cells) { events.push(cells.map(c=>c.layout.id).join(',')); } };
  executor.executeMesh = () => events.push('mesh');
  const pass = { commands: [
    { type: 'text', layout: 'a' }, { type: 'text', layout: 'b', enabled: false },
    { type: 'clear', color: [0,0,0,0] }, { type: 'text', layout: 'b' },
    { type: 'mesh' }, { type: 'text', layout: 'a' }, { type: 'text', layout: 'b' }
  ] };
  await executor.executePass(pass, 300, 100, graph, 0);
  await executor.executePass({ commands: [{ type: 'text', layout: 'a' }] }, 300, 100, graph, 0);
  assert.deepEqual(events, ['a', 'clear', 'b', 'mesh', 'a,b', 'a']);
});

test('eviction releases dependent GPU buffers and evicted fonts can be rendered again', async () => {
  const gl = mockGl(), renderer = new TextRenderer(gl), { graph, a, font } = fixture();
  try {
    a.text = 'A';
    for (let i = 0; i < 10; i++) {
      font.data = new Uint8Array(data);
      await renderer.render(a, graph, 300, 100);
    }
    assert.equal(renderer.fonts.size, 8); assert.equal(renderer.atlases.length, 8);
    assert.equal(gl.textures.size, 8); assert.equal(gl.buffers.size, 3, 'only the latest single-cell run retains buffers');
    font.data = data;
    await renderer.render(a, graph, 300, 100);
    assert.equal(gl.textures.size, 8);
  } finally { renderer.destroy(); }
  assert.equal(gl.buffers.size, 0); assert.equal(gl.textures.size, 0);
  renderer.destroy();
  await assert.rejects(() => renderer.render(a, graph, 300, 100), /destroyed/);
});

test('a text run can use more atlases than the cache limit without sampling deleted textures', async () => {
  const gl = mockGl(), renderer = new TextRenderer(gl), { graph, a } = fixture(), key = {};
  try {
    const cells = [];
    for (let i = 0; i < 9; i++) {
      const id = `font${i}`;
      graph.resources.set(id, { id, kind: 'font', family: 'Noto', data, atlas: { pageSize: 80 + i * 4 } });
      cells.push({ layout: { ...a, text: 'A', font: id } });
    }
    await renderer.renderBatch(cells, graph, 300, 100, key);
    assert.equal(gl.draws.length, 9); assert.equal(renderer.atlases.length, 8);
    assert.equal(renderer.fonts.size, 1);
    assert.equal(gl.buffers.size, 1, 'batch referencing an evicted atlas is released after drawing');
    for (let i = 0; i < 130; i++) await renderer.renderBatch([cells[8]], graph, 300, 100, {});
    assert.equal(renderer.runs.size, 128);
    assert.equal(gl.buffers.size, 1 + 128 * 2);
  } finally { renderer.destroy(); }
  assert.equal(gl.buffers.size, 0); assert.equal(gl.textures.size, 0);
});

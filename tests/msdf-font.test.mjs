import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createServer } from 'vite';
import * as hb from 'harfbuzzjs';
import { createMsdfgen } from '@playcanvas/msdfgen-wasm';

const server = await createServer({ optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
const { fontWithGlyphIdCmap } = await server.ssrLoadModule('/src/core/render-graph/font-binary.ts');
await server.close();
const data = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC-Regular.otf', import.meta.url)));
const font = new hb.Font(new hb.Face(new hb.Blob(data)));
const mappedData = fontWithGlyphIdCmap(data);
const mapped = new hb.Font(new hb.Face(new hb.Blob(mappedData)));

function shape(text, features = []) {
  const buffer = new hb.Buffer(); buffer.addText(text); buffer.guessSegmentProperties();
  hb.shape(font, buffer, features);
  return { infos: buffer.getGlyphInfos(), positions: buffer.getGlyphPositions() };
}

test('private cmap preserves shaped Chinese and ligature glyph IDs and font checksum', () => {
  const shaped = shape('ffi中文');
  assert.ok(shaped.infos.length < 5, 'ffi should form a ligature');
  for (const info of shaped.infos) assert.equal(mapped.nominalGlyph(0xf0000 + info.codepoint), info.codepoint);
  assert.ok(font.nominalGlyph('中'.codePointAt(0)), 'original cmap remains intact');
  const view = new DataView(mappedData.buffer);
  let checksum = 0;
  for (let i = 0; i < mappedData.length; i += 4) checksum = (checksum + view.getUint32(i)) >>> 0;
  assert.equal(checksum, 0xb1b0afba);
});

test('HarfBuzz positions use font units and OpenType features control ligatures', () => {
  const advance = shape('A').positions[0].xAdvance * 32 / font.face.upem;
  assert.ok(advance > 10 && advance < 40, `32px A advance was ${advance}`);
  const noLigatures = shape('ffi', [hb.Feature.fromString('liga=0')]);
  assert.equal(noLigatures.infos.length, 3);
});

test('MSDF generator reads original outlines through glyph-ID cmap', async () => {
  const module = await createMsdfgen();
  const original = module.loadFont(data), remapped = module.loadFont(mappedData);
  try {
    const id = font.nominalGlyph(0x4e2d);
    const a = original.generateGlyph(0x4e2d, 64, 8);
    const b = remapped.generateGlyph(0xf0000 + id, 64, 8);
    assert.ok(a && b);
    assert.deepEqual(b.rgba, a.rgba);
    assert.equal(b.translateX, a.translateX);
    const ligature = shape('ffi').infos[0].codepoint;
    assert.ok(remapped.generateGlyph(0xf0000 + ligature, 64, 8));
  } finally { original?.delete(); remapped?.delete(); }
});

test('unsupported font containers fail explicitly', () => {
  assert.throws(() => fontWithGlyphIdCmap(new Uint8Array(12)), /TTF or OTF/);
});

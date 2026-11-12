import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
let decodeSvgFont, TextFont;
try {
    ({ decodeSvgFont } = await server.ssrLoadModule('/src/core/svg/font.ts'));
    ({ TextFont } = await server.ssrLoadModule('/src/core/render-graph/text-layout.ts'));
}
finally {
    await server.close();
}
const original = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansSC-Regular.otf', import.meta.url)));
function tables(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), result = [];
    for (let i = 0; i < v.getUint16(4); i++) {
        const p = 12 + i * 16, offset = v.getUint32(p + 8), length = v.getUint32(p + 12);
        result.push({ tag: v.getUint32(p), checksum: v.getUint32(p + 4), data: bytes.slice(offset, offset + length) });
    }
    return result;
}
function woff(bytes) {
    const records = tables(bytes).map(table => {
        const compressed = new Uint8Array(deflateSync(table.data));
        return { ...table, compressed: compressed.length < table.data.length ? compressed : table.data };
    });
    let size = 44 + records.length * 20, sfntSize = 12 + records.length * 16;
    for (const record of records) {
        record.offset = size;
        size += (record.compressed.length + 3) & ~3;
        sfntSize += (record.data.length + 3) & ~3;
    }
    const output = new Uint8Array(size), v = new DataView(output.buffer);
    v.setUint32(0, 0x774f4646);
    v.setUint32(4, new DataView(bytes.buffer).getUint32(0));
    v.setUint32(8, size);
    v.setUint16(12, records.length);
    v.setUint32(16, sfntSize);
    records.forEach((r, i) => {
        const p = 44 + i * 20;
        v.setUint32(p, r.tag);
        v.setUint32(p + 4, r.offset);
        v.setUint32(p + 8, r.compressed.length);
        v.setUint32(p + 12, r.data.length);
        v.setUint32(p + 16, r.checksum);
        output.set(r.compressed, r.offset);
    });
    return output;
}
test('WOFF1 reconstruction preserves every font table and SFNT checksum', async () => {
    const packed = woff(original), unpacked = await decodeSvgFont(packed);
    const actual = tables(unpacked), expected = tables(original);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < actual.length; i++) {
        assert.equal(actual[i].tag, expected[i].tag);
        if (actual[i].tag === 0x68656164) {
            actual[i].data.fill(0, 8, 12);
            expected[i].data.fill(0, 8, 12);
        }
        assert.deepEqual(actual[i].data, expected[i].data);
    }
    const v = new DataView(unpacked.buffer);
    let sum = 0;
    for (let i = 0; i < unpacked.length; i += 4)
        sum = (sum + v.getUint32(i)) >>> 0;
    assert.equal(sum, 0xb1b0afba);
    assert.strictEqual(await decodeSvgFont(original), original);
});
test('web font decoding rejects malformed containers and explicit WOFF2', async () => {
    await assert.rejects(() => decodeSvgFont(new Uint8Array(8)), /Truncated/);
    const bytes = new Uint8Array(44);
    new DataView(bytes.buffer).setUint32(0, 0x774f4632);
    await assert.rejects(() => decodeSvgFont(bytes), /WOFF2/);
    new DataView(bytes.buffer).setUint32(0, 0x774f4646);
    await assert.rejects(() => decodeSvgFont(bytes), /header/);
});
test('font variation instances share their immutable face and isolate layout caches', () => {
    const font = new TextFont(original), variant = font.withVariations({ wght: 700 });
    assert.notStrictEqual(font.font, variant.font);
    assert.strictEqual(font.font.face, variant.font.face);
    assert.strictEqual(font.data, variant.data);
    const style = { size: 24, color: [1, 1, 1, 1] };
    assert.notStrictEqual(font.layout('ffi中文', style), variant.layout('ffi中文', style));
    assert.throws(() => font.withVariations({ wght: NaN }), /finite/);
});

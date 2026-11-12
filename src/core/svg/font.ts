/** Decode WOFF1 without a font library. The caller supplies TTF/OTF directly,
 * or WOFF1 whose individual tables use the platform's Deflate decoder. */
export async function decodeSvgFont(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 12)
        throw new Error('Truncated SVG font');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength), signature = view.getUint32(0);
    if (signature === 0x00010000 || signature === 0x4f54544f)
        return data;
    if (signature === 0x774f4632)
        throw new Error('WOFF2 fonts require a TTF, OTF or WOFF1 source');
    if (signature !== 0x774f4646 || data.length < 44)
        throw new Error('SVG fonts must be TTF, OTF or WOFF1');
    const flavor = view.getUint32(4), count = view.getUint16(12), size = view.getUint32(16);
    if (![0x00010000, 0x4f54544f].includes(flavor) || !count || count > 4096 || 44 + count * 20 > data.length || size > 64 * 1024 * 1024 || size < 12 + count * 16 || view.getUint32(8) !== data.length)
        throw new Error('Invalid WOFF1 header');
    const output = new Uint8Array(size), sfnt = new DataView(output.buffer);
    sfnt.setUint32(0, flavor);
    sfnt.setUint16(4, count);
    const power = 2 ** Math.floor(Math.log2(count));
    sfnt.setUint16(6, power * 16);
    sfnt.setUint16(8, Math.log2(power));
    sfnt.setUint16(10, count * 16 - power * 16);
    let cursor = 12 + count * 16, head = -1;
    for (let i = 0; i < count; i++) {
        const record = 44 + i * 20, tag = view.getUint32(record), offset = view.getUint32(record + 4), compressed = view.getUint32(record + 8), original = view.getUint32(record + 12), checksum = view.getUint32(record + 16);
        if (compressed > original || offset + compressed > data.length || offset < 44 + count * 20 || cursor + original > output.length)
            throw new Error('Invalid WOFF1 table bounds');
        let table = data.subarray(offset, offset + compressed);
        if (compressed < original) {
            const reader = new Blob([new Uint8Array(table)]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(), chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    bytes += value.length;
                    if (bytes > original)
                        throw new Error('WOFF1 table expands beyond its declared size');
                    chunks.push(value);
                }
            }
            finally {
                await reader.cancel();
            }
            if (bytes !== original)
                throw new Error('WOFF1 table length mismatch');
            table = new Uint8Array(original);
            let at = 0;
            for (const chunk of chunks) {
                table.set(chunk, at);
                at += chunk.length;
            }
        }
        const target = 12 + i * 16;
        sfnt.setUint32(target, tag);
        sfnt.setUint32(target + 4, checksum);
        sfnt.setUint32(target + 8, cursor);
        sfnt.setUint32(target + 12, original);
        output.set(table, cursor);
        if (tag === 0x68656164) {
            head = cursor;
            if (original < 12)
                throw new Error('Invalid WOFF1 head table');
            sfnt.setUint32(head + 8, 0);
        }
        cursor = (cursor + original + 3) & ~3;
    }
    if (cursor !== size || head < 0)
        throw new Error('WOFF1 SFNT size/head mismatch');
    let checksum = 0;
    for (let i = 0; i < output.length; i += 4)
        checksum = (checksum + sfnt.getUint32(i)) >>> 0;
    sfnt.setUint32(head + 8, (0xb1b0afba - checksum) >>> 0);
    return output;
}

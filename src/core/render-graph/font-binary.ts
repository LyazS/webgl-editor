/** msdfgen's binding accepts Unicode only. Give its private font copy a synthetic
 * cmap so shaped glyph IDs (including ligatures) address the original outlines. */
export function fontWithGlyphIdCmap(data: Uint8Array): Uint8Array {
  const input = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 12 || ![0x00010000, 0x4f54544f].includes(input.getUint32(0))) {
    throw new Error("MSDF fonts must be standalone TTF or OTF files");
  }
  const count = input.getUint16(4);
  let cmapRecord = -1, glyphCount = 0, headOffset = 0;
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16, tag = input.getUint32(record);
    const offset = input.getUint32(record + 8);
    if (tag === 0x636d6170) cmapRecord = record;
    if (tag === 0x6d617870) glyphCount = input.getUint16(offset + 4);
    if (tag === 0x68656164) headOffset = offset;
  }
  if (cmapRecord < 0 || !glyphCount || !headOffset) throw new Error("Font is missing cmap, maxp or head");
  const offset = (data.length + 3) & ~3;
  const result = new Uint8Array(offset + 40);
  result.set(data);
  const view = new DataView(result.buffer);
  // Windows full-Unicode cmap, format 12, one sequential glyph range.
  view.setUint16(offset + 2, 1);
  view.setUint16(offset + 4, 3); view.setUint16(offset + 6, 10); view.setUint32(offset + 8, 12);
  view.setUint16(offset + 12, 12); view.setUint32(offset + 16, 28);
  view.setUint32(offset + 24, 1); view.setUint32(offset + 28, 0xf0000);
  view.setUint32(offset + 32, 0xf0000 + glyphCount - 1);
  view.setUint32(cmapRecord + 8, offset); view.setUint32(cmapRecord + 12, 40);
  let checksum = 0;
  for (let i = offset; i < result.length; i += 4) checksum = (checksum + view.getUint32(i)) >>> 0;
  view.setUint32(cmapRecord + 4, checksum);
  view.setUint32(headOffset + 8, 0);
  checksum = 0;
  for (let i = 0; i < result.length; i += 4) checksum = (checksum + view.getUint32(i)) >>> 0;
  view.setUint32(headOffset + 8, (0xb1b0afba - checksum) >>> 0);
  return result;
}

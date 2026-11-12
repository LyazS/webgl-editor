import * as hb from "harfbuzzjs";
import type { TextStyle } from "./types";

const CACHE_LIMIT = 256;
interface ShapedGlyph { id: number; cluster: number; advance: number; x: number; y: number; }
export interface TextLayoutData {
  size: number;
  glyphs: Array<{ id: number; x: number; y: number }>;
}

function cached<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) { cache.delete(key); cache.set(key, value); }
  return value;
}
function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

/** Shaping is in em units; layout is local to the cell, independent of paint and GPU atlases. */
export class TextFont {
  readonly font: hb.Font;
  private readonly shapes = new Map<string, ShapedGlyph[][]>();
  private readonly layouts = new Map<string, TextLayoutData>();

  constructor(readonly data: Uint8Array, face = new hb.Face(new hb.Blob(data))) {
    this.font = new hb.Font(face);
    this.font.setScale(face.upem, face.upem);
  }

  /** Independent shaping caches and axis state, sharing the immutable face. */
  withVariations(settings: Record<string, number>): TextFont {
    if (!Object.values(settings).every(Number.isFinite)) throw new Error("Font axes must be finite");
    const result = new TextFont(this.data, this.font.face);
    result.font.setVariations(Object.entries(settings).map(([tag, value]) => new hb.Variation(tag, value)));
    return result;
  }

  layout(text: string, style: TextStyle, features = ["kern", "liga"]): TextLayoutData {
    text = text.replace(/\r\n?/g, "\n");
    const size = style.size, spacing = style.letterSpacing ?? 0;
    const lineHeight = size * (style.lineHeight ?? 1.2);
    const align = style.align ?? "left", anchor = style.anchor ?? "top-left";
    const key = JSON.stringify([text, features, size, spacing, lineHeight, style.maxWidth, align, anchor]);
    const existing = cached(this.layouts, key);
    if (existing) return existing;
    const lines: Array<{ glyphs: Array<{ id: number; x: number; y: number }>; width: number }> = [];
    for (const paragraph of this.shape(text, features)) {
      let line: typeof lines[number] = { glyphs: [], width: 0 };
      lines.push(line);
      for (let i = 0; i < paragraph.length;) {
        let end = i + 1, advance = paragraph[i].advance * size;
        while (end < paragraph.length && paragraph[end].cluster === paragraph[i].cluster) advance += paragraph[end++].advance * size;
        if (style.maxWidth && line.glyphs.length && line.width + spacing + advance > style.maxWidth) {
          line = { glyphs: [], width: 0 }; lines.push(line);
        }
        if (line.glyphs.length) line.width += spacing;
        for (; i < end; i++) {
          const glyph = paragraph[i];
          line.glyphs.push({ id: glyph.id, x: line.width + glyph.x * size, y: glyph.y * size });
          line.width += glyph.advance * size;
        }
      }
    }
    const blockWidth = style.maxWidth ?? Math.max(...lines.map((line) => line.width));
    const extents = this.font.hExtents(), scale = size / this.font.face.upem;
    const blockHeight = (extents.ascender - extents.descender) * scale + (lines.length - 1) * lineHeight;
    const originX = anchor === "center" ? -blockWidth / 2 : 0;
    const baseline = (anchor === "baseline" ? 0 : extents.ascender * scale) - (anchor === "center" ? blockHeight / 2 : 0);
    const glyphs = lines.flatMap((line, row) => {
      const x = originX + (align === "center" ? (blockWidth - line.width) / 2 : align === "right" ? blockWidth - line.width : 0);
      return line.glyphs.map((glyph) => ({ id: glyph.id, x: x + glyph.x, y: baseline + row * lineHeight + glyph.y }));
    });
    return remember(this.layouts, key, { size, glyphs });
  }

  private shape(text: string, features: string[]): ShapedGlyph[][] {
    const key = JSON.stringify([text, features]);
    const existing = cached(this.shapes, key);
    if (existing) return existing;
    const parsed = features.map((value) => {
      const feature = hb.Feature.fromString(value);
      if (!feature) throw new Error(`Invalid font feature: ${value}`);
      return feature;
    });
    const em = this.font.face.upem;
    const paragraphs = text.split("\n").map((paragraph) => {
      const buffer = new hb.Buffer(); buffer.addText(paragraph); buffer.guessSegmentProperties();
      hb.shape(this.font, buffer, parsed);
      const positions = buffer.getGlyphPositions();
      return buffer.getGlyphInfos().map((info, index) => {
        const id = info.codepoint || this.font.nominalGlyph(0xfffd);
        if (!id) throw new Error(`Font has no glyph for text cluster ${info.cluster}`);
        const position = positions[index];
        return { id, cluster: info.cluster, advance: position.xAdvance / em, x: position.xOffset / em, y: -position.yOffset / em };
      });
    });
    return remember(this.shapes, key, paragraphs);
  }
}

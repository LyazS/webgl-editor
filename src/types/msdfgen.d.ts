declare module "@playcanvas/msdfgen-wasm" {
  interface GlyphBitmap {
    width: number;
    height: number;
    rgba: Uint8Array;
    advance: number;
    translateX: number;
    translateY: number;
    boundsL: number;
    boundsB: number;
    boundsR: number;
    boundsT: number;
    range: number;
  }

  interface LoadedFont {
    generateGlyph(codepoint: number, size: number, pxrange: number): GlyphBitmap | null;
    ok(): boolean;
    delete(): void;
  }

  interface Msdfgen {
    loadFont(bytes: Uint8Array | ArrayBuffer): LoadedFont | null;
  }

  export function createMsdfgen(options?: { moduleOverrides?: Record<string, unknown> }): Promise<Msdfgen>;
}

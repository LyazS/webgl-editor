declare module "@playcanvas/msdfgen-wasm" {
  export interface MsdfGlyph {
    width: number; height: number; rgba: Uint8Array;
    translateX: number; translateY: number; range: number;
    boundsL: number; boundsB: number; boundsR: number; boundsT: number;
  }
  export interface MsdfFont { generateGlyph(codepoint: number, size: number, range: number): MsdfGlyph | null; delete(): void; }
  export function createMsdfgen(options?: { moduleOverrides?: { locateFile: (path: string) => string } }): Promise<{ loadFont(data: Uint8Array): MsdfFont | null }>;
}

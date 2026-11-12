/** Serializable result returned by the browser Agent canvas capture API. */
export interface RenderedFrameCapture {
  frame: number;
  width: number;
  height: number;
  mimeType: "image/png";
  /** PNG encoded as a data URL so browser automation can consume it directly. */
  dataUrl: string;
  /** Optional top-to-bottom RGBA8 pixels for agents doing programmatic inspection. */
  pixels?: number[];
}

export interface RenderFrameOptions {
  includePixels?: boolean;
}

export interface RenderGraphAgentApi {
  /** Seek the deterministic timeline to a frame and capture the final screen. */
  captureFrame(frame: number, options?: RenderFrameOptions): Promise<RenderedFrameCapture>;
}

declare global {
  interface Window {
    renderGraphAgent?: RenderGraphAgentApi;
  }
}


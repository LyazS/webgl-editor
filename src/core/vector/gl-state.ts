/** Snapshot only state touched by the vector backend, allowing mesh/text/vector
 * commands to interleave in one framebuffer without leaking renderer state. */
export class VectorGLState {
    private readonly parameters = new Map<number, unknown>();
    private readonly enabled = new Map<number, boolean>();
    private readonly textures: Array<WebGLTexture | null> = [];
    constructor(private readonly gl: WebGL2RenderingContext) {
        for (const name of [gl.DRAW_FRAMEBUFFER_BINDING, gl.READ_FRAMEBUFFER_BINDING, gl.VIEWPORT, gl.CURRENT_PROGRAM, gl.VERTEX_ARRAY_BINDING, gl.ARRAY_BUFFER_BINDING, gl.RENDERBUFFER_BINDING, gl.ACTIVE_TEXTURE, gl.DEPTH_WRITEMASK, gl.COLOR_WRITEMASK, gl.COLOR_CLEAR_VALUE, gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA, gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA])
            this.parameters.set(name, gl.getParameter(name));
        for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE])
            this.enabled.set(cap, gl.isEnabled(cap));
        for (let unit = 0; unit < 3; unit++) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            this.textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
        }
        gl.activeTexture(this.parameters.get(gl.ACTIVE_TEXTURE) as number);
    }
    restore(): void {
        const gl = this.gl, p = <T>(name: number) => this.parameters.get(name) as T;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, p(gl.DRAW_FRAMEBUFFER_BINDING));
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, p(gl.READ_FRAMEBUFFER_BINDING));
        const v = p<Int32Array>(gl.VIEWPORT);
        gl.viewport(v[0], v[1], v[2], v[3]);
        gl.useProgram(p(gl.CURRENT_PROGRAM));
        gl.bindVertexArray(p(gl.VERTEX_ARRAY_BINDING));
        gl.bindBuffer(gl.ARRAY_BUFFER, p(gl.ARRAY_BUFFER_BINDING));
        gl.bindRenderbuffer(gl.RENDERBUFFER, p(gl.RENDERBUFFER_BINDING));
        gl.depthMask(p(gl.DEPTH_WRITEMASK));
        const mask = p<boolean[]>(gl.COLOR_WRITEMASK);
        gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
        const clear = p<Float32Array>(gl.COLOR_CLEAR_VALUE);
        gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
        gl.blendFuncSeparate(p(gl.BLEND_SRC_RGB), p(gl.BLEND_DST_RGB), p(gl.BLEND_SRC_ALPHA), p(gl.BLEND_DST_ALPHA));
        gl.blendEquationSeparate(p(gl.BLEND_EQUATION_RGB), p(gl.BLEND_EQUATION_ALPHA));
        for (const [cap, enabled] of this.enabled)
            enabled ? gl.enable(cap) : gl.disable(cap);
        this.textures.forEach((texture, unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        });
        gl.activeTexture(p(gl.ACTIVE_TEXTURE));
    }
}

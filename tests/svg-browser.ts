import { SvgDocument } from '../src/core/svg/document';
import { VectorRenderer } from '../src/core/vector/renderer';
import { LuaRenderRuntime } from '../src/core/runtime/lua-runtime';
import { identity, multiply } from '../src/core/vector/math';
import { WebGLExecutor } from '../src/core/render-graph/webgl-executor';
const cases: Record<string, string> = {
    'shapes and arcs': '<rect x="10" y="10" width="50" height="35" rx="8" fill="tomato"/><ellipse cx="110" cy="35" rx="30" ry="20" fill="#46a"/><path d="M10 100a30 30 0 0130-30l30 30Z" fill="gold"/>',
    'holes and self intersection': '<path d="M10 10h60v90h-60z M25 25h30v60h-30z" fill="red" fill-rule="evenodd"/><path d="M90 10L150 100L90 100L150 10Z" fill="#09f"/>',
    'styles and transforms': '<style>.shape{fill:gold}g > .shape{stroke:#29f;stroke-width:4}#special{fill:red!important}</style><g transform="translate(10 10) rotate(10 50 50)"><rect class="shape" width="60" height="30"/><circle class="shape" id="special" cx="90" cy="65" r="20"/></g>',
    'CSS variables and geometry': '<style>svg{--Accent:#09f}rect{fill:var(--Accent);x:10px;y:20px;width:calc(50% - 20px);height:60px}path{d:path("M90 20H145V80H90Z");fill:var(--Missing,red)}</style><rect/><path/>',
    'CSS transform units and origin': '<style>rect{transform:translate(10px,5px) rotate(15deg);transform-origin:50% 50%;transform-box:fill-box}</style><rect x="25" y="20" width="90" height="70" fill="blue"/>',
    'marker context paint': '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" x2="130"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><marker id="m" viewBox="0 0 10 10" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0 0L10 5L0 10Z" fill="context-stroke"/></marker></defs><path d="M20 60H130" fill="none" stroke="url(#g)" stroke-width="4" marker-end="url(#m)"/>',
    'paint order': '<path d="M30 25H130V95H30Z" fill="red" stroke="blue" stroke-width="20" paint-order="stroke fill"/>',
    'editor metadata': '<metadata xmlns:rdf="urn:rdf"><rdf:RDF><rdf:Description>Editor metadata</rdf:Description></rdf:RDF></metadata><a href="https://example.invalid"><rect x="20" y="20" width="120" height="80" fill="blue"/></a>',
    'group opacity': '<g opacity=".5"><rect x="10" y="10" width="80" height="80" fill="red"/><rect x="50" y="35" width="80" height="70" fill="blue"/></g>',
    'stroke joins and dashes': '<path d="M10 30L50 10L80 40L110 10L150 30" fill="none" stroke="#38d" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"/><path d="M10 80H150" stroke="red" stroke-width="12" stroke-linecap="square" stroke-dasharray="12 8" stroke-dashoffset="3"/>',
    'gradient inheritance': '<defs><linearGradient id="a"><stop stop-color="red"/><stop offset=".5" stop-color="yellow"/><stop offset="1" stop-color="blue" stop-opacity=".4"/></linearGradient><linearGradient id="b" href="#a" x1="0" y1="0" x2="0" y2="1"/></defs><rect x="10" y="10" width="60" height="90" fill="url(#a)"/><rect x="90" y="10" width="60" height="90" fill="url(#b)"/>',
    'radial gradient': '<defs><radialGradient id="g" cx=".5" cy=".5" r=".5" fx=".3" fy=".4"><stop stop-color="white"/><stop offset="1" stop-color="blue"/></radialGradient></defs><ellipse cx="80" cy="60" rx="65" ry="45" fill="url(#g)"/>',
    'clipping': '<defs><clipPath id="c"><circle cx="80" cy="60" r="40"/></clipPath></defs><g clip-path="url(#c)"><rect width="160" height="120" fill="orange"/><rect x="70" width="90" height="120" fill="blue"/></g>',
    'clip fill and winding': '<defs><clipPath id="c" clip-rule="evenodd"><path d="M10 10h130v90h-130z M40 30h70v50h-70z" fill="none"/></clipPath></defs><rect width="160" height="120" fill="red" clip-path="url(#c)"/>',
    'bevel and circle strokes': '<path d="M15 45V15H65V45" fill="none" stroke="blue" stroke-width="10" stroke-linejoin="bevel"/><circle cx="115" cy="60" r="30" fill="none" stroke="red" stroke-width="12"/>',
    'blend isolation': '<rect width="160" height="120" fill="orange"/><g style="isolation:isolate"><rect x="20" y="20" width="100" height="80" fill="blue" style="mix-blend-mode:multiply"/></g>',
    'bounding box clip': '<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath></defs><rect x="10" y="10" width="130" height="90" fill="red" clip-path="url(#c)"/>',
    'luminance mask': '<defs><mask id="m"><rect x="10" y="10" width="100" height="90" fill="white"/><circle cx="60" cy="55" r="25" fill="black"/></mask></defs><rect x="10" y="10" width="130" height="90" fill="blue" mask="url(#m)"/>',
    'pattern': '<defs><pattern id="p" patternUnits="userSpaceOnUse" width="20" height="20"><rect width="10" height="10" fill="red"/><rect x="10" y="10" width="10" height="10" fill="blue"/></pattern></defs><rect x="10" y="10" width="140" height="100" fill="url(#p)"/>',
    'symbol and use': '<defs><symbol id="s" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></symbol></defs><use href="#s" x="10" y="10" width="60" height="80" fill="red"/><use href="#s" x="90" y="30" width="50" height="50" fill="blue"/>',
    'blur': '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs><rect x="30" y="30" width="70" height="50" fill="red" filter="url(#f)"/>',
    'filter graph': '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b"/><feOffset in="b" dx="8" dy="8" result="s"/><feFlood flood-color="blue" flood-opacity=".5" result="c"/><feComposite in="c" in2="s" operator="in" result="shadow"/><feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="30" y="20" width="70" height="60" fill="red" filter="url(#f)"/>',
    'markers': '<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="red"/></marker></defs><path d="M25 30L80 80L130 30" fill="none" stroke="blue" stroke-width="4" marker-start="url(#arrow)" marker-mid="url(#arrow)" marker-end="url(#arrow)"/>',
    'component transfer': '<defs><filter id="f" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="table" tableValues="0 .3 1"/><feFuncG type="discrete" tableValues=".2 .8"/><feFuncA type="linear" slope=".7"/></feComponentTransfer></filter></defs><rect x="20" y="20" width="100" height="80" fill="#a89" filter="url(#f)"/>',
    'color matrix': '<defs><filter id="f"><feColorMatrix type="saturate" values=".2"/></filter></defs><rect x="20" y="20" width="100" height="80" fill="orange" filter="url(#f)"/>',
    'drop shadow': '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="8" dy="6" stdDeviation="3" flood-color="blue" flood-opacity=".7"/></filter></defs><rect x="30" y="20" width="80" height="60" fill="red" filter="url(#f)"/>',
    'nested viewports': '<svg x="20" y="15" width="110" height="80" viewBox="0 0 100 50" preserveAspectRatio="xMidYMid slice"><rect x="-20" y="-20" width="140" height="90" fill="blue"/><circle cx="50" cy="25" r="20" fill="red"/></svg>',
    'non scaling stroke': '<path d="M15 15L55 40L15 40" transform="scale(2 1.5)" fill="none" stroke="red" stroke-width="5" vector-effect="non-scaling-stroke"/>',
    'convolution': '<defs><filter id="f" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true"/></filter></defs><circle cx="80" cy="60" r="35" fill="#a95" filter="url(#f)"/>',
    'displacement map': '<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="160" height="120" color-interpolation-filters="sRGB"><feFlood flood-color="red" result="map"/><feDisplacementMap in="SourceGraphic" in2="map" scale="10" xChannelSelector="R" yChannelSelector="G"/></filter></defs><rect x="30" y="25" width="90" height="70" fill="blue" filter="url(#f)"/>',
    'filter tile and subregions': '<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="160" height="120"><feFlood x="10" y="10" width="20" height="20" flood-color="blue"/><feTile/></filter></defs><rect width="160" height="120" filter="url(#f)"/>',
    'filter vector image': '<defs><g id="icon"><rect width="100" height="50" fill="blue"/><circle cx="50" cy="25" r="15" fill="red"/></g><filter id="f" filterUnits="userSpaceOnUse" x="20" y="20" width="120" height="80"><feImage href="#icon"/></filter></defs><rect width="160" height="120" filter="url(#f)"/>',
    'filter default subregion union': '<defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="160" height="120"><feFlood x="30" y="30" width="50" height="40" flood-color="red" result="small"/><feComposite in="small" in2="small" operator="arithmetic" k4=".5"/></filter></defs><rect width="160" height="120" filter="url(#f)"/>',
    'filter paint input': '<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><filter id="f"><feComposite in="FillPaint" in2="SourceAlpha" operator="in"/></filter></defs><rect x="20" y="20" width="120" height="80" fill="url(#g)" filter="url(#f)"/>',
    'fractal turbulence': '<defs><filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence baseFrequency=".05" numOctaves="2" seed="3" type="fractalNoise"/></filter></defs><rect width="160" height="120" filter="url(#f)"/>',
    'diffuse lighting': '<defs><filter id="f"><feDiffuseLighting surfaceScale="2" diffuseConstant=".8" lighting-color="#ffc"><feDistantLight azimuth="45" elevation="60"/></feDiffuseLighting></filter></defs><rect x="30" y="25" width="90" height="70" fill="white" filter="url(#f)"/>',
    'specular lighting': '<defs><filter id="f"><feSpecularLighting surfaceScale="2" specularExponent="8" specularConstant=".8" lighting-color="#cff"><feDistantLight azimuth="45" elevation="60"/></feSpecularLighting></filter></defs><rect x="30" y="25" width="90" height="70" fill="white" filter="url(#f)"/>',
    'blend': '<rect x="10" y="10" width="90" height="90" fill="red"/><rect x="50" y="30" width="90" height="80" fill="blue" style="mix-blend-mode:multiply"/>',
};
const results: Array<Record<string, unknown>> = [];
function assertThrows(action: () => unknown) {
    let threw = false;
    try {
        action();
    }
    catch {
        threw = true;
    }
    assert(threw, 'Expected diagnostic error');
}
function assert(value: unknown, message: string) {
    if (!value)
        throw new Error(message);
}
async function oracle(svg: string, w: number, h: number): Promise<Uint8ClampedArray> {
    const blob = new Blob([svg], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] *= data[i + 3] / 255;
            data[i + 1] *= data[i + 3] / 255;
            data[i + 2] *= data[i + 3] / 255;
        }
        return data;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
async function run() {
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = 40;
    imageCanvas.height = 20;
    const imageContext = imageCanvas.getContext('2d')!;
    imageContext.fillStyle = 'red';
    imageContext.fillRect(0, 0, 20, 20);
    imageContext.fillStyle = 'blue';
    imageContext.fillRect(20, 0, 20, 20);
    cases['filter image'] = `<defs><filter id="f" filterUnits="userSpaceOnUse" x="20" y="20" width="120" height="80"><feImage href="${imageCanvas.toDataURL()}"/></filter></defs><rect width="160" height="120" filter="url(#f)"/>`;
    cases['raster image aspect ratio'] = `<image href="${imageCanvas.toDataURL()}" x="20" y="20" width="120" height="80"/>`;
    const w = 160, h = 120, canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    document.body.append(canvas);
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
    assert(gl, 'WebGL2 unavailable');
    const tracked = new Map<string, Set<unknown>>();
    let uploads = 0;
    for (const type of ['Texture', 'Buffer', 'Program', 'Shader', 'VertexArray', 'Framebuffer', 'Renderbuffer']) {
        const live = new Set<unknown>();
        tracked.set(type, live);
        const object = gl as unknown as Record<string, (...args: unknown[]) => unknown>, create = object[`create${type}`].bind(gl), destroy = object[`delete${type}`].bind(gl);
        object[`create${type}`] = (...args) => {
            const value = create(...args);
            if (value)
                live.add(value);
            return value;
        };
        object[`delete${type}`] = (value) => {
            live.delete(value);
            return destroy(value);
        };
    }
    const originalUpload = gl.bufferData.bind(gl);
    gl.bufferData = ((...args: Parameters<typeof gl.bufferData>) => {
        uploads++;
        return originalUpload(...args);
    }) as typeof gl.bufferData;
    const renderer = new VectorRenderer(gl);
    try {
        for (const [name, body] of Object.entries(cases)) {
            const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
            try {
                const doc = new SvgDocument(source);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, w, h);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                await renderer.render(doc.scene(w, h), w, h);
                const pixels = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                assert(gl.getError() === gl.NO_ERROR, 'WebGL error');
                const expected = await oracle(source, w, h);
                let sum = 0, bad = 0;
                for (let y = 0; y < h; y++)
                    for (let x = 0; x < w; x++) {
                        let max = 0;
                        for (let c = 0; c < 4; c++) {
                            const delta = Math.abs(pixels[((h - y - 1) * w + x) * 4 + c] - expected[(y * w + x) * 4 + c]);
                            sum += delta;
                            max = Math.max(max, delta);
                        }
                        if (max > 40)
                            bad++;
                    }
                const energy = expected.reduce((n, v, i) => i % 4 === 3 ? n + v : n, 0);
                assert(energy > 1000, 'Oracle is unexpectedly blank');
                const mean = sum / (w * h * 4), badFraction = bad / (w * h);
                results.push({
                    name, mean, badFraction, ...(mean >= 4 ? { samples: [20, 25, 30, 35, 40, 110, 115, 120].map(x => ({ x, actual: Array.from(pixels.slice(((h - 60 - 1) * w + x) * 4, ((h - 60 - 1) * w + x) * 4 + 4)), expected: Array.from(expected.slice((60 * w + x) * 4, (60 * w + x) * 4 + 4)) })) } : {}), pass: mean < 4 && badFraction < .04
                });
            }
            catch (error) {
                results.push({ name, pass: false, error: String(error) });
            }
        }
        try {
            canvas.width = w * 2;
            canvas.height = h * 2;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, w * 2, h * 2);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const source = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><defs><pattern id="p" patternUnits="userSpaceOnUse" width="10" height="10"><circle cx="5" cy="5" r="2" fill="blue"/></pattern><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter></defs><g transform="scale(3)"><rect width="50" height="20" fill="url(#p)"/></g><rect x="30" y="75" width="90" height="20" fill="red" filter="url(#b)"/></svg>`;
            const doc = new SvgDocument(source);
            await renderer.render(doc.scene(w, h), w, h);
            const pixels = new Uint8Array(w * h * 16);
            gl.readPixels(0, 0, w * 2, h * 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            const expected = await oracle(source, w * 2, h * 2);
            let error = 0;
            for (let y = 0; y < h * 2; y++)
                for (let x = 0; x < w * 2; x++)
                    for (let channel = 0; channel < 4; channel++)
                        error += Math.abs(pixels[((h * 2 - y - 1) * w * 2 + x) * 4 + channel] - expected[(y * w * 2 + x) * 4 + channel]);
            const mean = error / pixels.length;
            assert(mean < 4, `DPR/scale rendering differs: ${mean}`);
            results.push({ name: 'DPR 2 filter and scaled vector pattern', mean, pass: true });
        }
        catch (error) {
            results.push({ name: 'DPR 2 filter and scaled vector pattern', pass: false, error: String(error) });
        }
        finally {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        try {
            const fontBytes = new Uint8Array(await (await fetch('/fonts/NotoSansSC-Regular.otf')).arrayBuffer());
            const face = await new FontFace('VectorOracle', fontBytes).load();
            document.fonts.add(face);
            const TW = 320, TH = 120;
            canvas.width = TW;
            canvas.height = TH;
            gl.viewport(0, 0, TW, TH);
            const compare = async (name: string, body: string, draw: (context: CanvasRenderingContext2D) => void) => {
                const doc = new SvgDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TW} ${TH}">${body}</svg>`);
                doc.setFont(fontBytes);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                await renderer.render(doc.scene(TW, TH), TW, TH);
                const actual = new Uint8Array(TW * TH * 4);
                gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, actual);
                const reference = document.createElement('canvas');
                reference.width = TW;
                reference.height = TH;
                const ctx = reference.getContext('2d')!;
                ctx.font = '42px VectorOracle';
                ctx.fontKerning = 'normal';
                draw(ctx);
                const expected = ctx.getImageData(0, 0, TW, TH).data;
                let error = 0;
                for (let y = 0; y < TH; y++)
                    for (let x = 0; x < TW; x++)
                        for (let c = 0; c < 4; c++) {
                            const i = (y * TW + x) * 4 + c;
                            error += Math.abs(actual[((TH - y - 1) * TW + x) * 4 + c] - (c < 3 ? expected[i] * expected[(y * TW + x) * 4 + 3] / 255 : expected[i]));
                        }
                const mean = error / actual.length;
                assert(mean < 4, `${name} differs from native font drawing: ${mean}`);
                results.push({ name, mean, pass: true });
            };
            await compare('Shaped vector text and continuous gradient', '<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><text x="15" y="75" font-size="42" fill="url(#g)">ffi 中文</text>', ctx => {
                const m = ctx.measureText('ffi 中文'), g = ctx.createLinearGradient(15 - m.actualBoundingBoxLeft, 0, 15 + m.actualBoundingBoxRight, 0);
                g.addColorStop(0, 'red');
                g.addColorStop(1, 'blue');
                ctx.fillStyle = g;
                ctx.fillText('ffi 中文', 15, 75);
            });
            await compare('SVG character positioning and rotations', '<text x="30 110 190" y="75" rotate="0 15 -15" font-size="42" fill="blue">ABC</text>', ctx => {
                for (let i = 0; i < 3; i++) {
                    ctx.save();
                    ctx.translate([30, 110, 190][i], 75);
                    ctx.rotate([0, 15, -15][i] * Math.PI / 180);
                    ctx.fillStyle = 'blue';
                    ctx.fillText('ABC'[i], 0, 0);
                    ctx.restore();
                }
            });
            await compare('Synthetic bold and italic text', '<text x="15" y="75" font-size="42" fill="blue" font-weight="700" font-style="italic">ABC</text>', ctx => {
                ctx.font = 'italic 700 42px VectorOracle';
                ctx.fillStyle = 'blue';
                ctx.fillText('ABC', 15, 75);
            });
            await compare('SVG whitespace across spans', '<text x="15" y="75" font-size="42" fill="blue">  A <tspan> B </tspan> </text>', ctx => {
                ctx.fillStyle = 'blue';
                ctx.fillText('A B', 15, 75);
            });
            await compare('SVG textLength scaling', '<text x="15" y="75" font-size="42" fill="blue" textLength="220" lengthAdjust="spacingAndGlyphs">ABC</text>', ctx => {
                ctx.save();
                ctx.translate(15, 75);
                ctx.scale(220 / ctx.measureText('ABC').width, 1);
                ctx.fillStyle = 'blue';
                ctx.fillText('ABC', 0, 0);
                ctx.restore();
            });
            await compare('SVG span clipping', '<defs><clipPath id="c"><rect x="15" y="20" width="50" height="90"/></clipPath></defs><text x="15" y="75" font-size="42" fill="blue"><tspan clip-path="url(#c)">ABC</tspan></text>', ctx => {
                ctx.save();
                ctx.beginPath();
                ctx.rect(15, 20, 50, 90);
                ctx.clip();
                ctx.fillStyle = 'blue';
                ctx.fillText('ABC', 15, 75);
                ctx.restore();
            });
            await compare('RTL text anchoring', '<text x="300" y="75" font-size="42" fill="blue" direction="rtl">ABC</text>', ctx => {
                ctx.direction = 'rtl';
                ctx.fillStyle = 'blue';
                ctx.fillText('ABC', 300, 75);
            });
            await compare('Text anchor across spans', '<text x="160" y="75" text-anchor="middle" font-size="42" fill="blue">ffi<tspan>中文</tspan></text>', ctx => {
                ctx.textAlign = 'center';
                ctx.fillStyle = 'blue';
                ctx.fillText('ffi中文', 160, 75);
            });
            const source = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><defs><path id="curve" d="M10 85Q160 -40 310 85"/></defs><text id="onpath" font-family="VectorOracle" font-size="32"><textPath href="#curve" startOffset="10%">ABC</textPath></text><text id="vertical" x="100" y="15" font-family="VectorOracle" font-size="32" writing-mode="vertical-rl">中文</text></svg>';
            const native = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
            native.setAttribute('style', 'position:absolute;left:-10000px');
            document.body.append(native);
            await document.fonts.ready;
            const doc = new SvgDocument(source);
            doc.setFont(fontBytes);
            const scene = doc.scene(TW, TH);
            const found: Array<{
                id: string;
                matrix: number[];
            }>[] = [], visit = (nodes: typeof scene, m = identity()) => {
                for (const n of nodes) {
                    const world = multiply(m, n.matrix);
                    if (n.path?.length)
                        found.push({ id: n.id, matrix: world });
                    visit(n.children, world);
                }
            };
            visit(scene);
            const onpath = native.querySelector('#onpath') as unknown as SVGTextElement, actual = found.filter(n => !n.id || n.id === 'onpath'), expected = onpath.getStartPositionOfChar(0);
            assert(Math.hypot(actual[0].matrix[4] - expected.x, actual[0].matrix[5] - expected.y) < 1, 'textPath origin differs from native SVG');
            const vertical = native.querySelector('#vertical') as unknown as SVGTextElement, v = found.filter(n => n.id === 'vertical'), a = vertical.getStartPositionOfChar(0), b = vertical.getStartPositionOfChar(1);
            assert(Math.abs((v[1].matrix[5] - v[0].matrix[5]) - (b.y - a.y)) < 1, 'Vertical glyph advance differs from native SVG');
            native.remove();
            results.push({ name: 'Native SVG textPath and vertical advances', pass: true });
        }
        catch (error) {
            results.push({ name: 'Vector text layout verification', pass: false, error: String(error) });
        }
        finally {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        try {
            const doc = new SvgDocument('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><g opacity=".5"><rect id="r" x="20" y="20" width="80" height="80" fill="red"/></g></svg>'), nodes = doc.scene(w, h);
            await renderer.render(nodes, w, h);
            const before = uploads;
            const external = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0 + 7);
            gl.bindTexture(gl.TEXTURE_2D, external);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            for (let i = 0; i < 12; i++)
                await renderer.render(nodes, w, h);
            await Promise.all([renderer.render(nodes, w, h), renderer.render(nodes, w, h)]);
            assert(uploads === before, 'Unchanged frames reuploaded geometry');
            assert(gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE0 + 7 && gl.getParameter(gl.TEXTURE_BINDING_2D) === external, 'External texture unit state was changed');
            gl.deleteTexture(external);
            assert(gl.isEnabled(gl.DEPTH_TEST) && gl.getParameter(gl.DEPTH_WRITEMASK), 'Depth state was not restored');
            doc.setAttribute('r', 'fill', 'blue');
            await renderer.render(doc.scene(w, h), w, h);
            assert(uploads === before, 'Paint change regenerated geometry');
            results.push({ name: 'GPU caching and state restoration', pass: true });
        }
        catch (error) {
            results.push({ name: 'GPU caching and state restoration', pass: false, error: String(error) });
        }
        try {
            const doc = new SvgDocument('<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" width="20" height="20"><animate attributeName="x" from="0" to="100" dur="2s" fill="freeze"/></rect></svg>');
            const before = JSON.stringify(doc.scene(w, h, .5)), after = JSON.stringify(doc.scene(w, h, 1.5));
            assert(before !== after, 'Animation did not advance');
            assert(doc.elements.get('r')!.getAttribute('x') === null, 'Animation mutated source attributes');
            assert(JSON.stringify(doc.scene(w, h, .5)) === before, 'Animation seek is not deterministic');
            assert(doc.hitTest(10, 10, w, h)[0] === 'r', 'Hit testing failed');
            assert(!doc.hitTest(100, 100, w, h).length, 'Hit testing included empty pixels');
            new SvgDocument('<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"><svg xmlns=\"http://www.w3.org/2000/svg\"/>');
            assertThrows(() => new SvgDocument('<svg><script/></svg>'));
            assertThrows(() => new SvgDocument('<svg><rect id="r"/><circle id="r"/></svg>'));
            assertThrows(() => new SvgDocument('<svg><use id="a" href="#a"/></svg>').scene(w, h));
            results.push({ name: 'Animation seek, hit tests and diagnostics', pass: true });
        }
        catch (error) {
            results.push({ name: 'Animation seek, hit tests and diagnostics', pass: false, error: String(error) });
        }
    }
    finally {
        renderer.destroy();
    }
    const leaked = Object.fromEntries([...tracked].filter(([, set]) => set.size).map(([key, set]) => [key, set.size]));
    results.push({ name: 'GPU resources released', pass: !Object.keys(leaked).length, leaked });
    try {
        const runtime = new LuaRenderRuntime(), c = document.createElement('canvas');
        document.body.append(c);
        const executor = new WebGLExecutor(c);
        try {
            await runtime.compile(`local rg=require("render_graph")
local svg=rg.svg("art",{data=[[<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>@font-face{font-family:SvgFace;src:url(/fonts/NotoSansSC-Regular.otf)}text{font-family:SvgFace}</style><rect id="box" width="80" height="80" fill="red"/><text id="label" x="10" y="40" font-size="20">中文 ffi</text></svg>]]})
local screen=rg.renderTarget("screen")
screen:clear({0,0,0,0})
local cell=screen:addVectorCell("art",{svg=svg,width=100,height=100})
function setup() return {} end
function render(ctx,state) if ctx.frame == 10 then svg:setAttribute("box","fill","blue") end; cell:setTransform({1,0,0,1,10,10}); end`, {});
            const initial = await runtime.buildGraph(0, 160, 120, 240), saved = runtime.snapshotState();
            const edited = await runtime.buildGraph(10, 160, 120, 240), document = (edited.resources.get('art') as import('../src/core/render-graph/types').VectorResource).document;
            assert(document.elements.get('box')!.getAttribute('fill') === 'blue', 'SVG mutation was not applied');
            const changed = runtime.snapshotState();
            await runtime.recompile();
            runtime.restoreState(changed);
            runtime.restoreState(saved);
            const restored = await runtime.buildGraph(1, 160, 120, 240), restoredDocument = (restored.resources.get('art') as import('../src/core/render-graph/types').VectorResource).document;
            assert(restoredDocument.elements.get('box')!.getAttribute('fill') === 'red', 'SVG checkpoint did not restore attributes across recompilation');
            await executor.execute(restored, 160, 120);
            results.push({ name: 'Lua + SVG text + checkpoint + WebGLExecutor', pass: true });
        }
        finally {
            await runtime.close();
            executor.destroy();
        }
    }
    catch (error) {
        results.push({ name: 'Lua + SVG text + WebGLExecutor', pass: false, error: String(error) });
    }
    (window as unknown as {
        svgTestResults: unknown;
    }).svgTestResults = results;
    document.body.append(Object.assign(document.createElement('pre'), { textContent: JSON.stringify(results, null, 2) }));
}
run().catch(error => {
    (window as unknown as {
        svgTestResults: unknown;
    }).svgTestResults = [{ pass: false, error: String(error) }];
});

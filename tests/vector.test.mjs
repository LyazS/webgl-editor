import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
let path, geometry, math, scene, animation, css, noise, VectorCompiler;
try {
    path = await server.ssrLoadModule('/src/core/vector/path.ts');
    geometry = await server.ssrLoadModule('/src/core/vector/geometry.ts');
    math = await server.ssrLoadModule('/src/core/vector/math.ts');
    scene = await server.ssrLoadModule('/src/core/vector/scene.ts');
    animation = await server.ssrLoadModule('/src/core/svg/animation.ts');
    css = await server.ssrLoadModule('/src/core/svg/style.ts');
    noise = await server.ssrLoadModule('/src/core/vector/noise.ts');
    ({ VectorCompiler } = await server.ssrLoadModule('/src/core/vector/compiler.ts'));
}
finally {
    await server.close();
}
const contours = d => path.flatten(path.parsePath(d));
function area(vertices) {
    let a = 0;
    for (let i = 0; i < vertices.length; i += 6) {
        const [x, y, u, v, p, q] = vertices.slice(i, i + 6);
        a += Math.abs((u - x) * (q - y) - (v - y) * (p - x)) / 2;
    }
    return a;
}
const approx = (a, b, t = .001) => assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
test('path scanner supports relative/implicit commands, smooth controls and compact arc flags', () => {
    const segments = path.parsePath('m10 20 30 0h20v10q5 10 10 0t10 0c1 2 3 4 5 6s7 8 9 10a10 20 30 0110 20z');
    assert.deepEqual(segments[1], { op: 'L', p: [40, 20] });
    assert.equal(segments.at(-1).op, 'Z');
    assert.ok(segments.filter(s => s.op === 'C').length >= 3);
    for (const bad of ['L0 0', 'M0', 'M0 0A1 1 0 2 0 3 3', 'M0 0 X1 2', 'M1e999 0'])
        assert.throws(() => path.parsePath(bad));
});
test('fill scan conversion preserves winding, holes, duplicate edges and self intersections', () => {
    const hole = contours('M0 0h100v100h-100z M25 25h50v50h-50z');
    approx(area(geometry.tessellate(hole, 'evenodd')), 7500);
    approx(area(geometry.tessellate(hole, 'nonzero')), 10000);
    approx(area(geometry.tessellate(contours('M0 0L100 100L0 100L100 0Z'), 'evenodd')), 5000);
    const reverse = contours('M0 0h100v100h-100z M25 25v50h50v-50z');
    approx(area(geometry.tessellate(reverse)), 7500);
    approx(area(geometry.tessellate(contours('M0 0h100v100h-100z M0 0h100v100h-100z'), 'evenodd')), 0);
    assert.equal(geometry.contains(reverse, [50, 50]), false);
    assert.equal(geometry.contains(reverse, [10, 10]), true);
});
test('adaptive subdivision follows transform scale and preserves closed/open subpaths', () => {
    const segments = path.parsePath('M0 0C0 100 100 100 100 0 M100 0q50 100 100 0Z');
    const small = path.flatten(segments), large = path.flatten(segments, [100, 0, 0, 100, 0, 0]);
    assert.ok(large[0].points.length > small[0].points.length);
    assert.equal(small[0].closed, false);
    assert.equal(small[1].closed, true);
    const loop = path.flatten(path.parsePath('M0 0C100 0 -100 0 0 0'));
    assert.ok(loop[0].points.length > 2, 'collinear reversals must not disappear');
});
test('stroke union avoids double coverage and honors caps, joins and dash offset', () => {
    const line = contours('M0 0H100'), style = scene.defaultStroke();
    style.width = 10;
    approx(area(geometry.tessellate(geometry.strokeContours(line, style))), 1000);
    style.cap = 'square';
    approx(area(geometry.tessellate(geometry.strokeContours(line, style))), 1100);
    style.cap = 'round';
    approx(area(geometry.tessellate(geometry.strokeContours(line, style, .01))), 1000 + Math.PI * 25, 1);
    style.cap = 'butt';
    style.dash = [10, 10];
    approx(area(geometry.tessellate(geometry.strokeContours(line, style))), 500);
    style.dash = [0, 10, 5, 0];
    assert.ok(geometry.strokeContours(line, style).length > 0);
    style.dash = [-1, 2];
    assert.throws(() => geometry.strokeContours(line, style));
});
test('affine transform parsing and inversion use SVG composition order', () => {
    const m = math.parseTransform('translate(10,20) scale(2) rotate(90)');
    const p = math.transformPoint(m, [3, 4]);
    approx(p[0], 2);
    approx(p[1], 26);
    const q = math.transformPoint(math.inverse(m), p);
    approx(q[0], 3);
    approx(q[1], 4);
    assert.equal(math.inverse([0, 0, 0, 0, 0, 0]), null);
    assert.throws(() => math.parseTransform('scale(1)garbage'));
    const vb = math.viewBoxMatrix([0, 0, 100, 100], 200, 100);
    assert.deepEqual(vb, [1, 0, 0, 1, 50, 0]);
});
test('vector compiler exposes dependency-ordered isolation and blend passes', () => {
    const shape = {
        id: 'shape', matrix: math.identity(), path: path.parsePath('M0 0H100V100H0Z'), fill: { kind: 'solid', color: [1, 0, 0, 1] }, children: [], opacity: .5, fillRule: 'nonzero', strokeStyle: scene.defaultStroke(), nonScalingStroke: false, visible: true, blend: 'multiply'
    };
    const compiler = new VectorCompiler(), plan = compiler.compile([shape], 200, 100), seen = new Set();
    for (const pass of plan.passes) {
        for (const input of pass.reads)
            assert.ok(seen.has(input));
        seen.add(pass.id);
    }
    assert.equal(plan.passes.at(-1).id, plan.output);
    assert.ok(plan.passes.some(p => p.operations.some(op => op.kind === 'effect' && op.type === 'feBlend')));
});
test('closed curve strokes preserve their seam and bevel joins fill the corner', () => {
    const circle = contours('M20 0A20 20 0 1 0-20 0A20 20 0 1 0 20 0Z');
    assert.notDeepEqual(circle[0].points[0], circle[0].points.at(-1));
    const style = { ...scene.defaultStroke(), width: 10 };
    approx(area(geometry.tessellate(geometry.strokeContours(circle, style, .01))), Math.PI * (25 ** 2 - 15 ** 2), 10);
    const angle = contours('M0 0H50V50');
    const bevel = geometry.tessellate(geometry.strokeContours(angle, { ...style, join: 'bevel' }));
    const miter = geometry.tessellate(geometry.strokeContours(angle, style));
    assert.ok(area(bevel) > 975);
    assert.ok(area(miter) > area(bevel));
});
test('SMIL clock, numeric interpolation and discrete frames are deterministic', () => {
    assert.equal(animation.clock('01:02:03.5'), 3723.5);
    assert.equal(animation.clock('250ms'), .25);
    assert.throws(() => animation.clock('click'));
    assert.equal(animation.interpolate('M0 0L100 100', 'M20 10L120 200', .5), 'M10 5L110 150');
    const target = { getAttribute: () => null }, attrs = { dur: '2s', values: 'red;blue', attributeName: 'fill', calcMode: 'discrete' };
    const element = { localName: 'animate', parentElement: target, getAttribute: key => attrs[key] ?? null };
    assert.deepEqual(scene.color(animation.evaluateAnimation(element, .5, () => undefined).value), [1, 0, 0, 1]);
    assert.deepEqual(scene.color(animation.evaluateAnimation(element, 1.5, () => undefined).value), [0, 0, 1, 1]);
    assert.equal(animation.evaluateAnimation(element, 2.1, () => undefined), undefined);
});
test('CSS length math, transform units and font-face source parsing', () => {
    assert.equal(css.length('clamp(10px, calc(50% - 5px), 100px)', 100), 45);
    assert.equal(css.length('calc(2em + 10%)', 100, 20), 50);
    assert.throws(() => css.length('calc(1 / 0)', 100));
    const m = math.parseTransform('translateX(50%) rotate(.25turn)', 100, 80), p = math.transformPoint(m, [1, 0]);
    approx(p[0], 50);
    approx(p[1], 1);
    const face = css.extractFontFaces('@font-face{font-family:"Face";src:url("font.woff2") format("woff2"),url("data:font/woff;base64,AAAA")} .a{fill:red}');
    assert.equal(face.fonts[0].source, 'data:font/woff;base64,AAAA');
    assert.equal(face.css.trim(), '.a{fill:red}');
});
test('SVG turbulence tables are deterministic normalized independent color lattices', () => {
    const a = noise.turbulenceTable(3), b = noise.turbulenceTable(3);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, noise.turbulenceTable(4));
    assert.deepEqual(noise.turbulenceTable(0), noise.turbulenceTable(1));
    const permutation = new Set();
    for (let i = 0; i < 256; i++)
        permutation.add(a[i * 4]);
    assert.equal(permutation.size, 256);
    for (let c = 1; c < 5; c++)
        for (let i = 0; i < 256; i++) {
            const offset = (c * 256 + i) * 4;
            approx(Math.hypot(a[offset], a[offset + 1]), 1, .00001);
        }
});

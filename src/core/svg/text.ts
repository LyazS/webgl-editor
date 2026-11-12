import * as hb from "harfbuzzjs";
import type { TextFont } from '../render-graph/text-layout';
import { bounds, identity, inverse, multiply, parseTransform, type Bounds, type Matrix, type Point, transformPoint } from '../vector/math';
import { flatten, parsePath, pathLength, pointAtLength, type Contour, type Segment } from '../vector/path';
import { defaultStroke, type Paint, type VectorNode } from '../vector/scene';
import { length, opacity, type Style } from './style';
interface TextContext {
    width: number;
    height: number;
    fontSize: number;
}
interface Positioning {
    x: number[];
    y: number[];
    dx: number[];
    dy: number[];
    rotate: number[];
    at: number;
}
interface Record {
    element: Element;
    fillOwner: Element;
    strokeOwner: Element;
    node: VectorNode;
    pathPlacement?: {
        x: number;
        scaleX: number;
    };
    style: Style;
    size: number;
    scale: number;
    place: (shift: number) => Matrix;
}
export interface SvgTextServices {
    style: (element: Element, parent: Style) => Style;
    fonts: (style: Style) => TextFont[];
    reference: (id: string) => Element;
    paint: (value: string, style: Style, size: number, box: Bounds, alpha: number, scope: Matrix) => Paint | undefined;
    decorate: (element: Element, node: VectorNode, style: Style, size: number, scope: Matrix) => void;
}
const outlines = new WeakMap<TextFont, Map<number, Segment[]>>();
function outline(font: TextFont, id: number): Segment[] {
    let cache = outlines.get(font);
    if (!cache) {
        cache = new Map();
        outlines.set(font, cache);
    }
    let path = cache.get(id);
    if (!path) {
        path = parsePath(font.font.glyphToPath(id));
        cache.set(id, path);
        if (cache.size > 2048)
            cache.delete(cache.keys().next().value!);
    }
    return path;
}
const group = (id = ''): VectorNode => ({
    id, matrix: identity(), opacity: 1, children: [], fillRule: 'nonzero', strokeStyle: defaultStroke(), nonScalingStroke: false, blend: 'normal', visible: true
});
/** SVG character positioning is applied before glyph transforms. Font shaping is
 * retained for ordinary runs; explicitly positioned characters form new runs. */
export function layoutSvgText(root: Element, rootStyle: Style, context: TextContext, services: SvgTextServices): VectorNode[] {
    if ((root.textContent ?? '').length > 20000)
        throw new Error('SVG text exceeds the character budget');
    const result: VectorNode[] = [], records: Record[] = [], states: Positioning[] = [];
    const containers = new Map<VectorNode, {
        element: Element;
        style: Style;
        size: number;
        matrix: Matrix;
    }>(), scopes = new Map<Element, Matrix>();
    const axis = /^(vertical|tb)/.test(rootStyle['writing-mode']) ? 1 : 0;
    let cursor: Point = [0, 0], chunkStart = 0, chunkX = 0, chunkAnchor = rootStyle['text-anchor'], chunkRTL = rootStyle.direction === 'rtl';
    const textNodes: Node[] = [];
    const collect = (e: Element) => {
        for (const child of e.childNodes)
            if ((child.nodeType === 3 || child.nodeType === 4))
                textNodes.push(child);
            else if (child.nodeType === 1 && ['tspan', 'textPath', 'a'].includes((child as Element).localName))
                collect(child as Element);
    };
    collect(root);
    const lastText = [...textNodes].reverse().find(node => /\S/.test(node.textContent ?? ''));
    let hasText = false, lastWasSpace = false, passedLast = false;
    const finishChunk = () => {
        const advance = cursor[axis] - chunkX, shift = chunkAnchor === 'middle' ? -advance / 2 : (chunkAnchor === 'end') !== chunkRTL ? -advance : 0;
        if (shift)
            for (const record of records.slice(chunkStart))
                record.node.matrix = record.place(shift);
        chunkStart = records.length;
        chunkX = cursor[axis];
    };
    const walk = (element: Element, parent: Style, parentSize: number, parentMatrix: Matrix, output: VectorNode[], path?: {
        contours: Contour[];
        start: number;
    }, isRoot = false, owners = { fill: root, stroke: root }) => {
        if (states.length >= 64)
            throw new Error("SVG text nesting budget exceeded");
        const style = isRoot ? { ...rootStyle } : services.style(element, parent), size = isRoot ? context.fontSize : length(style['font-size'], parentSize, parentSize, 16);
        style['font-size'] = String(size);
        const list = (name: string, axis = 'x') => (element.getAttribute(name) ?? '').trim().split(/[\s,]+/).filter(Boolean).map(v => length(v, axis === 'x' ? context.width : context.height, size));
        const positioning: Positioning = {
            x: list('x'), y: list('y', 'y'), dx: list('dx'), dy: list('dy', 'y'), rotate: list('rotate'), at: 0
        };
        states.push(positioning);
        const matrix = isRoot ? parentMatrix : multiply(parentMatrix, parseTransform(style.transform ?? '', context.width, context.height));
        scopes.set(element, matrix);
        if (!isRoot)
            owners = { fill: style.fill !== parent.fill ? element : owners.fill, stroke: style.stroke !== parent.stroke ? element : owners.stroke };
        if (positioning.x.length || positioning.y.length) {
            finishChunk();
            if (positioning.x.length)
                cursor[0] = positioning.x[0];
            if (positioning.y.length)
                cursor[1] = positioning.y[0];
            chunkX = cursor[axis];
            chunkAnchor = style['text-anchor'];
            chunkRTL = style.direction === 'rtl';
        }
        if (element.localName === 'textPath') {
            finishChunk();
            const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
            if (!href?.startsWith('#'))
                throw new Error('textPath requires a local path');
            const target = services.reference(href.slice(1));
            const contours = flatten(parsePath(target.getAttribute('d') ?? ''), parseTransform(target.getAttribute('transform') ?? ''));
            path = { contours, start: length(element.getAttribute('startOffset') ?? '0', pathLength(contours), size) };
            cursor[0] = positioning.x[0] ?? 0;
            chunkX = cursor[axis];
            chunkAnchor = style['text-anchor'];
            chunkRTL = style.direction === 'rtl';
        }
        const startIndex = records.length, startX = cursor[axis];
        const fonts = services.fonts(style);
        if (!fonts.length)
            throw new Error('SVG text requires a loaded font');
        const select = (text: string) => fonts.find(font => Array.from(text).every(c => /[\s\u200c\u200d\ufe0e\ufe0f]/u.test(c) || font.font.nominalGlyph(c.codePointAt(0)!))) ?? fonts[0];
        const advanceStates = (text: string) => {
            const n = Array.from(text).length;
            for (const state of states)
                state.at += n;
        };
        const latest = (key: 'x' | 'y' | 'rotate'): number | undefined => {
            for (let i = states.length - 1; i >= 0; i--) {
                const s = states[i], values = s[key];
                const value = values[key === 'rotate' ? Math.min(s.at, values.length - 1) : s.at];
                if (value !== undefined)
                    return value;
            }
            return undefined;
        };
        const emit = (text: string, font: TextFont, rotation = 0) => {
            const spacing = length(style['letter-spacing'] === 'normal' ? '0' : style['letter-spacing'], size, size), features: string[] = ['kern', 'liga'];
            if (style['font-kerning'] === 'none')
                features.push('kern=0');
            if (style['font-variant-ligatures'] === 'none')
                features.push('liga=0', 'clig=0');
            if (style['font-feature-settings'] && style['font-feature-settings'] !== 'normal')
                for (const setting of style['font-feature-settings'].split(',')) {
                    const m = /["']([\w]{4})["']\s*(on|off|\d+)?/.exec(setting);
                    if (!m)
                        throw new Error('Invalid font-feature-settings');
                    features.push(`${m[1]}=${m[2] === 'off' ? 0 : m[2] === 'on' || !m[2] ? 1 : Number(m[2])}`);
                }
            const scale = size / font.font.face.upem, extents = font.font.hExtents(), ascender = extents.ascender * scale, descender = extents.descender * scale;
            const upright = axis === 1 && (style['text-orientation'] === 'upright' || style['text-orientation'] === 'mixed' && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff00-\uffef\s]+$/u.test(text));
            let layout: ReturnType<TextFont['layout']>, advance: number;
            if (upright) {
                const buffer = new hb.Buffer();
                buffer.addText(text);
                buffer.guessSegmentProperties();
                buffer.setDirection(hb.Direction.TTB);
                const parsed = features.map(value => hb.Feature.fromString(value)!);
                hb.shape(font.font, buffer, parsed);
                const positions = buffer.getGlyphPositions();
                let y = 0;
                layout = { size, glyphs: buffer.getGlyphInfos().map((info, i) => {
                        const p = positions[i], glyph = { id: info.codepoint, x: p.xOffset * scale, y: y - p.yOffset * scale };
                        y += -p.yAdvance * scale + spacing;
                        return glyph;
                    }) };
                advance = y;
            }
            else {
                layout = font.layout(text, { size, color: [1, 1, 1, 1], anchor: 'baseline', letterSpacing: spacing }, features);
                const last = layout.glyphs.at(-1);
                advance = last ? last.x + font.font.glyphHAdvance(last.id) * scale + spacing : 0;
            }
            const baseline = style['dominant-baseline'] === 'auto' ? (style['alignment-baseline'] ?? 'baseline') : style['dominant-baseline'];
            let baselineOffset = baseline === 'middle' ? size * .25 : baseline === 'central' ? (ascender + descender) / 2 : ['text-before-edge', 'before-edge', 'hanging'].includes(baseline) ? ascender : baseline === 'text-after-edge' || baseline === 'after-edge' ? descender : 0;
            const shift = style['baseline-shift'] ?? 'baseline';
            baselineOffset += shift === 'super' ? -size * .6 : shift === 'sub' ? size * .3 : shift === 'baseline' ? 0 : -length(shift, size, size);
            const os2 = font.font.face.referenceTable('OS/2'), meta = os2 ? new DataView(os2.buffer, os2.byteOffset, os2.length) : undefined, axes = font.font.face.getAxisInfos(), weight = style['font-weight'] === 'bold' ? 700 : style['font-weight'] === 'normal' ? 400 : Number(style['font-weight']);
            const actualWeight = meta && meta.byteLength >= 6 ? meta.getUint16(4) : 400, actualItalic = !!(meta && meta.byteLength >= 64 && (meta.getUint16(62) & 1));
            const bold = weight >= 600 && actualWeight < 600 && !axes.wght && style['font-synthesis'] !== 'none' && style['font-synthesis'].includes('weight') ? font.font.face.upem / 24 : undefined;
            const syntheticItalic = !actualItalic && !axes.ital && !axes.slnt && (style['font-style'] === 'italic' || style['font-style'].startsWith('oblique')) && style['font-synthesis'] !== 'none' && style['font-synthesis'].includes('style');
            const italic: Matrix = [1, 0, syntheticItalic ? Math.tan(12 * Math.PI / 180) : 0, 1, 0, 0];
            for (const glyph of layout.glyphs) {
                const node = group(element.id);
                node.syntheticBold = bold;
                node.fillRule = style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
                node.path = outline(font, glyph.id);
                node.visible = style.display !== 'none' && style.visibility === 'visible';
                const sideways = axis === 1 && !upright;
                const x = sideways ? cursor[0] - (ascender + descender) / 2 - glyph.y : cursor[0] + glyph.x, y = sideways ? cursor[1] + glyph.x : cursor[1] + glyph.y + baselineOffset, angle = (rotation + (sideways ? 90 : 0)) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
                const paintedVisible = node.visible, pathPlacement = path ? { x, scaleX: 1 } : undefined, halfAdvance = font.font.glyphHAdvance(glyph.id) * scale / 2;
                const place = (anchor: number): Matrix => {
                    if (path && pathPlacement) {
                        const half = halfAdvance * pathPlacement.scaleX, distance = path.start + pathPlacement.x + anchor + half, p = pointAtLength(path.contours, distance);
                        node.visible = paintedVisible && distance >= 0 && distance <= pathLength(path.contours);
                        return multiply(matrix, multiply(multiply([p.tangent[0], p.tangent[1], -p.tangent[1], p.tangent[0], p.point[0], p.point[1]], [c * scale * pathPlacement.scaleX, s * scale * pathPlacement.scaleX, s * scale, -c * scale, -half, y]), italic));
                    }
                    return multiply(matrix, multiply([c * scale, s * scale, s * scale, -c * scale, x + (axis === 0 ? anchor : 0), y + (axis === 1 ? anchor : 0)], italic));
                };
                node.matrix = place(0);
                if (records.length >= 10000)
                    throw new Error('SVG text exceeds 10000 glyphs');
                output.push(node);
                records.push({
                    element, fillOwner: owners.fill, strokeOwner: owners.stroke, node, pathPlacement, style, size, scale, place
                });
            }
            cursor[axis] += advance;
            advanceStates(text);
        };
        for (const child of element.childNodes) {
            if (child.nodeType === 1) {
                const e = child as Element;
                if (!['tspan', 'textPath', 'a'].includes(e.localName))
                    continue;
                const s = services.style(e, style);
                if (s.display === 'none')
                    continue;
                const container = group(e.id);
                container.opacity = opacity(s.opacity);
                container.blend = s['mix-blend-mode'] ?? 'normal';
                container.isolated = s.isolation === 'isolate';
                container.visible = s.display !== 'none';
                output.push(container);
                const metadata = walk(e, style, size, matrix, container.children, path, false, owners);
                containers.set(container, { element: e, ...metadata });
                continue;
            }
            if (child.nodeType !== 3 && child.nodeType !== 4)
                continue;
            let owner: Element | null = element, xmlSpace: string | null = null;
            while (owner && xmlSpace === null) {
                xmlSpace = owner.getAttribute('xml:space');
                owner = owner.parentElement;
            }
            const preserve = xmlSpace === 'preserve' || style['white-space'].startsWith('pre');
            let text = (child.textContent ?? '').replace(/\r\n?/g, '\n');
            if (!preserve) {
                text = text.replace(/\s+/g, ' ');
                if (!hasText || lastWasSpace)
                    text = text.replace(/^ /, '');
                if (child === lastText || passedLast)
                    text = text.replace(/ $/, '');
            }
            if (child === lastText)
                passedLast = true;
            if (!text)
                continue;
            hasText = true;
            lastWasSpace = text.endsWith(' ');
            const positioned = states.some(s => s.x.length > 1 || s.y.length > 1 || s.dx.length || s.dy.length || s.rotate.length);
            if (positioned) {
                for (const character of Array.from(text)) {
                    const x = latest('x'), y = latest('y');
                    if (x !== undefined || y !== undefined) {
                        finishChunk();
                        if (x !== undefined)
                            cursor[0] = x;
                        if (y !== undefined)
                            cursor[1] = y;
                        chunkX = cursor[axis];
                        chunkAnchor = style['text-anchor'];
                        chunkRTL = style.direction === 'rtl';
                    }
                    for (const state of states) {
                        cursor[0] += state.dx[state.at] ?? 0;
                        cursor[1] += state.dy[state.at] ?? 0;
                    }
                    emit(character, select(character), latest('rotate') ?? 0);
                }
            }
            else {
                let run = '', font: TextFont | undefined, orientation: boolean | undefined;
                for (const character of Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)) {
                    const next = select(character), nextOrientation = axis === 1 && style['text-orientation'] === 'mixed' && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\u3000-\u303f\uff00-\uffef\s]+$/u.test(character);
                    if (font && (font !== next || orientation !== nextOrientation)) {
                        emit(run, font);
                        run = '';
                    }
                    font = next;
                    orientation = nextOrientation;
                    run += character;
                }
                if (run && font)
                    emit(run, font);
            }
        }
        const requested = element.getAttribute('textLength');
        if (requested !== null) {
            const target = length(requested, context.width, size), natural = cursor[axis] - startX, span = records.slice(startIndex);
            if (target < 0)
                throw new Error('Negative textLength');
            if (natural > 0 && span.length) {
                if (span.every(record => record.pathPlacement)) {
                    const stretch = target / natural, spacing = span.length > 1 ? (target - natural) / (span.length - 1) : 0;
                    span.forEach((record, i) => {
                        const p = record.pathPlacement!;
                        if (element.getAttribute('lengthAdjust') === 'spacingAndGlyphs') {
                            p.x = startX + (p.x - startX) * stretch;
                            p.scaleX *= stretch;
                        }
                        else
                            p.x += i * spacing;
                        record.node.matrix = record.place(0);
                    });
                }
                else {
                    if (element.getAttribute('lengthAdjust') === 'spacingAndGlyphs') {
                        const stretch = target / natural;
                        for (const record of span)
                            record.node.matrix = multiply(axis === 0 ? [stretch, 0, 0, 1, startX * (1 - stretch), 0] : [1, 0, 0, stretch, 0, startX * (1 - stretch)], record.node.matrix);
                    }
                    else if (span.length > 1) {
                        const spacing = (target - natural) / (span.length - 1);
                        span.forEach((record, i) => record.node.matrix[axis === 0 ? 4 : 5] += i * spacing);
                    }
                    for (const record of span) {
                        const adjusted = [...record.node.matrix] as Matrix;
                        record.place = (shift) => multiply([1, 0, 0, 1, axis === 0 ? shift : 0, axis === 1 ? shift : 0], adjusted);
                    }
                }
                cursor[axis] = startX + target;
            }
        }
        states.pop();
        return { style, size, matrix };
    };
    walk(root, rootStyle, context.fontSize, identity(), result, undefined, true);
    finishChunk();
    const boxes = new Map<Element, Bounds>(), inverseScopes = new Map<Element, Matrix>();
    for (const [element, scope] of scopes)
        inverseScopes.set(element, inverse(scope) ?? identity());
    for (const record of records) {
        const points = flatten(record.node.path!, record.node.matrix).flatMap(c => c.points);
        if (!points.length)
            continue;
        for (let owner: Element | null = record.element; owner && scopes.has(owner); owner = owner.parentElement) {
            const local = bounds(points.map(point => transformPoint(inverseScopes.get(owner)!, point))), previous = boxes.get(owner);
            if (!previous)
                boxes.set(owner, local);
            else {
                const x = Math.min(previous.x, local.x), y = Math.min(previous.y, local.y), right = Math.max(previous.x + previous.width, local.x + local.width), bottom = Math.max(previous.y + previous.height, local.y + local.height);
                boxes.set(owner, { x, y, width: right - x, height: bottom - y });
            }
        }
    }
    const adjust = (paint: Paint | undefined, matrix: Matrix, scope: Matrix): Paint | undefined => paint && paint.kind !== 'solid' ? { ...paint, matrix: multiply(inverse(matrix) ?? identity(), multiply(scope, paint.matrix)) } : paint;
    for (const record of records) {
        const { node, style, size, scale } = record, fillScope = scopes.get(record.fillOwner) ?? identity(), strokeScope = scopes.get(record.strokeOwner) ?? identity();
        node.fill = adjust(services.paint(style.fill, style, size, boxes.get(record.fillOwner) ?? { x: 0, y: 0, width: 0, height: 0 }, opacity(style['fill-opacity']), fillScope), node.matrix, fillScope);
        node.stroke = adjust(services.paint(style.stroke, style, size, boxes.get(record.strokeOwner) ?? { x: 0, y: 0, width: 0, height: 0 }, opacity(style['stroke-opacity']), strokeScope), node.matrix, strokeScope);
        node.strokeStyle = {
            ...defaultStroke(), width: length(style['stroke-width'], Math.hypot(context.width, context.height) / Math.SQRT2, size) / scale, cap: style['stroke-linecap'] as 'butt', join: style['stroke-linejoin'] as 'miter', miterLimit: Number(style['stroke-miterlimit']), dash: style['stroke-dasharray'] === 'none' ? [] : style['stroke-dasharray'].split(/[\s,]+/).map(v => length(v, size, size) / scale), dashOffset: length(style['stroke-dashoffset'], size, size) / scale
        };
    }
    const normalize = (nodes: VectorNode[], parent: Matrix) => {
        for (const node of nodes) {
            const metadata = containers.get(node);
            if (metadata) {
                node.matrix = multiply(inverse(parent) ?? identity(), metadata.matrix);
                normalize(node.children, metadata.matrix);
                services.decorate(metadata.element, node, metadata.style, metadata.size, metadata.matrix);
            }
            else
                node.matrix = multiply(inverse(parent) ?? identity(), node.matrix);
        }
    };
    normalize(result, identity());
    return result;
}

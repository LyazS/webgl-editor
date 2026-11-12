import { layoutSvgText } from "./text";
import { evaluateAnimation } from "./animation";
import { bounds, identity, inverse, transformPoint, multiply, numbers, parseTransform, viewBoxMatrix, type Matrix, type Bounds, type Point } from '../vector/math';
import { flatten, parsePath, pointAtLength, type Segment } from '../vector/path';
import { color, defaultStroke, type Paint, type VectorNode, type FilterPrimitive } from '../vector/scene';
import { computeStyle, defaults, extractFontFaces, length, opacity, parseCss, type CssRule, type Style } from './style';
import { TextFont } from '../render-graph/text-layout';
import { contains, strokeContours } from '../vector/geometry';
const refId = (value: string | undefined) => value && /^url\(\s*['"]?#([^\s)'"\u0000]+)['"]?\s*\)/.exec(value)?.[1];
const supported = new Set('svg g a switch defs symbol use path rect circle ellipse line polyline polygon linearGradient radialGradient stop pattern clipPath mask filter feGaussianBlur feOffset feFlood feColorMatrix feBlend feComposite feMerge feMergeNode feComponentTransfer feFuncR feFuncG feFuncB feFuncA feMorphology feDropShadow feConvolveMatrix feDisplacementMap feTile feImage feTurbulence feDiffuseLighting feSpecularLighting feDistantLight fePointLight feSpotLight image text tspan textPath marker style title desc metadata animate animateTransform animateMotion mpath set'.split(' '));
const drawable = new Set('svg g a switch use path rect circle ellipse line polyline polygon image text'.split(' '));
interface Context {
    scope?: Matrix;
    contextScope?: Matrix;
    contextFill?: Paint;
    contextStroke?: Paint;
    width: number;
    height: number;
    fontSize: number;
    stack: Set<Element>;
}
export interface SvgOptions {
    strict?: boolean;
}
export interface SvgSnapshot {
    attributes: Record<string, Record<string, string>>;
    texts: Record<string, string>;
}
/** Retained source tree. Geometry and GPU caches use document identity + revision. */
export class SvgDocument {
    readonly xml: Document;
    readonly diagnostics: string[] = [];
    readonly elements = new Map<string, Element>();
    readonly rules: CssRule[];
    readonly fontSources: import("./style").SvgFontSource[];
    private readonly animations: Element[];
    private animatedStyles = new Map<Element, Style>();
    revision = 0;
    font?: TextFont;
    private fontFaces = new Map<string, TextFont>();
    private styledFonts = new WeakMap<TextFont, Map<string, TextFont>>();
    private readonly baseAttributes = new Map<string, Map<string, string | null>>();
    private readonly liveAttributes = new Map<string, Map<string, string>>();
    private readonly baseTexts = new Map<string, string>();
    private readonly liveTexts = new Map<string, string>();
    private sceneCache?: {
        key: string;
        nodes: VectorNode[];
    };
    constructor(source: string, readonly options: SvgOptions = {}) {
        if (typeof DOMParser === 'undefined')
            throw new Error('SVG parsing requires a browser DOMParser');
        if (source.length > 8000000 || new TextEncoder().encode(source).byteLength > 8000000)
            throw new Error('SVG document exceeds 8 MB');
        if (/<!ENTITY/i.test(source))
            throw new Error('Custom XML entities are not supported');
        source = source.replace(/<!DOCTYPE(?:[^>"']|"[^"]*"|'[^']*')*>/gi, declaration => {
            if (declaration.includes('['))
                throw new Error('Internal XML DTDs are not supported');
            return '';
        });
        this.xml = new DOMParser().parseFromString(source, 'image/svg+xml');
        const error = this.xml.querySelector('parsererror');
        if (error)
            throw new Error(`Invalid SVG XML: ${error.textContent}`);
        if (this.xml.documentElement.namespaceURI && this.xml.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg')
            throw new Error('Invalid SVG root namespace');
        if (this.xml.documentElement.localName !== 'svg')
            throw new Error('SVG document root must be <svg>');
        if (source.length > 8000000)
            throw new Error('SVG document exceeds 8 MB');
        const elements = [this.xml.documentElement, ...this.xml.documentElement.querySelectorAll('*')];
        const all = elements.filter(e => (!e.namespaceURI || e.namespaceURI === 'http://www.w3.org/2000/svg') && !e.closest('metadata, title, desc'));
        if (elements.length > 20000)
            throw new Error('SVG element budget exceeded');
        for (const element of all) {
            if (element.id) {
                if (this.elements.has(element.id))
                    throw new Error(`Duplicate SVG id: ${element.id}`);
                this.elements.set(element.id, element);
            }
            if (!supported.has(element.localName))
                this.diagnostics.push(`Unsupported SVG element <${element.localName}>${element.id ? ` #${element.id}` : ''}`);
            for (const a of element.attributes)
                if (a.name.startsWith('on'))
                    this.diagnostics.push(`SVG event handler ${a.name} is not executable`);
        }
        if (this.diagnostics.length && options.strict !== false)
            throw new Error(this.diagnostics.join('\n'));
        this.animations = all.filter(e => ["animate", "animateTransform", "animateMotion", "set"].includes(e.localName));
        const styles = all.filter(e => e.localName === 'style').map(e => extractFontFaces(e.textContent ?? ''));
        this.fontSources = styles.flatMap(s => s.fonts);
        this.rules = styles.flatMap(s => parseCss(s.css));
    }
    setFont(data: Uint8Array): void {
        this.font = new TextFont(data);
        this.revision++;
    }
    setFontFaces(faces: Record<string, Uint8Array>): void {
        this.fontFaces = new Map(Object.entries(faces).map(([name, data]) => [name.trim().toLowerCase(), (this.font?.data === data ? this.font : new TextFont(data))]));
        this.revision++;
    }
    setAttribute(id: string, name: string, value: string): void {
        const element = this.elements.get(id);
        if (!element)
            throw new Error(`SVG element not found: ${id}`);
        if (name === 'id' || name === 'xmlns' || name === 'style' || name === 'class' || name === 'href' || name === 'xlink:href' || name.startsWith('on'))
            throw new Error(`SVG live attribute ${name} is not supported; replace the document instead`);
        if (name === 'd')
            parsePath(value);
        if (name === 'transform')
            parseTransform(value);
        if (value.length > 8000000 || new TextEncoder().encode(value).byteLength > 8000000)
            throw new Error('SVG attribute exceeds the document budget');
        const before = element.getAttribute(name);
        element.setAttribute(name, value);
        this.revision++;
        this.sceneCache = undefined;
        try {
            if (this.font || !this.xml.querySelector("text"))
                this.scene(300, 150);
        }
        catch (error) {
            if (before === null)
                element.removeAttribute(name);
            else
                element.setAttribute(name, before);
            this.revision++;
            throw error;
        }
        let base = this.baseAttributes.get(id);
        if (!base) {
            base = new Map();
            this.baseAttributes.set(id, base);
        }
        if (!base.has(name))
            base.set(name, before);
        let live = this.liveAttributes.get(id);
        if (!live) {
            live = new Map();
            this.liveAttributes.set(id, live);
        }
        live.set(name, value);
    }
    private applyText(element: Element, value: string): void {
        for (const node of Array.from(element.childNodes))
            if (node.nodeType === 3 || node.nodeType === 4)
                element.removeChild(node);
        element.insertBefore(this.xml.createTextNode(value), element.firstChild);
    }
    setText(id: string, value: string): void {
        const element = this.elements.get(id);
        if (!element || !['text', 'tspan'].includes(element.localName))
            throw new Error(`SVG text element not found: ${id}`);
        if (value.length > 20000)
            throw new Error('SVG text exceeds the character budget');
        if (Array.from(element.children).some(e => ['tspan', 'textPath', 'a'].includes(e.localName)))
            throw new Error('setText requires a leaf text/tspan; update its individual spans');
        if (!this.baseTexts.has(id))
            this.baseTexts.set(id, Array.from(element.childNodes).filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.textContent ?? '').join(''));
        this.applyText(element, value);
        this.liveTexts.set(id, value);
        this.revision++;
        this.sceneCache = undefined;
    }
    snapshot(): SvgSnapshot {
        return { attributes: Object.fromEntries([...this.liveAttributes].map(([id, values]) => [id, Object.fromEntries(values)])), texts: Object.fromEntries(this.liveTexts) };
    }
    restore(snapshot: SvgSnapshot): void {
        for (const [id, values] of this.baseAttributes) {
            const element = this.elements.get(id)!;
            for (const [name, value] of values)
                if (value === null)
                    element.removeAttribute(name);
                else
                    element.setAttribute(name, value);
        }
        for (const [id, value] of this.baseTexts)
            this.applyText(this.elements.get(id)!, value);
        this.liveAttributes.clear();
        this.liveTexts.clear();
        for (const [id, values] of Object.entries(snapshot.attributes)) {
            const element = this.elements.get(id);
            if (!element)
                throw new Error(`SVG checkpoint element not found: ${id}`);
            const copy = new Map<string, string>();
            for (const [name, value] of Object.entries(values)) {
                if (name === 'id' || name === 'style' || name === 'class' || name === 'href' || name === 'xlink:href' || name === 'xmlns' || name.startsWith('on'))
                    throw new Error('Invalid SVG checkpoint attribute');
                let base = this.baseAttributes.get(id);
                if (!base) {
                    base = new Map();
                    this.baseAttributes.set(id, base);
                }
                if (!base.has(name))
                    base.set(name, element.getAttribute(name));
                element.setAttribute(name, value);
                copy.set(name, value);
            }
            this.liveAttributes.set(id, copy);
        }
        for (const [id, value] of Object.entries(snapshot.texts)) {
            const element = this.elements.get(id);
            if (!element)
                throw new Error(`SVG checkpoint text not found: ${id}`);
            if (!this.baseTexts.has(id))
                this.baseTexts.set(id, Array.from(element.childNodes).filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.textContent ?? '').join(''));
            this.applyText(element, value);
            this.liveTexts.set(id, value);
        }
        this.revision++;
        this.sceneCache = undefined;
    }
    scene(width: number, height: number, time = 0): VectorNode[] {
        if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)))
            throw new Error('SVG viewport must be positive and finite');
        const key = `${this.revision}:${width}:${height}:${this.animations.length ? time : 0}`;
        if (this.sceneCache?.key === key)
            return this.sceneCache.nodes;
        const originals: Array<{
            element: Element;
            name: string;
            value: string | null;
        }> = [];
        try {
            for (const animation of this.animations) {
                const value = evaluateAnimation(animation, time, id => this.elements.get(id));
                if (!value)
                    continue;
                originals.push({ element: value.target, name: value.attribute, value: value.target.getAttribute(value.attribute) });
                value.target.setAttribute(value.attribute, value.value);
                const style = this.animatedStyles.get(value.target) ?? {};
                style[value.attribute] = value.value;
                this.animatedStyles.set(value.target, style);
            }
            const root = this.node(this.xml.documentElement, defaults, { width, height, fontSize: 16, stack: new Set() }, true);
            const nodes = root ? [root] : [];
            this.sceneCache = { key, nodes };
            return nodes;
        }
        finally {
            for (const original of originals.reverse()) {
                if (original.value === null)
                    original.element.removeAttribute(original.name);
                else
                    original.element.setAttribute(original.name, original.value);
            }
            this.animatedStyles.clear();
        }
    }
    hitTest(x: number, y: number, width: number, height: number): string[] {
        const hits: string[] = [];
        const covers = (nodes: VectorNode[], parent: Matrix): boolean => nodes.some(node => {
            if (!node.visible)
                return false;
            const m = multiply(parent, node.matrix);
            if (node.clip?.some(clip => !covers([clip], m)))
                return false;
            return !!(node.path && node.fill && contains(flatten(node.path, m), [x, y], node.fillRule)) || covers(node.children, m);
        });
        const visit = (nodes: VectorNode[], parent: Matrix, instanceId?: string) => {
            for (const node of nodes) {
                if (!node.visible)
                    continue;
                const m = multiply(parent, node.matrix), instance = node.hitId ?? instanceId, id = instance ?? node.id;
                if (node.clip?.some(clip => !covers([clip], m)))
                    continue;
                if (node.path) {
                    const local = flatten(node.path), inv = inverse(m);
                    if (inv) {
                        const point = transformPoint(inv, [x, y]);
                        const fill = node.fill && contains(local, point, node.fillRule), stroke = node.stroke && (node.nonScalingStroke ? contains(strokeContours(flatten(node.path, m), node.strokeStyle), [x, y]) : contains(strokeContours(local, node.strokeStyle), point));
                        if ((fill || stroke) && id)
                            hits.push(id);
                    }
                }
                if (node.image && id) {
                    const inv = inverse(m);
                    if (inv) {
                        const p = transformPoint(inv, [x, y]), b = node.image.box;
                        if (p[0] >= b.x && p[0] <= b.x + b.width && p[1] >= b.y && p[1] <= b.y + b.height)
                            hits.push(id);
                    }
                }
                visit(node.children, m, instance);
                visit(node.markers ?? [], m, instance ?? node.id);
            }
        };
        visit(this.scene(width, height), identity());
        return [...new Set(hits.reverse())];
    }
    private style(element: Element, parent: Style): Style {
        return { ...computeStyle(element, parent, this.rules), ...this.animatedStyles.get(element) };
    }
    private resolve(id: string, context: Context): Element {
        const e = this.elements.get(id);
        if (!e)
            throw new Error(`SVG reference #${id} does not exist`);
        if (context.stack.has(e))
            throw new Error(`Circular SVG reference #${id}`);
        return e;
    }
    private node(element: Element, parent: Style, context: Context, root = false, force = false): VectorNode | undefined {
        if (context.stack.size > 64)
            throw new Error('SVG reference/nesting depth exceeds 64');
        const name = element.localName;
        if (element.namespaceURI && element.namespaceURI !== 'http://www.w3.org/2000/svg')
            return undefined;
        if (!drawable.has(name) && !force)
            return undefined;
        const style = this.style(element, parent), fontSize = length(style['font-size'], context.fontSize, context.fontSize, 16), stack = new Set(context.stack);
        stack.add(element);
        let ctx = { ...context, fontSize, stack };
        const attr = (key: string, fallback = 0, axis = 'x') => length((style[key] ?? element.getAttribute(key)) === 'auto' ? undefined : style[key] ?? element.getAttribute(key) ?? undefined, axis === 'x' ? ctx.width : axis === 'y' ? ctx.height : Math.hypot(ctx.width, ctx.height) / Math.SQRT2, fontSize, fallback);
        let referenceBox = { x: 0, y: 0, width: ctx.width, height: ctx.height };
        if (style['transform-box'] === 'fill-box') {
            const d = this.shape(element, attr, style);
            if (d)
                referenceBox = bounds(flatten(parsePath(d)).flatMap(c => c.points));
        }
        let matrix = parseTransform(style.transform ?? element.getAttribute('transform') ?? '', referenceBox.width, referenceBox.height), width = ctx.width, height = ctx.height;
        const origin = (style['transform-origin'] ?? '0 0').split(/\s+/), keywords: Record<string, string> = {
            left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%'
        };
        if (origin[0] === 'top' || origin[0] === 'bottom')
            origin.reverse();
        const ox = referenceBox.x + length(keywords[origin[0]] ?? origin[0], referenceBox.width, fontSize), oy = referenceBox.y + length(keywords[origin[1] ?? 'center'] ?? origin[1] ?? '50%', referenceBox.height, fontSize);
        if (ox || oy)
            matrix = multiply([1, 0, 0, 1, ox, oy], multiply(matrix, [1, 0, 0, 1, -ox, -oy]));
        if (name === 'svg' || name === 'symbol') {
            width = root ? ctx.width : attr('width', ctx.width);
            height = root ? ctx.height : attr('height', ctx.height, 'y');
            matrix = multiply(matrix, [1, 0, 0, 1, attr('x'), attr('y', 0, 'y')]);
            const vb = element.getAttribute('viewBox');
            if (vb) {
                const box = numbers(vb);
                matrix = multiply(matrix, viewBoxMatrix(box, width, height, element.getAttribute('preserveAspectRatio') ?? undefined));
                ctx = { ...ctx, width: box[2], height: box[3] };
            }
            else
                ctx = { ...ctx, width, height };
        }
        ctx = { ...ctx, scope: multiply(context.scope ?? identity(), matrix) };
        const node: VectorNode = {
            id: element.id, matrix, opacity: opacity(style.opacity), children: [], fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero', clipRule: style['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero', isolated: style.isolation === 'isolate', strokeStyle: {
                ...defaultStroke(), width: length(style['stroke-width'], Math.hypot(ctx.width, ctx.height) / Math.SQRT2, fontSize), cap: style['stroke-linecap'] as 'butt', join: style['stroke-linejoin'] as 'miter', miterLimit: Number(style['stroke-miterlimit']), dash: style['stroke-dasharray'] === 'none' ? [] : style['stroke-dasharray'].split(/[\s,]+/).filter(Boolean).map(v => length(v, Math.hypot(ctx.width, ctx.height) / Math.SQRT2, fontSize)), dashOffset: length(style['stroke-dashoffset'], Math.hypot(ctx.width, ctx.height) / Math.SQRT2, fontSize)
            }, nonScalingStroke: style['vector-effect'] === 'non-scaling-stroke', paintOrder: style['paint-order'] === 'normal' ? ['fill', 'stroke', 'markers'] : [...new Set([...style['paint-order'].split(/\s+/), 'fill', 'stroke', 'markers'])], blend: style['mix-blend-mode'] ?? 'normal', visible: style.display !== 'none', paintVisible: style.visibility === 'visible'
        };
        if (node.strokeStyle.width < 0 || node.strokeStyle.miterLimit < 1 || !Number.isFinite(node.strokeStyle.miterLimit) || !['butt', 'round', 'square'].includes(node.strokeStyle.cap) || !['miter', 'round', 'bevel'].includes(node.strokeStyle.join))
            throw new Error(`Invalid SVG stroke on #${node.id}`);
        if (name === 'use') {
            node.hitId = element.id || undefined;
            const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
            if (!href?.startsWith('#'))
                throw new Error('SVG use requires a local fragment reference');
            const target = this.resolve(href.slice(1), ctx);
            let useCtx = ctx;
            if (target.localName === 'symbol' || target.localName === 'svg')
                useCtx = { ...ctx, width: attr('width', ctx.width), height: attr('height', ctx.height, 'y') };
            const child = this.node(target, style, useCtx, false, true);
            if (child)
                node.children.push(child);
            node.matrix = multiply(matrix, [1, 0, 0, 1, attr('x'), attr('y', 0, 'y')]);
        }
        else if (name === 'switch') {
            const languages = typeof navigator === 'undefined' ? ['en'] : navigator.languages;
            const child = Array.from(element.children).find(e => {
                if ((e.getAttribute('requiredExtensions') ?? '').trim())
                    return false;
                const requested = (e.getAttribute('systemLanguage') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                return !requested.length || requested.some(language => languages.some(current => current.toLowerCase() === language || current.toLowerCase().startsWith(language + '-')));
            });
            if (child) {
                const n = this.node(child, style, ctx);
                if (n)
                    node.children.push(n);
            }
        }
        else if (name === 'text' || name === 'tspan' || name === 'textPath') {
            node.children = this.text(element, style, ctx);
        }
        else if (name === 'image') {
            const source = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '';
            if (!source)
                throw new Error('SVG image has no href');
            if (/(?:image\/svg|\.svg(?:[?#]|$))/i.test(source))
                throw new Error('Nested SVG images must use inline <svg> or <use>');
            node.image = { source, box: { x: attr('x'), y: attr('y', 0, 'y'), width: attr('width'), height: attr('height', 0, 'y') }, aspect: element.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet' };
        }
        else {
            const d = this.shape(element, attr, style);
            if (d) {
                node.path = parsePath(d);
                const box = bounds(flatten(node.path).flatMap(c => c.points));
                node.fill = this.paint(style.fill, style, ctx, box, opacity(style['fill-opacity']));
                node.stroke = this.paint(style.stroke, style, ctx, box, opacity(style['stroke-opacity']));
            }
            node.children = Array.from(element.children).flatMap(child => {
                const n = this.node(child, style, ctx);
                return n ? [n] : [];
            });
        }
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
            node.fill = undefined;
            node.stroke = undefined;
            node.image = undefined;
        }
        if (node.path && style.visibility === 'visible')
            this.markers(element, node, style, ctx);
        this.applyEffects(element, node, style, ctx);
        if ((name === 'svg' || name === 'symbol') && style.overflow !== 'visible') {
            // Clip in local viewBox coordinates after its viewport transform.
            const vb = element.getAttribute('viewBox');
            const viewport = vb ? viewBoxMatrix(numbers(vb), width, height, element.getAttribute('preserveAspectRatio') ?? undefined) : identity();
            const clip = this.group([], inverse(viewport) ?? identity());
            clip.path = parsePath(`M0 0h${width}v${height}h${-width}Z`);
            clip.fill = { kind: 'solid', color: [1, 1, 1, 1] };
            node.clip = node.clip ? [this.group([...(node.clip)], identity()), clip] : [clip];
        }
        return node;
    }
    private applyEffects(element: Element, node: VectorNode, style: Style, ctx: Context): void {
        const fontSize = ctx.fontSize;
        const box = this.nodeBounds(node);
        const clipId = refId(style['clip-path']);
        if (clipId) {
            const clip = this.resolve(clipId, ctx);
            if (clip.localName !== 'clipPath')
                throw new Error('clip-path must reference a clipPath');
            const clipCtx = { ...ctx, stack: new Set([...ctx.stack, clip]) };
            const bbox = clip.getAttribute('clipPathUnits') === 'objectBoundingBox';
            const children = Array.from(clip.children).flatMap(e => {
                const n = this.node(e, this.style(clip, defaults), bbox ? { ...clipCtx, width: 1, height: 1 } : clipCtx);
                if (n) {
                    const normalize = (shape: VectorNode): void => {
                        if (shape.path)
                            shape.fill = shape.paintVisible === false ? undefined : { kind: 'solid', color: [1, 1, 1, 1] };
                        shape.stroke = undefined;
                        shape.markers = undefined;
                        shape.fillRule = shape.clipRule ?? shape.fillRule;
                        shape.opacity = 1;
                        shape.filter = undefined;
                        shape.mask = undefined;
                        shape.blend = 'normal';
                        shape.children.forEach(normalize);
                    };
                    normalize(n);
                    n.fillRule = this.style(e, this.style(clip, defaults))['clip-rule'] === 'evenodd' ? 'evenodd' : 'nonzero';
                }
                return n ? [n] : [];
            });
            const wrapper = this.group(children, multiply(bbox ? [box.width, 0, 0, box.height, box.x, box.y] : identity(), parseTransform(clip.getAttribute('transform') ?? '')));
            node.clip = [wrapper];
        }
        const maskId = refId(style.mask);
        if (maskId) {
            const mask = this.resolve(maskId, ctx);
            if (mask.localName !== 'mask')
                throw new Error('mask must reference a mask');
            const bbox = mask.getAttribute('maskContentUnits') === 'objectBoundingBox', maskCtx = { ...ctx, stack: new Set([...ctx.stack, mask]), ...(bbox ? { width: 1, height: 1 } : {}) };
            const nodes = Array.from(mask.children).flatMap(e => {
                const n = this.node(e, this.style(mask, defaults), maskCtx);
                return n ? [n] : [];
            });
            const units = mask.getAttribute('maskUnits') ?? 'objectBoundingBox', relative = units === 'objectBoundingBox';
            const region: Bounds = { x: length(mask.getAttribute('x') ?? '-10%', relative ? 1 : ctx.width, fontSize) + (relative ? 0 : 0), y: length(mask.getAttribute('y') ?? '-10%', relative ? 1 : ctx.height, fontSize), width: length(mask.getAttribute('width') ?? '120%', relative ? 1 : ctx.width, fontSize), height: length(mask.getAttribute('height') ?? '120%', relative ? 1 : ctx.height, fontSize) };
            if (relative) {
                region.x = box.x + region.x * box.width;
                region.y = box.y + region.y * box.height;
                region.width *= box.width;
                region.height *= box.height;
            }
            node.mask = { nodes: [this.group(nodes, bbox ? [box.width, 0, 0, box.height, box.x, box.y] : identity())], luminance: this.style(mask, defaults)['mask-type'] !== 'alpha', region };
        }
        const filterId = refId(style.filter);
        if (filterId) {
            const filter = this.resolve(filterId, ctx);
            if (filter.localName !== 'filter')
                throw new Error('filter must reference a filter');
            node.filter = Array.from(filter.children).filter(e => /^fe(?:Blend|ColorMatrix|ComponentTransfer|Composite|ConvolveMatrix|DiffuseLighting|DisplacementMap|DropShadow|Flood|GaussianBlur|Image|Merge|Morphology|Offset|SpecularLighting|Tile|Turbulence)$/.test(e.localName)).map(e => this.filterPrimitive(e));
            node.filterPaints = { fill: this.paint(style.fill, style, ctx, box, opacity(style['fill-opacity'])), stroke: this.paint(style.stroke, style, ctx, box, opacity(style['stroke-opacity'])) };
            const relative = filter.getAttribute('filterUnits') !== 'userSpaceOnUse';
            const region: Bounds = { x: length(filter.getAttribute('x') ?? '-10%', relative ? 1 : ctx.width, fontSize), y: length(filter.getAttribute('y') ?? '-10%', relative ? 1 : ctx.height, fontSize), width: length(filter.getAttribute('width') ?? '120%', relative ? 1 : ctx.width, fontSize), height: length(filter.getAttribute('height') ?? '120%', relative ? 1 : ctx.height, fontSize) };
            if (relative) {
                region.x = box.x + region.x * box.width;
                region.y = box.y + region.y * box.height;
                region.width *= box.width;
                region.height *= box.height;
            }
            node.filterRegion = region;
            const bboxPrimitives = filter.getAttribute('primitiveUnits') === 'objectBoundingBox';
            node.filterMatrix = bboxPrimitives ? [box.width, 0, 0, box.height, box.x, box.y] : identity();
            const inv = inverse(node.filterMatrix);
            const origin = inv ? transformPoint(inv, [region.x, region.y]) : [0, 0];
            const fallback = { x: origin[0], y: origin[1], width: bboxPrimitives ? region.width / (box.width || 1) : region.width, height: bboxPrimitives ? region.height / (box.height || 1) : region.height };
            for (const primitive of node.filter) {
                const a = primitive.attributes;
                primitive.region = { x: length(a.x, bboxPrimitives ? 1 : ctx.width, fontSize, fallback.x), y: length(a.y, bboxPrimitives ? 1 : ctx.height, fontSize, fallback.y), width: length(a.width, bboxPrimitives ? 1 : ctx.width, fontSize, fallback.width), height: length(a.height, bboxPrimitives ? 1 : ctx.height, fontSize, fallback.height) };
                if (primitive.region.width < 0 || primitive.region.height < 0)
                    throw new Error('Negative filter primitive region');
                if (primitive.type === 'feImage') {
                    const href = a.href ?? a['xlink:href'];
                    if (href?.startsWith('#')) {
                        const target = this.resolve(href.slice(1), { ...ctx, stack: new Set([...ctx.stack, filter]) });
                        const image = this.node(target, defaults, { ...ctx, width: primitive.region.width, height: primitive.region.height, stack: new Set([...ctx.stack, filter]) }, false, true);
                        primitive.scene = [];
                        if (image) {
                            const r = primitive.region;
                            primitive.scene = [this.group([image], [1, 0, 0, 1, r.x, r.y])];
                        }
                    }
                }
            }
        }
    }
    private group(children: VectorNode[], matrix: Matrix): VectorNode {
        return {
            id: '', matrix, children, opacity: 1, fillRule: 'nonzero', strokeStyle: defaultStroke(), nonScalingStroke: false, blend: 'normal', visible: true
        };
    }
    private nodeBounds(node: VectorNode): Bounds {
        const points: Point[] = [];
        const collect = (n: VectorNode, m: Matrix) => {
            if (n.path)
                for (const contour of flatten(n.path, m))
                    for (const point of contour.points)
                        points.push(point);
            if (n.image) {
                const b = n.image.box;
                for (const point of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]] as Point[])
                    points.push(transformPoint(m, point));
            }
            for (const c of n.children)
                collect(c, multiply(m, c.matrix));
        };
        collect(node, identity());
        return bounds(points);
    }
    private markers(element: Element, node: VectorNode, style: Style, ctx: Context): void {
        if (!node.path || !['path', 'line', 'polyline', 'polygon'].includes(element.localName))
            return;
        const contours = flatten(node.path, identity(), .05);
        for (const contour of contours) {
            const p = contour.points;
            if (p.length < 2)
                continue;
            const direction = (a: Point, b: Point): Point => {
                const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
                return d ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [1, 0];
            };
            const events: Array<{
                key: string;
                point: Point;
                angle: number;
                start: boolean;
            }> = [{ key: 'marker-start', point: p[0], angle: Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]), start: true }];
            // Mark only original path vertices, never the samples inserted by curve flattening.
            const originals = node.path.filter(s => s.op !== 'Z').map(s => (s as {
                p: Point;
            }).p);
            for (let i = 1; i < p.length - 1; i++)
                if (originals.some(q => Math.hypot(q[0] - p[i][0], q[1] - p[i][1]) < 1e-7)) {
                    const a = direction(p[i - 1], p[i]), b = direction(p[i], p[i + 1]);
                    events.push({ key: 'marker-mid', point: p[i], angle: Math.atan2(a[1] + b[1], a[0] + b[0]), start: false });
                }
            const last = contour.closed ? p[0] : p.at(-1)!, before = contour.closed ? p.at(-1)! : p.at(-2)!;
            events.push({ key: 'marker-end', point: last, angle: Math.atan2(last[1] - before[1], last[0] - before[0]), start: false });
            for (const event of events) {
                const id = refId(style[event.key] ?? style.marker);
                if (!id)
                    continue;
                const marker = this.resolve(id, ctx);
                if (marker.localName !== 'marker')
                    throw new Error('marker reference must identify a marker');
                const stack = new Set([...ctx.stack, marker]), w = length(marker.getAttribute('markerWidth') ?? '3', ctx.width), h = length(marker.getAttribute('markerHeight') ?? '3', ctx.height);
                if (w <= 0 || h <= 0)
                    continue;
                const vb = marker.getAttribute('viewBox'), box = vb ? numbers(vb) : [0, 0, w, h], viewport = vb ? viewBoxMatrix(box, w, h, marker.getAttribute('preserveAspectRatio') ?? undefined) : identity(), refX = length(marker.getAttribute('refX') ?? '0', box[2]), refY = length(marker.getAttribute('refY') ?? '0', box[3]), refPoint = transformPoint(viewport, [refX, refY]);
                const orient = marker.getAttribute('orient') ?? '0';
                let angle = orient.startsWith('auto') ? event.angle : Number(orient.replace(/deg$/, '')) * Math.PI / 180;
                if (orient === 'auto-start-reverse' && event.start)
                    angle += Math.PI;
                const scale = marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : node.strokeStyle.width, c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
                const matrix = multiply([c, s, -s, c, event.point[0], event.point[1]], multiply([1, 0, 0, 1, -refPoint[0], -refPoint[1]], viewport));
                const markerStyle = this.style(marker, defaults);
                const children = Array.from(marker.children).flatMap(e => {
                    const n = this.node(e, markerStyle, {
                        ...ctx, width: box[2], height: box[3], stack, scope: multiply(ctx.scope ?? identity(), matrix), contextScope: ctx.scope ?? identity(), contextFill: node.fill, contextStroke: node.stroke
                    });
                    return n ? [n] : [];
                });
                const instance = this.group(children, matrix);
                if (markerStyle.overflow !== 'visible') {
                    const clip = this.group([], inverse(viewport) ?? identity());
                    clip.path = parsePath(`M0 0h${w}v${h}h${-w}Z`);
                    clip.fill = { kind: 'solid', color: [1, 1, 1, 1] };
                    instance.clip = [clip];
                }
                (node.markers ??= []).push(instance);
            }
        }
    }
    private filterPrimitive(e: Element): FilterPrimitive {
        const attributes = Object.fromEntries(Array.from(e.attributes).map(a => [a.name, a.value]));
        const style = this.style(e, this.style(e.parentElement!, defaults));
        for (const key of ['flood-color', 'flood-opacity', 'color-interpolation-filters', 'lighting-color'])
            if (style[key])
                attributes[key] = style[key];
        return { type: e.localName, attributes, children: Array.from(e.children).filter(child => /^fe(?:MergeNode|Func[RGBA]|DistantLight|PointLight|SpotLight)$/.test(child.localName)).map(e => this.filterPrimitive(e)) };
    }
    private shape(e: Element, a: (key: string, fallback?: number, axis?: string) => number, style: Style): string | undefined {
        const name = e.localName;
        if (name === 'path') {
            const d = style.d ?? e.getAttribute('d') ?? '';
            return d === 'none' ? '' : d.replace(/^path\(\s*["']([\s\S]*)["']\s*\)$/, '$1');
        }
        if (name === 'line')
            return `M${a('x1')} ${a('y1', 0, 'y')}L${a('x2')} ${a('y2', 0, 'y')}`;
        if (name === 'polyline' || name === 'polygon') {
            const pts = numbers(e.getAttribute('points') ?? '');
            if (pts.length % 2)
                throw new Error('SVG points must contain coordinate pairs');
            return pts.length ? `M${pts.join(' ')}${name === 'polygon' ? 'Z' : ''}` : '';
        }
        if (name === 'circle' || name === 'ellipse') {
            const x = a('cx'), y = a('cy', 0, 'y'), rx = name === 'circle' ? a('r', 0, 'diagonal') : a('rx'), ry = name === 'circle' ? rx : a('ry', 0, 'y');
            if (rx < 0 || ry < 0)
                throw new Error('Negative SVG radius');
            return !rx || !ry ? '' : `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
        }
        if (name === 'rect') {
            const x = a('x'), y = a('y', 0, 'y'), w = a('width'), h = a('height', 0, 'y');
            if (w < 0 || h < 0)
                throw new Error('Negative SVG rect size');
            if (!w || !h)
                return '';
            const rx = Math.min(w / 2, a('rx', e.hasAttribute('ry') ? a('ry', 0, 'y') : 0)), ry = Math.min(h / 2, a('ry', rx, 'y'));
            if (rx < 0 || ry < 0)
                throw new Error('Negative SVG corner radius');
            if (!rx || !ry)
                return `M${x} ${y}h${w}v${h}h${-w}Z`;
            return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
        }
        return undefined;
    }
    private paint(value: string, style: Style, ctx: Context, box: Bounds, alpha: number): Paint | undefined {
        if (value === 'context-fill' || value === 'context-stroke') {
            const paint = value === 'context-fill' ? ctx.contextFill : ctx.contextStroke;
            if (!paint)
                return undefined;
            if (paint.kind === 'solid')
                return { ...paint, color: [paint.color[0], paint.color[1], paint.color[2], paint.color[3] * alpha] };
            const matrix = multiply(inverse(ctx.scope ?? identity()) ?? identity(), multiply(ctx.contextScope ?? identity(), paint.matrix));
            return paint.kind === 'pattern' ? { ...paint, matrix, alpha: paint.alpha * alpha } : { ...paint, matrix, stops: paint.stops.map(stop => ({ ...stop, color: [stop.color[0], stop.color[1], stop.color[2], stop.color[3] * alpha] })) };
        }
        if (value === 'none')
            return undefined;
        if (value === 'currentColor')
            value = style.color;
        const id = refId(value);
        if (!id)
            return { kind: 'solid', color: color(value, alpha) };
        const e = this.resolve(id, ctx), stack = new Set([...ctx.stack, e]), next = { ...ctx, stack };
        if (e.localName === 'pattern') {
            const chain: Element[] = [];
            let current: Element | undefined = e;
            const seen = new Set<Element>();
            while (current) {
                if (seen.has(current))
                    throw new Error('Circular SVG pattern inheritance');
                seen.add(current);
                chain.push(current);
                const href: string | null = current.getAttribute('href') ?? current.getAttribute('xlink:href');
                current = href?.startsWith('#') ? this.resolve(href.slice(1), ctx) : undefined;
            }
            const attr = (key: string, fallback: string) => chain.map(e => e.getAttribute(key)).find(v => v !== null) ?? fallback;
            const relative = attr('patternUnits', 'objectBoundingBox') !== 'userSpaceOnUse', w = length(attr('width', '0'), relative ? 1 : ctx.width), h = length(attr('height', '0'), relative ? 1 : ctx.height), width = w * (relative ? box.width : 1), height = h * (relative ? box.height : 1);
            if (width <= 0 || height <= 0)
                return undefined;
            const x = length(attr('x', '0'), relative ? 1 : ctx.width) * (relative ? box.width : 1) + (relative ? box.x : 0), y = length(attr('y', '0'), relative ? 1 : ctx.height) * (relative ? box.height : 1) + (relative ? box.y : 0);
            const vb = attr('viewBox', '');
            let content = identity();
            if (vb)
                content = viewBoxMatrix(numbers(vb), width, height, attr('preserveAspectRatio', 'xMidYMid meet'));
            else if (attr('patternContentUnits', 'userSpaceOnUse') === 'objectBoundingBox')
                content = [box.width, 0, 0, box.height, 0, 0];
            const contentElement = chain.find(e => Array.from(e.children).some(c => drawable.has(c.localName))) ?? e;
            const scene = Array.from(contentElement.children).flatMap(child => {
                const n = this.node(child, this.style(e, defaults), next);
                return n ? [n] : [];
            });
            return {
                kind: 'pattern', width, height, alpha, matrix: multiply(parseTransform(attr('patternTransform', '')), [1, 0, 0, 1, x, y]), scene: [this.group(scene, content)]
            };
        }
        if (e.localName !== 'linearGradient' && e.localName !== 'radialGradient')
            throw new Error(`Invalid SVG paint server #${id}`);
        const chain: Element[] = [];
        let current: Element | undefined = e;
        const seen = new Set<Element>();
        while (current) {
            if (seen.has(current))
                throw new Error('Circular SVG gradient inheritance');
            seen.add(current);
            chain.push(current);
            const href: string | null = current.getAttribute('href') ?? current.getAttribute('xlink:href');
            current = href?.startsWith('#') ? this.resolve(href.slice(1), ctx) : undefined;
        }
        const attr = (key: string, fallback: string) => chain.map(e => e.getAttribute(key)).find(v => v !== null) ?? fallback;
        const relative = attr('gradientUnits', 'objectBoundingBox') !== 'userSpaceOnUse';
        if (relative && (!box.width || !box.height))
            return undefined;
        const len = (key: string, fallback: string, axis = 'x') => length(attr(key, fallback), relative ? 1 : axis === 'x' ? ctx.width : axis === 'y' ? ctx.height : Math.hypot(ctx.width, ctx.height) / Math.SQRT2, ctx.fontSize);
        let stops: Element[] = [];
        for (const item of chain) {
            stops = Array.from(item.children).filter(e => e.localName === 'stop');
            if (stops.length)
                break;
        }
        let last = 0;
        const gradientStops = stops.map(stop => {
            const s = this.style(stop, this.style(e, style));
            last = Math.max(last, Math.max(0, Math.min(1, length(stop.getAttribute('offset') ?? '0', 1))));
            return { offset: last, color: color((s['stop-color'] ?? 'black') === 'currentColor' ? s.color : s['stop-color'] ?? 'black', opacity(s['stop-opacity']) * alpha) };
        });
        if (!gradientStops.length)
            return undefined;
        const matrix = multiply(relative ? [box.width, 0, 0, box.height, box.x, box.y] : identity(), parseTransform(attr('gradientTransform', '')));
        const radial = e.localName === 'radialGradient', cx = len('cx', '50%'), cy = len('cy', '50%', 'y');
        return {
            kind: radial ? 'radial' : 'linear', matrix, coordinates: radial ? [cx, cy, len('r', '50%', 'diagonal'), len('fx', attr('cx', '50%')), len('fy', attr('cy', '50%'), 'y'), len('fr', '0', 'diagonal')] : [len('x1', '0%'), len('y1', '0%', 'y'), len('x2', '100%'), len('y2', '0%', 'y')], stops: gradientStops, spread: attr('spreadMethod', 'pad') as 'pad', linearRGB: style['color-interpolation'] === 'linearRGB'
        };
    }
    private fontStyle(font: TextFont, style: Style): TextFont {
        const axes = font.font.face.getAxisInfos();
        if (!Object.keys(axes).length)
            return font;
        const values: Record<string, number> = {};
        if (axes.wght)
            values.wght = style['font-weight'] === 'bold' ? 700 : style['font-weight'] === 'normal' ? 400 : Number(style['font-weight']);
        if (axes.ital)
            values.ital = style['font-style'] === 'italic' ? 1 : 0;
        if (axes.slnt)
            values.slnt = style['font-style'].startsWith('oblique') ? parseFloat(style['font-style'].slice(7)) || -14 : 0;
        if (axes.wdth)
            values.wdth = ({
                'ultra-condensed': 50, 'extra-condensed': 62.5, condensed: 75, 'semi-condensed': 87.5, normal: 100, 'semi-expanded': 112.5, expanded: 125, 'extra-expanded': 150, 'ultra-expanded': 200
            } as Record<string, number>)[style['font-stretch']] ?? parseFloat(style['font-stretch']);
        if (axes.opsz && style['font-optical-sizing'] !== 'none')
            values.opsz = Number(style['font-size']);
        if (style['font-variation-settings'] !== 'normal')
            for (const part of style['font-variation-settings'].split(',')) {
                const match = /["']([\w]{4})["']\s*([+-]?(?:\d*\.\d+|\d+\.?\d*))/.exec(part);
                if (!match)
                    throw new Error('Invalid font-variation-settings');
                if (axes[match[1]])
                    values[match[1]] = Number(match[2]);
            }
        for (const [tag, value] of Object.entries(values)) {
            if (!Number.isFinite(value))
                throw new Error('Invalid variable font axis');
            values[tag] = Math.max(axes[tag].min, Math.min(axes[tag].max, value));
        }
        const key = JSON.stringify(values);
        let cache = this.styledFonts.get(font);
        if (!cache) {
            cache = new Map();
            this.styledFonts.set(font, cache);
        }
        let result = cache.get(key);
        if (!result) {
            result = font.withVariations(values);
            cache.set(key, result);
            if (cache.size > 64)
                cache.delete(cache.keys().next().value!);
        }
        return result;
    }
    private text(element: Element, style: Style, ctx: Context): VectorNode[] {
        return layoutSvgText(element, style, ctx, {
            style: (element, parent) => this.style(element, parent),
            fonts: (style) => {
                const families = style['font-family'].split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase()), fonts: TextFont[] = [];
                for (const family of families) {
                    const rawWeight = style['font-weight'], weight = rawWeight === 'bold' ? '700' : rawWeight === 'normal' ? '400' : rawWeight, italic = style['font-style'];
                    let font = this.fontFaces.get(`${family}:${weight}:${italic}`) ?? this.fontFaces.get(`${family}:${weight}`) ?? this.fontFaces.get(family);
                    if (!font) {
                        let score = Infinity;
                        for (const [key, candidate] of this.fontFaces) {
                            if (!key.startsWith(family + ':'))
                                continue;
                            const [range, faceStyle = 'normal'] = key.slice(family.length + 1).split(':'), weights = range.trim().split(/\s+/).map(Number), requested = Number(weight), lo = weights[0], hi = weights[1] ?? lo;
                            const distance = (faceStyle === italic ? 0 : 10000) + Math.abs(requested - Math.max(lo, Math.min(hi, requested)));
                            if (Number.isFinite(distance) && distance < score) {
                                score = distance;
                                font = candidate;
                            }
                        }
                    }
                    if (font && !fonts.includes(font))
                        fonts.push(font);
                }
                if (this.font && !fonts.includes(this.font))
                    fonts.push(this.font);
                for (const font of this.fontFaces.values())
                    if (!fonts.includes(font))
                        fonts.push(font);
                return fonts.map(font => this.fontStyle(font, style));
            },
            reference: id => this.resolve(id, ctx),
            paint: (value, style, size, box, alpha, scope) => this.paint(value, style, { ...ctx, fontSize: size, scope: multiply(ctx.scope ?? identity(), scope) }, box, alpha),
            decorate: (element, node, style, size, scope) => this.applyEffects(element, node, style, { ...ctx, fontSize: size, scope: multiply(ctx.scope ?? identity(), scope), stack: new Set([...ctx.stack, element]) })
        });
    }
}

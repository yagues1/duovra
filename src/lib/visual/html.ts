import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import type { VisualDocument } from './types';
import { LOCAL_FRAGMENT, RASTER_DATA, safeVisualCss } from './staticCss';
import { tr } from '../../i18n';

type Parent = DefaultTreeAdapterTypes.ParentNode;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const discard = new Set([
  'script', 'iframe', 'frame', 'frameset', 'fencedframe', 'object', 'embed', 'applet', 'portal',
  'meta', 'base', 'link', 'template', 'animate', 'animatetransform', 'animatemotion', 'set', 'discard', 'foreignobject',
]);
const attributes = new Set([
  'action', 'formaction', 'target', 'formtarget', 'background', 'ping', 'src', 'srcset', 'imagesrcset',
  'srcdoc', 'poster', 'data', 'codebase', 'archive', 'manifest', 'download', 'autofocus', 'base',
]);
const svgCssAttributes = new Set([
  'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor',
]);
const policy = [
  "default-src 'none'", "script-src 'none'", "connect-src 'none'", "style-src 'unsafe-inline'", 'img-src data:',
  "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'",
].join('; ');
const safeHead = parse('<!doctype html><html><head>' +
  '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>html{color-scheme:dark;background:#181b24;color:#eef0f6}' +
  '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}</style>' +
  '</head><body></body></html>');
const trustedHead = safeHead.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => 'tagName' in node && node.tagName === 'html')!
  .childNodes.find((node): node is DefaultTreeAdapterTypes.Element => 'tagName' in node && node.tagName === 'head')!.childNodes;

/** Analiza y sanea en memoria. Ningún elemento del original entra en el DOM de Duovra. */
export function htmlDocument(source: string): VisualDocument {
  const tree = parse(source, { scriptingEnabled: false });
  const stack: { node: Parent; depth: number }[] = [{ node: tree, depth: 0 }];
  let count = 0;
  let scripts = false;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 60) throw new Error(tr('El documento HTML supera 60 niveles de anidación.'));
    node.childNodes = node.childNodes.filter((child) => {
      if (!('tagName' in child)) return child.nodeName === '#text' || child.nodeName === '#documentType';
      if (++count > 4_000) throw new Error(tr('El documento HTML supera el límite de 4.000 elementos.'));
      const tag = child.tagName.toLowerCase();
      if (tag === 'script') scripts = true;
      if (discard.has(tag) || (child.namespaceURI !== HTML_NS && child.namespaceURI !== SVG_NS)) return false;
      if (tag === 'style' && child.childNodes.some((part) => part.nodeName === '#text' &&
        'value' in part && !safeVisualCss(part.value, true))) return false;
      child.attrs = child.attrs.filter(({ name, value }) => {
        const lower = name.toLowerCase();
        if (lower.startsWith('on') || (lower === 'href' && /^\s*javascript:/i.test(value))) {
          scripts = true;
          return false;
        }
        if (lower === 'href') return child.namespaceURI === SVG_NS && tag !== 'a' && LOCAL_FRAGMENT.test(value);
        if (lower === 'style' || (child.namespaceURI === SVG_NS && svgCssAttributes.has(lower))) return safeVisualCss(value, true);
        return !attributes.has(lower) || (lower === 'src' && tag === 'img' && RASTER_DATA.test(value));
      });
      stack.push({ node: child, depth: depth + 1 });
      return true;
    });
    if ('tagName' in node && node.tagName === 'head') node.childNodes.unshift(...trustedHead);
  }
  const srcDoc = serialize(tree);
  return { type: 'document', srcDoc: srcDoc.startsWith('<!DOCTYPE') ? srcDoc : '<!doctype html>' + srcDoc, scripts };
}

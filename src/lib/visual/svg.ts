import type { VisualImage } from './types';
import { LOCAL_FRAGMENT, safeVisualCss } from './staticCss';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'animatetransform', 'animatemotion', 'set', 'discard']);
const dimension = (value: number): number | null => Number.isFinite(value) && value > 0 ? value : null;
function pixels(value: string | null): number | null {
  return value && /^(?:\d+\.?\d*|\.\d+)(?:px)?$/i.test(value.trim()) ? dimension(parseFloat(value)) : null;
}

/** El XML se procesa fuera del documento y se entrega como imagen estática. */
export function svgImage(source: string): VisualImage {
  if (/<!DOCTYPE/i.test(source)) throw new Error('La vista SVG admite documentos sin DTD.');
  // El mismo espacio de nombres que HTML asigna a un <svg> escrito sin xmlns.
  const input = source.replace(/^\uFEFF?\s*<\?xml\b[^?]*\?>/, '');
  const xml = new DOMParser().parseFromString('<root xmlns="' + SVG_NS + '">' + input + '</root>', 'image/svg+xml');
  const root = xml.documentElement.firstElementChild;
  if (!root || xml.documentElement.childElementCount !== 1) throw new Error('Se esperaba un único elemento raíz SVG.');
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS || xml.getElementsByTagName('parsererror').length) {
    throw new Error('SVG inválido. Comprueba el elemento raíz, los atributos y el cierre de las etiquetas.');
  }
  const elements = Array.from(root.querySelectorAll('*'));
  if (elements.length > 5_000) throw new Error('El SVG supera el límite de 5.000 elementos.');
  for (const node of [root, ...elements]) {
    const name = node.localName.toLowerCase();
    if (node.namespaceURI !== SVG_NS || BLOCKED.has(name) || (name === 'style' && !safeVisualCss(node.textContent ?? ''))) {
      node.remove();
      continue;
    }
    for (const attr of Array.from(node.attributes)) {
      const key = attr.localName.toLowerCase();
      if (key.startsWith('on') || key === 'base' || key === 'target' || key === 'src' ||
        (key === 'href' && (name === 'a' || !LOCAL_FRAGMENT.test(attr.value))) ||
        (key !== 'xmlns' && !safeVisualCss(attr.value))) node.removeAttributeNode(attr);
    }
  }
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = pixels(root.getAttribute('width')) ?? (box?.length === 4 ? dimension(box[2]) : null);
  const height = pixels(root.getAttribute('height')) ?? (box?.length === 4 ? dimension(box[3]) : null);
  const svg = new XMLSerializer().serializeToString(root);
  if (svg.length > 1_500_000) throw new Error('La imagen SVG supera el tamaño de representación permitido.');
  return { type: 'image', src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width, height };
}

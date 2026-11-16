import { useEffect, type RefObject } from 'react';

/**
 * Refracción de los cristales flotantes (menús, popovers, selectores y diálogos).
 *
 * Flotan sobre el texto de la interfaz, no sobre el fondo, así que el shader no puede dibujarlos
 * (no ve el DOM). Se usa un filtro SVG de desplazamiento aplicado como `backdrop-filter: url(#…)`
 * (Chromium/WebView2), la técnica de kube.io, nordify/css-liquid-glass y liquid-glass-react.
 *
 * Diferencia con esas implementaciones: ellas cargan el mapa de desplazamiento como imagen
 * (`feImage`). En Edge 157 un `feImage` dentro de `backdrop-filter` no se aplica (verificado:
 * el mapa llega vacío y el fondo solo se traslada en bloque). Aquí el mapa se construye con
 * primitivas, sin imágenes:
 *
 * 1. Mapa de alturas: un rectángulo (`feFlood`) metido medio bisel hacia dentro y desenfocado:
 *    0 fuera, 1 en la placa y una rampa suave en el canto (las esquinas quedan redondeadas).
 * 2. Normales: el gradiente de esa altura con dos núcleos Sobel (`feConvolveMatrix`), que van al
 *    canal rojo (x) y verde (y) con 0,5 como reposo.
 * 3. Desplazamiento: el fondo, ligeramente desenfocado, se desplaza en la dirección de la normal
 *    (hacia fuera: el canto comprime lo que hay detrás, como el shader del fondo). El azul se
 *    desplaza un 12 % más: aberración cromática solo donde hay curvatura, con dos pasadas.
 *
 * Coste: el filtro solo trabaja mientras el flotante está abierto. Los filtros se crean una vez
 * por tamaño y se reutilizan (caché LRU).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_FILTERS = 24;
const filters = new Map<string, string>();
let defs: SVGDefsElement | null = null;
let seq = 0;

function host() {
  if (defs) return defs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.pointerEvents = 'none';
  defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

const SOBEL_X = '1 0 -1 2 0 -2 1 0 -1';
const SOBEL_Y = '1 2 1 0 0 0 -1 -2 -1';

/** Primitivas del filtro de refracción para un tamaño (ver el comentario del módulo). */
export function lensFilterMarkup(w: number, h: number, bevel: number, frost: number) {
  const inset = bevel * 0.55;
  const sigma = Math.max(2, bevel * 0.38);
  // Desplazamiento máximo ≈ 0,55 · bisel, como el shader del fondo.
  const scale = bevel * 1.25;
  return (
    `<feFlood flood-color="#fff" x="${inset.toFixed(1)}" y="${inset.toFixed(1)}" width="${Math.max(1, w - 2 * inset).toFixed(1)}" height="${Math.max(1, h - 2 * inset).toFixed(1)}" result="plate"/>` +
    `<feGaussianBlur in="plate" stdDeviation="${sigma.toFixed(2)}" result="hb"/>` +
    `<feColorMatrix in="hb" type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 0 1" result="h"/>` +
    `<feConvolveMatrix in="h" order="3" kernelMatrix="${SOBEL_X}" divisor="1" bias="0.5" preserveAlpha="true" edgeMode="duplicate" result="gx"/>` +
    `<feConvolveMatrix in="h" order="3" kernelMatrix="${SOBEL_Y}" divisor="1" bias="0.5" preserveAlpha="true" edgeMode="duplicate" result="gy"/>` +
    `<feColorMatrix in="gx" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="rx"/>` +
    `<feColorMatrix in="gy" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1" result="ry"/>` +
    `<feComposite in="rx" in2="ry" operator="arithmetic" k2="1" k3="1" result="map"/>` +
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${frost}" result="b"/>` +
    // Un desplazamiento para la imagen y otro, algo mayor, solo para el canal azul: dispersión
    // en el canto con dos pasadas en lugar de tres (medido: con el fondo animado detrás, tres
    // pasadas por fotograma provocaban fotogramas largos con el menú abierto).
    `<feDisplacementMap in="b" in2="map" scale="${scale.toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
    `<feDisplacementMap in="b" in2="map" scale="${(scale * 1.12).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="d2"/>` +
    `<feColorMatrix in="d2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bl"/>` +
    `<feColorMatrix in="d" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rg"/>` +
    `<feBlend in="rg" in2="bl" mode="screen"/>`
  );
}

/** Id de un filtro SVG de refracción para un tamaño (se crea una vez y se reutiliza). */
export function lensFilter(w: number, h: number, bevel: number, frost: number) {
  w = Math.max(8, Math.round(w));
  h = Math.max(8, Math.round(h));
  const key = `${w}x${h}b${bevel}f${frost}`;
  const hit = filters.get(key);
  if (hit) {
    filters.delete(key);
    filters.set(key, hit);
    return hit;
  }
  const id = `lg-float-${++seq}`;
  const f = document.createElementNS(SVG_NS, 'filter');
  f.id = id;
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', String(w));
  f.setAttribute('height', String(h));
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('primitiveUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.innerHTML = lensFilterMarkup(w, h, bevel, frost);
  host().appendChild(f);
  filters.set(key, id);
  if (filters.size > MAX_FILTERS) {
    const [oldKey, oldId] = filters.entries().next().value as [string, string];
    filters.delete(oldKey);
    document.getElementById(oldId)?.remove();
  }
  return id;
}

/**
 * Aplica la refracción SVG a un flotante mientras esté montado (y mientras haya óptica: ni
 * intensidad reducida ni transparencia reducida). Se recalcula al cambiar de tamaño.
 */
export function useFloatLens(ref: RefObject<HTMLElement | null>, opts: { bevel?: number; frost?: number; enabled?: boolean } = {}) {
  const { bevel = 16, frost = 6, enabled = true } = opts;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      if (document.documentElement.dataset.optics !== 'on') {
        el.style.removeProperty('--float-lens');
        delete el.dataset.lens;
        return;
      }
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 16 || h < 16) return;
      const id = lensFilter(w, h, Math.min(bevel, Math.min(w, h) / 3), frost);
      el.style.setProperty('--float-lens', `url(#${id})`);
      el.dataset.lens = '';
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.style.removeProperty('--float-lens');
      delete el.dataset.lens;
    };
  }, [ref, bevel, frost, enabled]);
}

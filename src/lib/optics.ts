import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * Óptica compartida entre la aurora (WebGL) y el cristal (CSS).
 *
 * 1. Lentes: las superficies de cristal premium (barra lateral, panel contextual, Ajustes) se
 *    registran aquí. La aurora lee sus rectángulos al dibujar y curva el fondo en sus cantos, como
 *    lo haría el borde grueso de una lámina de vidrio. Sin filtros SVG: es el propio shader del
 *    fondo, así que no añade pasadas de composición.
 * 2. Luz ambiental: la aurora muestrea pocos píxeles cerca de cada superficie `[data-env]` unas
 *    tres veces por segundo y escribe `--env` (tono) y `--env-a` (fuerza) en ese elemento. Los
 *    reflejos y cáusticas del cristal se tiñen con esa luz. Sin renders de React.
 */

export const MAX_LENSES = 4;
const lenses = new Set<HTMLElement>();
/** Radio de cada lente: constante, se lee una vez (evita getComputedStyle en cada fotograma). */
const radius = new WeakMap<HTMLElement, number>();
let listener: (() => void) | null = null;

export function onLensesChange(cb: (() => void) | null) {
  listener = cb;
}

/*
 * Rectángulos en caché: se actualizan en el callback de ResizeObserver (con el layout ya
 * resuelto) y al cambiar el tamaño de la ventana, nunca desde el bucle de la aurora. Leerlos en
 * cada fotograma forzaba un layout síncrono durante las animaciones de la barra y del panel.
 */
const rectCache = new Map<HTMLElement, [number, number, number, number]>();
const measureLens = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  rectCache.set(el, [r.left, r.top, r.width, r.height]);
};
const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
  for (const e of entries) if (lenses.has(e.target as HTMLElement)) measureLens(e.target as HTMLElement);
  listener?.();
});
const remeasureAll = () => {
  lenses.forEach(measureLens);
  listener?.();
};
if (typeof window !== 'undefined') window.addEventListener('resize', remeasureAll);
function addLens(el: HTMLElement) {
  lenses.add(el);
  measureLens(el);
  ro?.observe(el);
  // La posición puede asentarse tras la animación de entrada (sin cambio de tamaño).
  window.setTimeout(() => lenses.has(el) && remeasureAll(), 520);
  listener?.();
}
function removeLens(el: HTMLElement) {
  lenses.delete(el);
  rectCache.delete(el);
  ro?.unobserve(el);
  listener?.();
}

/** Rectángulos de las lentes en píxeles CSS: [x, y, w, h] y radio, hasta MAX_LENSES. */
export function readLenses(rects: Float32Array, radii: Float32Array) {
  rects.fill(0);
  radii.fill(0);
  let i = 0;
  for (const el of lenses) {
    if (i >= MAX_LENSES) break;
    const r = rectCache.get(el);
    if (!r || r[2] < 8 || r[3] < 8) continue;
    rects.set(r, i * 4);
    let rad = radius.get(el);
    if (rad === undefined) {
      rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      radius.set(el, rad);
    }
    radii[i] = rad;
    i++;
  }
  return i;
}

/** Registra un elemento como lente del fondo mientras esté montado y `enabled` sea cierto. */
export function useLens(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    addLens(el);
    return () => removeLens(el);
  }, [ref, enabled]);
}

/** Puntos de muestreo (px CSS) para la luz ambiental de un elemento: canto inferior y lateral. */
export function envPoints(el: Element): [number, number][] | null {
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return [
    [r.left + r.width * 0.5, r.bottom - Math.min(24, r.height * 0.2)],
    [r.left + Math.min(20, r.width * 0.15), r.top + r.height * 0.45],
    [r.right - Math.min(20, r.width * 0.15), r.top + r.height * 0.7],
  ];
}

const smooth = new WeakMap<HTMLElement, number[]>();

/**
 * Convierte colores muestreados (0–255) en la luz ambiental del elemento: tono normalizado y
 * pastel en `--env`, intensidad 0–1 en `--env-a`. Suavizado exponencial entre muestras.
 */
export function applyEnv(el: HTMLElement, samples: number[][]) {
  let r = 0, g = 0, b = 0;
  for (const s of samples) {
    r += s[0];
    g += s[1];
    b += s[2];
  }
  const n = samples.length || 1;
  r /= n;
  g /= n;
  b /= n;
  const peak = Math.max(r, g, b, 1);
  // Fuerza: el fondo base ronda 10–30; las cortinas superan 60–120.
  const strength = Math.min(1, Math.max(0, (peak - 22) / 90));
  const hue = [r / peak, g / peak, b / peak].map((c) => 255 * (0.35 + 0.65 * c));
  const target = [...hue, strength];
  const prev = smooth.get(el) ?? target;
  const next = prev.map((v, i) => v + (target[i] - v) * 0.35);
  smooth.set(el, next);
  el.style.setProperty('--env', `${next[0].toFixed(0)} ${next[1].toFixed(0)} ${next[2].toFixed(0)}`);
  el.style.setProperty('--env-a', next[3].toFixed(3));
}

/**
 * Ref (callback) de una superficie de cristal premium: la registra como lente del fondo mientras
 * esté montada. Sirve también para elementos que aparecen y desaparecen (panel, cajón).
 */
export function useOpticalSurface<T extends HTMLElement>() {
  const current = useRef<T | null>(null);
  // Motion puede llamar al ref con null al desmontar en lugar de usar la limpieza de React 19:
  // se cubren ambos caminos.
  return useCallback((el: T | null) => {
    if (current.current && current.current !== el) {
      removeLens(current.current);
      current.current = null;
    }
    if (!el) return;
    current.current = el;
    addLens(el);
    return () => {
      removeLens(el);
      if (current.current === el) current.current = null;
    };
  }, []);
}

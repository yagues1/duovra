import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { LensSource, LightSampler } from './background';

/**
 * Óptica del cristal (CSS) frente al fondo (WebGL). Solo depende del contrato de
 * src/lib/background.ts, no de un renderizador concreto.
 *
 * 1. Lentes: las superficies de cristal premium (barra lateral, panel contextual, Ajustes) se
 *    registran aquí y se ofrecen al fondo como `lensSource`. El fondo lee sus rectángulos al
 *    dibujar y curva la imagen en sus cantos, como lo haría el borde grueso de una lámina de
 *    vidrio. Sin filtros SVG: es el propio shader del fondo, así que no añade pasadas.
 * 2. Luz ambiental (`useAmbientLight`): el fondo muestrea pocos píxeles cerca de cada superficie
 *    `[data-env]` unas tres veces por segundo y se escribe `--env` (tono) y `--env-a` (fuerza) en
 *    ese elemento. Los reflejos y cáusticas del cristal se tiñen con esa luz. Sin renders de React.
 */

export const MAX_LENSES = 4;
const lenses = new Set<HTMLElement>();
/** Radio de cada lente: constante, se lee una vez (evita getComputedStyle en cada fotograma). */
const radius = new WeakMap<HTMLElement, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((cb) => cb());

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
  notify();
});
const remeasureAll = () => {
  lenses.forEach(measureLens);
  notify();
};
if (typeof window !== 'undefined') window.addEventListener('resize', remeasureAll);
function addLens(el: HTMLElement) {
  lenses.add(el);
  measureLens(el);
  ro?.observe(el);
  // La posición puede asentarse tras la animación de entrada (sin cambio de tamaño).
  window.setTimeout(() => lenses.has(el) && remeasureAll(), 520);
  notify();
}
function removeLens(el: HTMLElement) {
  lenses.delete(el);
  rectCache.delete(el);
  ro?.unobserve(el);
  notify();
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

/** Lentes registradas, en la forma que consume cualquier renderizador del fondo. */
export const lensSource: LensSource = {
  max: MAX_LENSES,
  read: readLenses,
  subscribe(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

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

/**
 * Luz ambiental del cristal: muestreo periódico del fondo cerca de cada `[data-env]` mientras se
 * mueve; con un fondo estático basta con muestrear al cambiar su aspecto (`key`) o la ventana.
 */
export function useAmbientLight(sampler: RefObject<LightSampler | null>, animated: boolean, key: string) {
  useEffect(() => {
    const source = sampler.current;
    if (!source) return;
    const tick = () => {
      if (document.hidden) return;
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-env]'));
      const pts: [number, number][] = [];
      const owners: [HTMLElement, number, number][] = [];
      for (const el of els) {
        const p = envPoints(el);
        if (!p) continue;
        owners.push([el, pts.length, p.length]);
        pts.push(...p);
      }
      if (!pts.length) return;
      source.sample(pts, (rgb) => owners.forEach(([el, i, n]) => applyEnv(el, rgb.slice(i, i + n))));
    };
    const first = window.setTimeout(tick, 120);
    const every = window.setInterval(tick, animated ? 340 : 2000);
    window.addEventListener('resize', tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
      window.removeEventListener('resize', tick);
    };
  }, [sampler, animated, key]);
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
  // `--env` y `--env-a` se heredan: cada escritura recalcula el estilo de todo el subárbol de la
  // superficie (la barra lateral entera, el compositor…). Solo se escribe si el valor cambia de
  // verdad. `--env-a` se redondea a centésimas: su mayor multiplicador en CSS es 0.3, así que un
  // paso de 0.005 mueve la opacidad del reflejo < 0.0015 (por debajo de 1/255, imperceptible).
  const env = `${next[0].toFixed(0)} ${next[1].toFixed(0)} ${next[2].toFixed(0)}`;
  const envA = next[3].toFixed(2);
  const last = written.get(el);
  if (last?.[0] === env && last[1] === envA) return;
  written.set(el, [env, envA]);
  if (last?.[0] !== env) el.style.setProperty('--env', env);
  if (last?.[1] !== envA) el.style.setProperty('--env-a', envA);
}
const written = new WeakMap<HTMLElement, [string, string]>();

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

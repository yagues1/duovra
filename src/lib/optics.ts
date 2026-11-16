import { useEffect, type RefObject } from 'react';
import type { LightSampler, ReadingSource } from './background';

/**
 * Enlaces entre el fondo y la interfaz que no son el cristal en sí (el cristal vive en
 * src/lib/glass/: registro de superficies y óptica en el shader del fondo).
 *
 * 1. Luz ambiental (`useAmbientLight`): el fondo muestrea pocos píxeles cerca de cada superficie
 *    `[data-env]` y se escribe `--env` (tono) y `--env-a` (fuerza) en ese elemento. Los anillos
 *    CSS del cristal y de los controles se tiñen con esa luz. Sin renders de React.
 * 2. Columna de lectura (`useReadingSurface`): el fondo se calma detrás del texto.
 */

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
const written = new WeakMap<HTMLElement, [string, string]>();

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
  // `--env` y `--env-a` se heredan: cada escritura recalcula el estilo de todo el subárbol. Solo
  // se escribe si el valor cambia de verdad (a centésimas: por debajo de 1/255 en la opacidad).
  const env = `${next[0].toFixed(0)} ${next[1].toFixed(0)} ${next[2].toFixed(0)}`;
  const envA = next[3].toFixed(2);
  const last = written.get(el);
  if (last?.[0] === env && last[1] === envA) return;
  written.set(el, [env, envA]);
  if (last?.[0] !== env) el.style.setProperty('--env', env);
  if (last?.[1] !== envA) el.style.setProperty('--env-a', envA);
}

/*
 * Columna de lectura: el área de desplazamiento (alto) y la columna del texto (ancho). El fondo
 * se calma detrás. Rectángulo en caché, actualizado por ResizeObserver y al redimensionar.
 */
let readingEls: { scroller: HTMLElement; column: HTMLElement } | null = null;
let readingRect: [number, number, number, number] | null = null;
const readingListeners = new Set<() => void>();
const measureReading = () => {
  if (!readingEls) {
    readingRect = null;
  } else {
    const s = readingEls.scroller.getBoundingClientRect();
    const c = readingEls.column.getBoundingClientRect();
    readingRect = s.height > 8 && c.width > 8 ? [c.left, s.top, c.width, s.height] : null;
  }
  readingListeners.forEach((cb) => cb());
};
const readingRo = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureReading);
if (typeof window !== 'undefined') window.addEventListener('resize', measureReading);

export const readingSource: ReadingSource = {
  read: () => readingRect,
  subscribe(cb) {
    readingListeners.add(cb);
    return () => {
      readingListeners.delete(cb);
    };
  },
};

/** Registra la columna de lectura de la conversación mientras esté montada. */
export function useReadingSurface(scroller: RefObject<HTMLElement | null>, column: RefObject<HTMLElement | null>, key?: unknown) {
  useEffect(() => {
    const s = scroller.current;
    const c = column.current;
    if (!s || !c) return;
    readingEls = { scroller: s, column: c };
    readingRo?.observe(s);
    readingRo?.observe(c);
    measureReading();
    // La vista entra con una animación de desplazamiento: se vuelve a medir al asentarse.
    const t = window.setTimeout(measureReading, 420);
    return () => {
      window.clearTimeout(t);
      readingRo?.unobserve(s);
      readingRo?.unobserve(c);
      if (readingEls?.scroller === s) readingEls = null;
      measureReading();
    };
  }, [scroller, column, key]);
}

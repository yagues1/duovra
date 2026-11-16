import { useCallback, useRef } from 'react';
import type { GlassSource } from '../background';

/**
 * Registro de superficies Liquid Glass ópticas (0.5.1).
 *
 * Una superficie registrada aquí deja de dibujar su cristal en CSS: es el shader del fondo
 * (Dot Matrix Flow o Aurora) quien la dibuja, como único responsable óptico. Así la refracción,
 * el volumen, los reflejos y la sombra se calculan una sola vez y con el contenido real que hay
 * detrás (los puntos o la aurora), sin backdrop-filter ni filtros SVG que recomponer.
 *
 * Tipos (cada uno con su bisel y su densidad, ver GLASS_GLSL en ./shader.ts):
 * - `panel`     Barra lateral, panel contextual, Ajustes: cristal premium, bisel ancho.
 * - `composer`  Compositor: premium, algo más denso en el centro (ahí se escribe).
 * - `control`   Botones y cápsulas grandes (Nueva conversación, cápsula de proyecto).
 * - `pill`      Selecciones que se desplazan (agente, pestañas): se estiran al moverse.
 *
 * Geometría sin layouts síncronos innecesarios:
 * - Los rectángulos se guardan en caché y se actualizan con ResizeObserver y al redimensionar.
 * - Las animaciones que mueven una superficie sin cambiar su tamaño (Motion escribe `style`
 *   en el elemento o en un antecesor) se detectan con un MutationObserver filtrado: solo
 *   cuentan las mutaciones del propio elemento o de un antecesor suyo. Mientras dura el
 *   movimiento (`tracking()`), el renderizador vuelve a medir en cada fotograma, ya con el
 *   layout resuelto, y calcula la velocidad de cada superficie (estiramiento líquido).
 */

export type GlassKind = 'panel' | 'composer' | 'control' | 'pill';

export const GLASS_KIND: Record<GlassKind, { code: number; bevel: number; order: number }> = {
  panel: { code: 0, bevel: 26, order: 0 },
  composer: { code: 1, bevel: 22, order: 1 },
  control: { code: 2, bevel: 11, order: 2 },
  pill: { code: 3, bevel: 10, order: 3 },
};

export const MAX_SURFACES = 12;
/** Tiempo que se sigue midiendo tras la última señal de movimiento (ms). */
const TRACK_MS = 420;

interface Entry {
  el: HTMLElement;
  kind: GlassKind;
  rect: [number, number, number, number];
  radius: number;
  opacity: number;
  vx: number;
  vy: number;
  cx: number;
  cy: number;
  t: number;
}

const entries = new Map<HTMLElement, Entry>();
let ordered: Entry[] = [];
const listeners = new Set<() => void>();
let trackUntil = 0;

const notify = () => listeners.forEach((cb) => cb());
const sortEntries = () => {
  ordered = [...entries.values()].sort((a, b) => GLASS_KIND[a.kind].order - GLASS_KIND[b.kind].order);
};

/** Opacidad efectiva del elemento (incluye antecesores animados por Motion). */
function effectiveOpacity(el: HTMLElement) {
  let o = 1;
  for (let n: HTMLElement | null = el, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
    const v = parseFloat(getComputedStyle(n).opacity);
    if (Number.isFinite(v)) o *= v;
    if (o < 0.01) break;
  }
  return o;
}

function measure(e: Entry, now: number, withOpacity: boolean) {
  const r = e.el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dt = Math.max(1, now - e.t);
  if (e.t > 0 && dt < 120) {
    // Velocidad suavizada (px/s): estira el material de las cápsulas en la dirección del movimiento.
    const k = 0.45;
    e.vx += ((cx - e.cx) / dt * 1000 - e.vx) * k;
    e.vy += ((cy - e.cy) / dt * 1000 - e.vy) * k;
  } else {
    e.vx = 0;
    e.vy = 0;
  }
  e.cx = cx;
  e.cy = cy;
  e.t = now;
  e.rect = [r.left, r.top, r.width, r.height];
  if (withOpacity) e.opacity = effectiveOpacity(e.el);
}

/** Empieza (o prolonga) el seguimiento por fotograma de la geometría. */
export function trackGlass(ms = TRACK_MS) {
  const until = performance.now() + ms;
  const wasIdle = trackUntil < performance.now();
  trackUntil = Math.max(trackUntil, until);
  if (wasIdle) notify();
}

const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((list) => {
  const now = performance.now();
  for (const r of list) {
    const e = entries.get(r.target as HTMLElement);
    if (e) measure(e, now, false);
  }
  trackGlass(160);
  notify();
});

/** Mutaciones de estilo que pueden mover una superficie: del propio elemento o de un antecesor. */
const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
  if (!entries.size) return;
  for (const rec of records) {
    const t = rec.target as Node;
    for (const e of ordered) {
      if (t === e.el || t.contains(e.el)) {
        trackGlass();
        return;
      }
    }
  }
});

let observing = false;
function startObserving() {
  if (observing || !mo || typeof document === 'undefined') return;
  observing = true;
  mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-state'], subtree: true });
  const onTransition = (ev: Event) => {
    const t = ev.target as Node;
    for (const e of ordered) if (t === e.el || (t as Node).contains?.(e.el)) return trackGlass(ev.type === 'transitionend' ? 120 : 700);
  };
  document.addEventListener('transitionrun', onTransition, true);
  document.addEventListener('transitionend', onTransition, true);
  document.addEventListener('animationstart', onTransition, true);
  window.addEventListener('resize', () => {
    const now = performance.now();
    entries.forEach((e) => measure(e, now, false));
    trackGlass(200);
    notify();
  });
  // Un desplazamiento solo cuenta si mueve una superficie (p. ej. dentro de Ajustes): el chat se
  // desplaza constantemente durante el streaming y no contiene ninguna.
  document.addEventListener('scroll', (ev) => {
    const t = ev.target;
    if (t instanceof Node && ordered.some((e) => t.contains(e.el))) trackGlass(140);
  }, { capture: true, passive: true });
}

function add(el: HTMLElement, kind: GlassKind) {
  startObserving();
  const e: Entry = { el, kind, rect: [0, 0, 0, 0], radius: -1, opacity: 1, vx: 0, vy: 0, cx: 0, cy: 0, t: 0 };
  entries.set(el, e);
  sortEntries();
  measure(e, performance.now(), true);
  ro?.observe(el);
  el.dataset.optic = kind;
  // Las entradas animadas se asientan sin cambiar de tamaño: se sigue un rato.
  trackGlass(700);
  notify();
}

function remove(el: HTMLElement) {
  if (!entries.delete(el)) return;
  ro?.unobserve(el);
  delete el.dataset.optic;
  sortEntries();
  notify();
}

/**
 * Escribe las superficies visibles en tres arrays vec4 (ver GLASS_GLSL):
 * - g0: x, y, ancho, alto (px CSS)
 * - g1: radio, bisel, tipo, fuerza
 * - g2: velocidad x, velocidad y (px/s), reservado, opacidad
 */
function read(g0: Float32Array, g1: Float32Array, g2: Float32Array, limit: number) {
  const now = performance.now();
  const live = now < trackUntil;
  let i = 0;
  for (const e of ordered) {
    if (i >= limit) break;
    if (live) measure(e, now, true);
    else if (e.vx || e.vy) {
      e.vx *= 0.5;
      e.vy *= 0.5;
      if (Math.abs(e.vx) + Math.abs(e.vy) < 2) e.vx = e.vy = 0;
    }
    const [x, y, w, h] = e.rect;
    if (w < 6 || h < 6 || e.opacity < 0.02) continue;
    if (e.radius < 0 || live) e.radius = parseFloat(getComputedStyle(e.el).borderTopLeftRadius) || 0;
    const k = GLASS_KIND[e.kind];
    g0.set([x, y, w, h], i * 4);
    g1.set([e.radius, Math.min(k.bevel, Math.min(w, h) * 0.5), k.code, 1], i * 4);
    g2.set([e.vx, e.vy, 0, e.opacity], i * 4);
    i++;
  }
  return i;
}

/** Fuente de superficies que consume cualquier renderizador del fondo. */
export const glassSource: GlassSource = {
  max: MAX_SURFACES,
  read,
  tracking: () => performance.now() < trackUntil || ordered.some((e) => e.vx !== 0 || e.vy !== 0),
  near(x, y, margin) {
    for (const e of ordered) {
      const [rx, ry, rw, rh] = e.rect;
      if (x > rx - margin && x < rx + rw + margin && y > ry - margin && y < ry + rh + margin) return true;
    }
    return false;
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

/** Rectángulo en caché de cada superficie (para los reflejos CSS que siguen al cursor). */
export function surfaceRects() {
  return ordered.map((e) => ({ el: e.el, rect: e.rect }));
}

/**
 * Ref (callback) de una superficie óptica: la registra mientras esté montada. Sirve también para
 * elementos de Motion que aparecen y desaparecen (Motion puede llamar al ref con null).
 */
export function useGlass<T extends HTMLElement>(kind: GlassKind, enabled = true) {
  const current = useRef<T | null>(null);
  return useCallback((el: T | null) => {
    if (current.current && current.current !== el) {
      remove(current.current);
      current.current = null;
    }
    if (!el || !enabled) return;
    current.current = el;
    add(el, kind);
    return () => {
      remove(el);
      if (current.current === el) current.current = null;
    };
  }, [kind, enabled]);
}

/**
 * Bucle único de las mascotas animadas. Las poses fijas comparten SVG y no pasan por aquí.
 * Se pausa fuera de pantalla, con la ventana sin foco y detrás de Ajustes.
 */
import type { Brain } from './brain';
import { renderStill, type Character } from './characters';

export type Motion = 'full' | 'reduced' | 'still';

export interface Live {
  brain: Brain;
  char: Character;
  visible: boolean;
  settle: number;
  rect?: DOMRect;
}

const live = new Map<Element, Live>();
const pointer = { x: 0, y: 0, inside: false };
const moving = new Map<Element, Set<string>>();
const ROOT_ATTRS = ['data-mascots', 'data-animations', 'data-intensity', 'data-field-quality', 'data-away', 'data-settings-open'];
let frame = 0;
let last = 0;
let mode: Motion = 'full';
let away = false;
let settings = false;
let intersection: IntersectionObserver | undefined;
let sizes: ResizeObserver | undefined;
let stopListening: (() => void) | undefined;

function listen() {
  const root = document.documentElement;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const { signal } = listeners;
  const invalidate = () => { for (const m of live.values()) m.rect = undefined; };
  const sync = () => {
    const d = root.dataset;
    const next = media.matches || d.mascots === 'off' || d.animations === 'off' || d.fieldQuality === '3' || d.fieldQuality === '4'
      ? 'still' : d.mascots === 'subtle' || d.intensity === 'reduced' ? 'reduced' : 'full';
    const resumed = away && !document.hidden && d.away === undefined;
    away = document.hidden || d.away !== undefined;
    settings = d.settingsOpen !== undefined;
    if (resumed || next !== mode) invalidate();
    if (mode !== next) {
      mode = next;
      for (const m of live.values()) {
        m.brain.reduced = mode !== 'full';
        m.settle = .6;
      }
    }
    if (mode === 'still' && !away) {
      for (const m of live.values()) {
        if (wants(m, true)) { renderStill(m.char, m.brain); m.settle = 0; }
      }
    }
    kick();
  };
  sync();
  const attributes = new MutationObserver(sync);
  attributes.observe(root, { attributes: true, attributeFilter: ROOT_ATTRS });
  media.addEventListener('change', sync, { signal });
  document.addEventListener('visibilitychange', sync, { signal });
  window.addEventListener('resize', invalidate, { signal });
  window.addEventListener('scroll', (event) => {
    const target = event.target;
    if (target === document) invalidate();
    else if (target instanceof Element) {
      for (const m of live.values()) if (target.contains(m.char.svg)) m.rect = undefined;
    }
  }, { signal, passive: true, capture: true });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.inside = true;
  }, { signal, passive: true });
  root.addEventListener('pointerleave', () => { pointer.inside = false; }, { signal });
  // El muelle del anfitrión desplaza el SVG aunque el puntero permanezca quieto.
  const transition = (e: TransitionEvent) => {
    const target = e.target;
    if (!(target instanceof Element) || !['transform', 'width', 'height'].includes(e.propertyName)) return;
    if (e.type === 'transitionrun') {
      if (![...live.keys()].some((svg) => target.contains(svg))) return;
      const props = moving.get(target) ?? new Set<string>();
      props.add(e.propertyName);
      moving.set(target, props);
    } else if (moving.has(target)) {
      const props = moving.get(target)!;
      props.delete(e.propertyName);
      if (!props.size) moving.delete(target);
    } else return;
    invalidate();
  };
  for (const event of ['transitionrun', 'transitionend', 'transitioncancel'] as const) {
    window.addEventListener(event, transition, { signal });
  }
  intersection = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const m = live.get(e.target);
      if (!m) continue;
      m.visible = e.isIntersecting;
      m.rect = undefined;
    }
    sync();
  }, { rootMargin: '40px' });
  sizes = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const m = live.get(target);
      if (m) m.rect = undefined;
    }
  });
  return () => {
    listeners.abort();
    attributes.disconnect();
    intersection?.disconnect();
    sizes?.disconnect();
    moving.clear();
    pointer.inside = false;
  };
}

function wants(m: Live, still = false) {
  return m.visible && !away && !(settings && m.char.svg.closest('.app-body'))
    && (mode === 'full' || (mode !== 'still' || still) && m.settle > 0);
}

function kick() {
  if (![...live.values()].some((m) => wants(m))) {
    cancelAnimationFrame(frame);
    frame = 0;
  } else if (!frame) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

function tick(now: number) {
  frame = 0;
  const dt = Math.min((now - last) / 1000, .05);
  last = now;
  const active = [...live.values()].filter((m) => wants(m));
  // Primero geometría y puntero, después escrituras SVG: sin layout forzado por personaje.
  for (const m of active) {
    if (pointer.inside && mode === 'full') {
      if (!m.rect || [...moving.keys()].some((target) => target.contains(m.char.svg))) {
        m.rect = m.char.svg.getBoundingClientRect();
      }
      const { left, top, width, height } = m.rect;
      if (width) {
        const unit = width * m.char.radius;
        const x = (pointer.x - (left + width * m.char.center[0])) / unit;
        const y = (pointer.y - (top + height * m.char.center[1])) / unit;
        m.brain.pointerAt(x, y, x * x + y * y < 1);
        continue;
      }
    }
    m.brain.pointerLeave();
  }
  for (const m of active) {
    m.char.render(m.brain.update(dt));
    if (mode !== 'full') m.settle -= dt;
  }
  if (active.length) frame = requestAnimationFrame(tick);
}

export function register(char: Character, brain: Brain): Live {
  stopListening ??= listen();
  brain.reduced = mode !== 'full';
  const m: Live = { brain, char, visible: true, settle: 0 };
  live.set(char.svg, m);
  intersection?.observe(char.svg);
  sizes?.observe(char.svg);
  renderStill(char, brain);
  kick();
  return m;
}

export function unregister(m: Live) {
  live.delete(m.char.svg);
  intersection?.unobserve(m.char.svg);
  sizes?.unobserve(m.char.svg);
  for (const target of moving.keys()) if (target.contains(m.char.svg)) moving.delete(target);
  if (!live.size) {
    stopListening?.();
    stopListening = undefined;
  }
  kick();
}

export function changed(m: Live) {
  m.settle = .6;
  if (mode === 'still' && wants(m, true)) {
    renderStill(m.char, m.brain);
    m.settle = 0;
  }
  kick();
}

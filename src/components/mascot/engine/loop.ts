/**
 * Bucle único de las mascotas 2.0.
 * - Un solo requestAnimationFrame para todas; se detiene cuando ninguna lo necesita.
 * - Respeta las preferencias de la app (atributos en <html>) y `prefers-reduced-motion`:
 *     full → animación completa · subtle/intensidad reducida → poses sin bucles (cambio directo) ·
 *     off/animaciones desactivadas/calidad baja/movimiento reducido → pose fija.
 * - Se pausa fuera de pantalla, con la ventana sin foco (`data-away`) y detrás de Ajustes.
 * - El puntero se lee una vez por fotograma; primero todas las lecturas de geometría y después las
 *   escrituras, para no forzar un recálculo de layout por mascota.
 */
import { Brain } from './brain';
import type { Character } from './characters';

export type Motion = 'full' | 'reduced' | 'still';

export interface Live {
  brain: Brain;
  char: Character;
  visible: boolean;
  /** Segundos que aún necesita para asentar la pose en modo reducido. */
  settle: number;
  /** Fija por diseño (iconos pequeños): nunca entra en el bucle. */
  fixed: boolean;
}

const live = new Set<Live>();
let frame = 0;
let last = 0;
let pointer = { x: 0, y: 0, inside: false };
let listening = false;

const ROOT_ATTRS = ['data-mascots', 'data-animations', 'data-intensity', 'data-field-quality', 'data-away', 'data-settings-open'];

export function motionMode(): Motion {
  const d = document.documentElement.dataset;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'still';
  if (d.mascots === 'off' || d.animations === 'off' || d.fieldQuality === '3' || d.fieldQuality === '4') return 'still';
  if (d.mascots === 'subtle' || d.intensity === 'reduced') return 'reduced';
  return 'full';
}

function paused(m: Live) {
  const d = document.documentElement.dataset;
  return document.hidden || d.away !== undefined || (d.settingsOpen !== undefined && !!m.char.svg.closest('.app-body'));
}

let io: IntersectionObserver | null = null;
function listen() {
  if (listening) return;
  listening = true;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) for (const m of live) if (m.char.svg === e.target) m.visible = e.isIntersecting;
    kick();
  }, { rootMargin: '40px' });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointer = { x: e.clientX, y: e.clientY, inside: true };
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.inside = false; });
  document.addEventListener('visibilitychange', kick);
  new MutationObserver(() => { applyMode(); kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ROOT_ATTRS });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { applyMode(); kick(); });
}

function applyMode() {
  const mode = motionMode();
  for (const m of live) {
    m.brain.reduced = m.fixed || mode !== 'full';
    m.settle = .6;
  }
}

function wants(m: Live, mode: Motion) {
  if (!m.visible || paused(m) || m.fixed) return false;
  return mode === 'full' || m.settle > 0;
}

export function kick() {
  if (!frame && typeof requestAnimationFrame === 'function') {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

function tick(now: number) {
  frame = 0;
  const dt = Math.min((now - last) / 1000, .05);
  last = now;
  const mode = motionMode();
  const active: Live[] = [];
  for (const m of live) if (wants(m, mode)) active.push(m);
  const rects = pointer.inside && mode === 'full' ? active.map((m) => m.char.svg.getBoundingClientRect()) : null;
  active.forEach((m, i) => {
    const r = rects?.[i];
    if (r && r.width) {
      const cx = r.left + r.width * m.char.center[0], cy = r.top + r.height * m.char.center[1];
      const unit = r.width * m.char.radius;
      const nx = (pointer.x - cx) / unit, ny = (pointer.y - cy) / unit;
      m.brain.pointerAt(nx, ny, Math.hypot(nx, ny) < 1);
    } else m.brain.pointerLeave();
    m.char.render(m.brain.update(dt));
    if (mode !== 'full') m.settle -= dt;
  });
  if (active.length) frame = requestAnimationFrame(tick);
}

/** Pose fija inmediata (sin bucle): para iconos y para el modo «sin animaciones». */
export function settleNow(m: Live) {
  const was = m.brain.reduced;
  m.brain.reduced = true;
  for (let i = 0; i < 30; i++) m.brain.update(1 / 30);
  m.char.render(m.brain.update(1 / 60));
  m.brain.reduced = was;
}

export function register(char: Character, brain: Brain, fixed: boolean): Live {
  listen();
  const mode = motionMode();
  brain.reduced = fixed || mode !== 'full';
  const m: Live = { brain, char, visible: true, settle: 0, fixed };
  live.add(m);
  if (!fixed) io?.observe(char.svg);
  settleNow(m);
  kick();
  return m;
}

export function unregister(m: Live) {
  live.delete(m);
  io?.unobserve(m.char.svg);
}

/** Cambio de estado: en modo reducido o fijo la pose se asienta sin bucles. */
export function changed(m: Live) {
  if (m.fixed || motionMode() === 'still') settleNow(m);
  else { m.settle = .6; kick(); }
}

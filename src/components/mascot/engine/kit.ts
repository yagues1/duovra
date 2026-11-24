/** Utilidades vectoriales de las mascotas 2.0. Sin dependencias. */
import type { AgentId } from '../../../lib/types';
import { AGENT_COLORS, STATES, TONES, type MascotState } from './states';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;
export const nextId = (p: string) => `${p}${++uid}`;

type Attrs = Record<string, string | number>;
export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent?.appendChild(n);
  return n;
}

export const f = (n: number) => String(Math.round(n * 100) / 100);
export const set = (n: Element, attrs: Attrs) => { for (const k in attrs) n.setAttribute(k, String(attrs[k])); };

/** Ojo cerrado sobre sí mismo: apertura, sonrisa (párpado inferior) y concentración (superior). */
export function eyePath(cx: number, cy: number, w: number, h: number, open: number, smile = 0, squint = 0, skew = 0) {
  const ht = h * Math.max(0, open) * (1 - squint * .5);
  const hb = h * Math.max(0, open) * (1 - smile * 1.55) - squint * h * .08;
  const k = 1.33;
  const l = cx - w / 2, r = cx + w / 2;
  const ty = cy - ht * k + skew, by = cy + hb * k;
  const lift = smile * h * .35;
  return `M${f(l)} ${f(cy + lift)}C${f(l)} ${f(ty)} ${f(r)} ${f(ty - skew * 2)} ${f(r)} ${f(cy + lift)}C${f(r)} ${f(by)} ${f(l)} ${f(by)} ${f(l)} ${f(cy + lift)}Z`;
}

/** Boca: curva (-1 triste … 1 sonrisa) y apertura (habla). */
export function mouthPath(cx: number, cy: number, w: number, curve: number, open = 0) {
  const l = cx - w / 2, r = cx + w / 2;
  const c = curve * w * .45;
  const o = open * w * .55;
  return `M${f(l)} ${f(cy - c * .25)}Q${f(cx)} ${f(cy + c)} ${f(r)} ${f(cy - c * .25)}Q${f(cx)} ${f(cy + c + o)} ${f(l)} ${f(cy - c * .25)}Z`;
}

/** Contorno cerrado suave (Catmull-Rom → Bézier). */
export function smoothClosed(pts: readonly (readonly [number, number])[]) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

type Stop = [offset: number, color: string, opacity?: number];
export function gradient(defs: Element, kind: 'linearGradient' | 'radialGradient', id: string, stops: Stop[], attrs: Attrs) {
  const g = el(kind, { id, ...attrs }, defs);
  for (const [o, c, op = 1] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }, g);
}

/** Color de señal del estado: el cuerpo conserva siempre el color del agente. */
export function toneOf(state: MascotState, agent: AgentId) {
  const tone = STATES[state].tone;
  return tone === 'agent' ? AGENT_COLORS[agent].main : TONES[tone];
}

const rgb = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** Transición de color con suavizado exponencial (el tono nunca cambia de golpe). */
export function toneMixer(initial: string) {
  let cur = rgb(initial);
  return (target: string, dt: number, speed = 7) => {
    const t = rgb(target), a = 1 - Math.exp(-speed * dt);
    cur = cur.map((v, i) => v + (t[i] - v) * a);
    return `rgb(${cur.map((v) => Math.round(v)).join(' ')})`;
  };
}

/** Muelle escalar para movimiento secundario dentro del personaje. */
export class Follow {
  v: number; vel = 0;
  constructor(v = 0, private k = 90, private c = 9) { this.v = v; }
  to(target: number, dt: number) {
    const n = Math.ceil(dt / (1 / 120)), h = dt / n;
    for (let i = 0; i < n; i++) { this.vel += (-this.k * (this.v - target) - this.c * this.vel) * h; this.v += this.vel * h; }
    return this.v;
  }
}

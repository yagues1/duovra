/**
 * Mascotas 2.0 · Living Entities (propuesta C elegida en el laboratorio de 1.0.7).
 *  · Aura (Claude Code): gota cálida de contorno vivo, luz interior que sigue la mirada, una chispa
 *    suelta que flota sobre la cabeza y motas que orbitan solo con actividad real.
 *  · Flujo (Codex): superelipse de vidrio frío que se cuadra al trabajar, con giroscopio interior,
 *    ondas de señal y una banda de lectura.
 * El contorno se recalcula por fotograma (32 vértices, Catmull-Rom). Por debajo de 44 px se retiran
 * los detalles finos y los ojos crecen para seguir siendo legibles.
 */
import type { AgentId } from '../../../lib/types';
import { Brain, type Frame } from './brain';
import { AGENT_COLORS, type MascotState } from './states';
import { el, set, f, eyePath, mouthPath, smoothClosed, gradient, toneOf, toneMixer, Follow, nextId } from './kit';

export interface Character {
  svg: SVGSVGElement;
  render(p: Frame): void;
  setLOD(px: number): void;
  /** Centro y radio relativos al SVG, para medir el acercamiento del puntero. */
  center: readonly [number, number];
  radius: number;
}

const N = 32;
type Pt = [number, number];

function root(agent: AgentId) {
  const svg = el('svg', { viewBox: '0 0 120 120', class: 'm2', 'data-agent': agent, overflow: 'visible', 'aria-hidden': 'true', focusable: 'false' });
  return svg;
}

function createAura(): Character {
  const agent = 'claude', c = AGENT_COLORS.claude, id = nextId('m2a');
  const svg = root(agent);
  const defs = el('defs', {}, svg);
  gradient(defs, 'radialGradient', id + 'b', [[0, '#ffd9bd'], [.35, c.light], [.75, c.main], [1, c.deep]], { cx: .4, cy: .35, r: .75 });
  gradient(defs, 'radialGradient', id + 'c', [[0, '#fff3e6', .75], [1, '#fff3e6', 0]], {});
  gradient(defs, 'radialGradient', id + 's', [[0, '#ffffff', .7], [1, '#ffffff', 0]], {});
  gradient(defs, 'linearGradient', id + 'd', [[0, '#000', 0], [.6, '#000', 0], [1, '#3a1a0e', .45]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  const U = (n: string) => `url(#${id}${n})`;

  const shadow = el('ellipse', { cx: 60, cy: 109, rx: 24, ry: 3.4, fill: '#000', opacity: .5 }, svg);
  const ring = el('path', { fill: 'none', 'stroke-width': 1.6, opacity: 0, class: 'm2-detail' }, svg);
  const body = el('path', { fill: U('b') }, svg);
  const shade = el('path', { fill: U('d') }, svg);
  const rim = el('path', { fill: 'none', stroke: '#fff4ea', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: .55, class: 'm2-detail' }, svg);
  const core = el('ellipse', { rx: 15, ry: 12, fill: U('c') }, svg);
  const spec = el('ellipse', { rx: 9, ry: 4.5, fill: U('s'), opacity: .55, class: 'm2-detail' }, svg);
  const eyeL = el('path', { fill: '#2a1610' }, svg), eyeR = el('path', { fill: '#2a1610' }, svg);
  const glints = [0, 1].map(() => el('circle', { r: 1.2, fill: '#fff', class: 'm2-detail' }, svg));
  const cheeks = [0, 1].map(() => el('ellipse', { rx: 3.4, ry: 2, fill: c.deep, opacity: 0, class: 'm2-detail' }, svg));
  const mouth = el('path', { fill: '#2a1610', stroke: '#2a1610', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  const motes = [0, 1, 2].map(() => el('circle', { r: 2 }, svg));
  const spark = el('path', {}, svg), sparkCore = el('circle', { fill: '#fff8f0' }, svg);
  const front = new WeakMap<Element, boolean>();

  const mix = toneMixer(c.main);
  const F = { lean: new Follow(0, 50, 7), amp: new Follow(1, 20, 8), mote: new Follow(0, 20, 8), sx: new Follow(0, 38, 7.5), sy: new Follow(0, 38, 7.5) };
  let first = true, lastT = 0, lod = 120;

  function render(p: Frame) {
    const dt = Math.min(.05, Math.max(.001, p.t - lastT)); lastT = p.t;
    const tone = mix(toneOf(p.state, agent), dt);
    const { state: st, t, work } = p;
    const amp = F.amp.to(p.sleeping ? .5 : 1 + work * .8 + (st === 'error' ? .5 : 0), dt);
    const lean = F.lean.to(p.x * .9 + p.near * p.gx * 4, dt);
    const cx = 60 + p.x * .6, cy = 70 + p.y, R = 31;
    const sx = 1 + p.sx, sy = 1 + p.sy;
    const rot = (p.rot + p.tilt * .35) * Math.PI / 180;
    const pts: Pt[] = [], mem: Pt[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const wob = Math.sin(a * 2 + t * .9) * .028 + Math.sin(a * 3 - t * 1.3 + 1) * .022 * amp + Math.sin(a * 5 + t * 2.1) * .01 * amp;
      const r = R * (1 + wob);
      let x = Math.cos(a) * r * sx, y = Math.sin(a) * r * sy;
      if (y < 0) { x += lean * (-y / R) * .45; y *= 1.03; } else { x *= 1 + (y / R) * .08; y = Math.min(y, 106 - cy); }
      const xr = x * Math.cos(rot) - y * Math.sin(rot), yr = x * Math.sin(rot) + y * Math.cos(rot);
      pts.push([cx + xr, cy + yr]);
      const od = Math.hypot(xr, yr) || 1, off = 3.6 + Math.sin(a * 4 - t * 1.6) * .6;
      mem.push([cx + xr + xr / od * off, cy + yr + yr / od * off]);
    }
    const d = smoothClosed(pts);
    body.setAttribute('d', d); shade.setAttribute('d', d);
    // El anillo solo existe como señal: permiso pendiente o error.
    set(ring, { d: smoothClosed(mem), stroke: tone, opacity: f(st === 'permission' ? .35 + p.alertPulse * .55 : st === 'error' ? .7 : 0) });
    rim.setAttribute('d', 'M' + pts.slice(Math.round(N * .52), Math.round(N * .74)).map((q) => `${f(q[0] + 1.2)} ${f(q[1] + 1.2)}`).join('L'));
    shadow.setAttribute('rx', f(25 * sx - p.y * .4));

    // Chispa suelta sobre la cabeza, con inercia propia.
    const top = pts[(N * 3) / 4];
    let gx = top[0] + p.gx * 5, gy = top[1] - 14 - p.glow * 2 + Math.sin(t * 1.6) * 1.6, size = 3.9, op = .95;
    if (st === 'thinking' || st === 'preparing') { gx += Math.cos(t * 1.9) * 11; gy += Math.sin(t * 1.9) * 3 - 2; }
    else if (st === 'reading' || st === 'command' || st === 'editing' || st === 'streaming') { gx += 17; gy += 6 + Math.sin(t * 3.2) * 1.2; }
    else if (st === 'permission') { gy -= 4; size = 4.4 + p.alertPulse * 1.6; }
    else if (st === 'done') { gy -= Math.sin(Math.min(1, p.lt / 1.1) * Math.PI) * 10; size = 4.6; }
    else if (st === 'error' || st === 'cancelled') { gx += 15; gy = top[1] + 8; size = 3.2; op = .45; }
    if (p.sleeping) { gy = top[1] - 2.5; size = 3; op = .4; }
    if (first) { first = false; F.sx.v = gx; F.sy.v = gy; }
    const kx = F.sx.to(gx, dt), ky = F.sy.to(gy, dt);
    const k = size * (lod < 44 ? 1.4 : 1), q = k * .28;
    set(spark, {
      d: `M0 ${f(-k)}Q${f(q)} ${f(-q)} ${f(k)} 0Q${f(q)} ${f(q)} 0 ${f(k)}Q${f(-q)} ${f(q)} ${f(-k)} 0Q${f(-q)} ${f(-q)} 0 ${f(-k)}Z`,
      transform: `translate(${f(kx)} ${f(ky)}) rotate(${f((t * 35 + F.sx.vel * 1.2) % 360)})`, fill: tone, opacity: f(op),
    });
    set(sparkCore, { cx: f(kx), cy: f(ky), r: f(k * .3), opacity: f(op * .9) });

    set(core, { cx: f(cx + lean * .35 + p.gx * 8), cy: f(cy - 6 + p.gy * 6), opacity: f(.25 + p.glow * .55) });
    set(spec, { cx: f(cx - 11 + lean * .6), cy: f(cy - 22), transform: `rotate(-24 ${f(cx - 11)} ${f(cy - 22)})` });

    const ex = p.gx * 7, ey = p.gy * 5.5, tiltX = p.tilt * .25;
    const big = lod < 44 ? 1.3 : lod < 80 ? 1.14 : 1;
    const eyX = cx + lean * .45 + ex, eyY = cy - 6 + ey;
    eyeL.setAttribute('d', eyePath(eyX - 10 - tiltX * .2, eyY + tiltX * .3, 7.4 * big, 8.6 * big, p.open, p.smile, p.squint, p.browIn * 1.3 - p.brow * .6));
    eyeR.setAttribute('d', eyePath(eyX + 10 - tiltX * .2, eyY - tiltX * .3, 7.4 * big, 8.6 * big, p.open, p.smile, p.squint, -p.browIn * 1.3 - p.brow * .6));
    const gl = p.open > .5 && p.smile < .5 ? .85 : 0;
    set(glints[0], { cx: f(eyX - 8.6), cy: f(eyY - 3.6), opacity: gl });
    set(glints[1], { cx: f(eyX + 11.4), cy: f(eyY - 3.6), opacity: gl });
    set(cheeks[0], { cx: f(eyX - 15), cy: f(eyY + 8), opacity: f(p.smile * .45) });
    set(cheeks[1], { cx: f(eyX + 15), cy: f(eyY + 8), opacity: f(p.smile * .45) });
    mouth.setAttribute('d', mouthPath(eyX - ex * .4, eyY + 11, 5 + p.mouthW * 6, p.mouth, p.mouthOpen));

    // Motas: solo con actividad real; pasan por delante a la altura del vientre, nunca sobre los ojos.
    const on = F.mote.to(st === 'thinking' || st === 'preparing' ? 1 : st === 'permission' ? 0 : work > .3 ? .7 : st === 'done' ? .9 : 0, dt);
    motes.forEach((m, i) => {
      const a = t * (st === 'command' ? 2.4 : st === 'thinking' ? .9 : 1.4) + i * 2.094;
      const isFront = Math.sin(a) > 0;
      set(m, {
        cx: f(cx + Math.cos(a) * (40 + i * 3) * (st === 'done' ? 1 + p.lt * .4 : 1)),
        cy: f(cy + 2 + Math.sin(a) * (14 + i * 2) - (st === 'thinking' && !isFront ? 10 : 0)),
        r: f((isFront ? 2.3 : 1.5) * (lod < 44 ? 1.3 : 1)), fill: tone,
        opacity: f(on * (isFront ? .9 : .4) * (st === 'done' ? Math.max(0, 1 - p.lt / 1.6) : 1)),
      });
      if (front.get(m) !== isFront) { front.set(m, isFront); if (isFront) svg.insertBefore(m, spark); else svg.insertBefore(m, ring); }
    });
  }

  return { svg, render, setLOD: (px) => { lod = px; svg.classList.toggle('m2-small', px < 44); }, center: [.5, .58], radius: .34 };
}

function createFlujo(): Character {
  const agent = 'codex', c = AGENT_COLORS.codex, id = nextId('m2f');
  const svg = root(agent);
  const defs = el('defs', {}, svg);
  gradient(defs, 'radialGradient', id + 'b', [[0, '#d6f6f8'], [.3, c.light], [.72, c.main], [1, '#2f7f92']], { cx: .38, cy: .32, r: .8 });
  gradient(defs, 'linearGradient', id + 'd', [[0, '#000', 0], [.55, '#000', 0], [1, '#062a33', .5]], { x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient(defs, 'radialGradient', id + 'c', [[0, '#f2feff', .8], [1, '#f2feff', 0]], {});
  const U = (n: string) => `url(#${id}${n})`;

  const shadow = el('ellipse', { cx: 60, cy: 109, rx: 24, ry: 3.4, fill: '#000', opacity: .5 }, svg);
  const halo = el('path', { fill: 'none', 'stroke-width': 1.4, opacity: 0, class: 'm2-detail' }, svg);
  const ringBack = el('path', { fill: 'none', 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: .35 }, svg);
  const body = el('path', { fill: U('b') }, svg);
  const shade = el('path', { fill: U('d') }, svg);
  const core = el('ellipse', { rx: 14, ry: 10, fill: U('c') }, svg);
  const ripple = el('path', { fill: 'none', 'stroke-width': 1, opacity: 0, class: 'm2-detail' }, svg);
  const clip = el('path', {}, el('clipPath', { id: id + 'k' }, defs));
  const scan = el('rect', { x: 20, width: 80, height: 5, rx: 2.5, fill: '#f2feff', opacity: 0, 'clip-path': U('k') }, svg);
  const spec = el('path', { fill: 'none', stroke: '#fff', 'stroke-width': 2.2, 'stroke-linecap': 'round', opacity: .5, class: 'm2-detail' }, svg);
  const eyeL = el('path', { fill: '#0a2730' }, svg), eyeR = el('path', { fill: '#0a2730' }, svg);
  const glints = [0, 1].map(() => el('rect', { width: 1.6, height: 2.6, rx: .8, fill: '#fff', class: 'm2-detail' }, svg));
  const mouth = el('path', { fill: '#0a2730', stroke: '#0a2730', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  const ringFront = el('path', { fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round' }, svg);
  const node = el('circle', { r: 2.4 }, svg);

  const mix = toneMixer(c.main);
  const F = { n: new Follow(3, 40, 10), ring: new Follow(0, 30, 9), wave: new Follow(0, 30, 9) };
  let lastT = 0, lod = 120, ringA = 0;

  function render(p: Frame) {
    const dt = Math.min(.05, Math.max(.001, p.t - lastT)); lastT = p.t;
    const tone = mix(toneOf(p.state, agent), dt);
    const { state: st, t, work } = p;
    // Exactitud: más cuadrada al trabajar, más redonda al celebrar o dormir.
    const n = F.n.to(p.sleeping ? 2.3 : st === 'done' ? 2.4 : st === 'error' ? 2.8 : 3.1 + work * .9, dt);
    const wave = F.wave.to(work > .3 ? 1 : st === 'permission' ? .5 : 0, dt);
    const cx = 60 + p.x * .5, cy = 70 + p.y;
    const A = 31 * (1 + p.sx), B = 28.5 * (1 + p.sy);
    const rot = (p.rot + p.tilt * .3) * Math.PI / 180;
    const pts: Pt[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      let x = A * Math.sign(ca) * Math.abs(ca) ** (2 / n);
      let y = B * Math.sign(sa) * Math.abs(sa) ** (2 / n);
      const w = Math.sin(a * 6 - t * (st === 'command' ? 9 : 5)) * .025 * wave + Math.sin(a * 2 + t * 1.1) * .012;
      x *= 1 + w; y = Math.min(y * (1 + w), 106 - cy);
      pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    const d = smoothClosed(pts);
    body.setAttribute('d', d); shade.setAttribute('d', d); clip.setAttribute('d', d);
    shadow.setAttribute('rx', f(25 * (1 + p.sx) - p.y * .4));
    const ph = (t * 1.2) % 1;
    set(ripple, { d, stroke: tone, opacity: f(wave * .35 * (1 - ph)), transform: `translate(${f(cx)} ${f(cy)}) scale(${f(.72 + ph * .2)}) translate(${f(-cx)} ${f(-cy)})` });
    const line = (t * .9) % 1;
    set(scan, { y: f(cy - B + line * B * 2 - 2.5), opacity: f(st === 'reading' ? .35 * Math.sin(line * Math.PI) : 0) });
    set(halo, { d, stroke: tone, opacity: f(st === 'permission' ? .35 + p.alertPulse * .55 : st === 'error' ? .7 : 0), transform: `translate(${f(cx)} ${f(cy)}) scale(1.12) translate(${f(-cx)} ${f(-cy)})` });
    set(core, { cx: f(cx + p.gx * 8), cy: f(cy - 4 + p.gy * 5), opacity: f(.2 + p.glow * .5) });
    spec.setAttribute('d', `M${f(cx - A * .62)} ${f(cy - B * .35)}Q${f(cx - A * .55)} ${f(cy - B * .78)} ${f(cx - A * .12)} ${f(cy - B * .86)}`);

    // Giroscopio: rápido en comandos, quieto y casi vertical mientras espera permiso.
    ringA += dt * (p.sleeping ? .15 : st === 'command' ? 3.2 : work > .3 ? 1.6 : st === 'permission' ? 0 : .5);
    const up = F.ring.to(st === 'permission' ? 1 : 0, dt);
    const rx = 42, ry = 9 + up * 6;
    const arc = (from: number, to: number) => Array.from({ length: 21 }, (_, i) => {
      const a = from + (to - from) * i / 20;
      return `${i ? 'L' : 'M'}${f(cx + Math.cos(a) * rx)} ${f(cy - 2 + Math.sin(a) * ry)}`;
    }).join('');
    const tr = `rotate(${f(-14 + p.tilt * .5 - up * 14)} ${f(cx)} ${f(cy - 2)})`;
    set(ringBack, { d: arc(Math.PI, Math.PI * 2), transform: tr, stroke: tone });
    set(ringFront, { d: arc(0, Math.PI), transform: tr, stroke: tone, opacity: f(.35 + p.glow * .5) });
    const na = ringA * 2.4;
    set(node, { cx: f(cx + Math.cos(na) * rx), cy: f(cy - 2 + Math.sin(na) * ry), transform: tr, fill: tone, opacity: Math.sin(na) > 0 ? .95 : .3 });

    const ex = p.gx * 7.5, ey = p.gy * 5;
    const big = lod < 44 ? 1.3 : lod < 80 ? 1.14 : 1;
    const eyX = cx + ex, eyY = cy - 6 + ey;
    eyeL.setAttribute('d', eyePath(eyX - 9.5, eyY, 6 * big, 9.6 * big, p.open, p.smile, p.squint, p.browIn * 1.5 - p.brow * .7));
    eyeR.setAttribute('d', eyePath(eyX + 9.5, eyY, 6 * big, 9.6 * big, p.open, p.smile, p.squint, -p.browIn * 1.5 - p.brow * .7));
    const gl = p.open > .5 && p.smile < .5 ? .85 : 0;
    set(glints[0], { x: f(eyX - 10.6), y: f(eyY - 5.5), opacity: gl });
    set(glints[1], { x: f(eyX + 8.4), y: f(eyY - 5.5), opacity: gl });
    mouth.setAttribute('d', mouthPath(eyX - ex * .4, eyY + 11.5, 4.5 + p.mouthW * 6, p.mouth, p.mouthOpen));
  }

  return { svg, render, setLOD: (px) => { lod = px; svg.classList.toggle('m2-small', px < 44); }, center: [.5, .58], radius: .34 };
}

export function createCharacter(agent: AgentId): Character {
  return agent === 'claude' ? createAura() : createFlujo();
}

export function renderStill(char: Character, brain: Brain) {
  const was = brain.reduced;
  brain.reduced = true;
  for (let i = 0; i < 30; i++) brain.update(1 / 30);
  char.render(brain.update(1 / 60));
  brain.reduced = was;
}

const poses = new Map<string, string>();
let definitions: SVGDefsElement | undefined;

/** Cada variante fija conserva los mismos trazos y gradientes y comparte una definición SVG. */
export function fixedCharacter(agent: AgentId, state: MascotState, size: number) {
  const lod = size < 44 ? 30 : size < 80 ? 62 : 120;
  const key = `${agent}:${state}:${lod}`;
  let pose = poses.get(key);
  if (!pose) {
    if (!definitions) {
      const sheet = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
      sheet.style.position = 'absolute';
      document.body.appendChild(sheet);
      definitions = el('defs', {}, sheet);
    }
    pose = nextId('mascot-pose');
    const char = createCharacter(agent);
    const brain = new Brain(agent, { autoSleep: false });
    brain.setState(state, true);
    char.setLOD(lod);
    renderStill(char, brain);
    if (lod < 44) char.svg.querySelectorAll('.m2-detail').forEach((node) => node.remove());
    const drawing = el('g', { id: pose }, definitions);
    drawing.append(...char.svg.childNodes);
    poses.set(key, pose);
  }
  const svg = root(agent);
  el('use', { href: '#' + pose }, svg);
  return svg;
}

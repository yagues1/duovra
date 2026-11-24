/**
 * Mascotas 2.0 — cerebro procedural.
 *
 * Calcula una pose numérica por fotograma SIN tocar el DOM; el personaje solo la pinta. Capas
 * aditivas, por eso ninguna interrumpe a otra:
 *  1. Pose del estado dominante con muelles (anticipación y continuidad).
 *  2. Capa ambiental (respiración, balanceo, mirar alrededor) con peso propio que se funde.
 *  3. Capa de trabajo del estado (barrido al leer, pulsación al editar, sílabas en streaming…).
 *  4. Reacciones puntuales con anticipación (clic, despertar, éxito, error…).
 *  5. Mirada con sacádicos y microsacádicos. 6. Parpadeo estocástico.
 * Ideas de técnica de procedural-bot-animations y react-live-avatar (MIT); código propio.
 */
import { NEUTRAL, POSES, STATES, type MascotState, type Pose } from './states';
import type { AgentId } from '../../../lib/types';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const anticipate = (k: number, a = .22) => (k < a ? -Math.sin((k / a) * Math.PI) * .35 : Math.sin(((k - a) / (1 - a)) * Math.PI) * (1 - ((k - a) / (1 - a)) * .3));
const bump = (k: number) => Math.sin(clamp(k, 0, 1) * Math.PI);
const decay = (k: number, f = 3) => Math.exp(-k * f);

type Personality = {
  k: number; c: number; gazeK: number; gazeC: number; breath: number; breathAmp: number; sway: number;
  tilt: number; wander: number; blink: [number, number]; double: number; saccade: [number, number];
};

/** Misma familia de movimiento, temperamentos distintos. */
const PERSONALITY: Record<AgentId, Personality> = {
  // Curiosidad: muelles blandos, mirada errante, inclinación de cabeza.
  claude: { k: 115, c: 15, gazeK: 300, gazeC: 19, breath: 3.9, breathAmp: 1, sway: 1.25, tilt: 1.3, wander: 1.35, blink: [2.4, 5.6], double: .22, saccade: [.7, 2.2] },
  // Precisión: muelles firmes, sacádicos rápidos, mirada «a rejilla».
  codex: { k: 210, c: 25, gazeK: 520, gazeC: 30, breath: 3.2, breathAmp: .75, sway: .55, tilt: .7, wander: .8, blink: [3, 6.4], double: .1, saccade: [.45, 1.5] },
};

class Spring {
  v: number; vel = 0; t: number;
  constructor(v: number) { this.v = v; this.t = v; }
  step(dt: number, k: number, c: number) {
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.vel += (-k * (this.v - this.t) - c * this.vel) * h;
      this.v += this.vel * h;
    }
    return this.v;
  }
}

type Partial2 = Partial<Pose>;
type Reaction = { dur: number; fn: (k: number) => Partial2 };

const REACTIONS = {
  click: { dur: .62, fn: (k) => { const a = anticipate(k, .25); return { sy: a * .13, sx: -a * .08, y: -a * 5, smile: bump(k) * .8, open: bump(k) * .1, glow: bump(k) * .3, spread: Math.max(0, a) * .35 }; } },
  ack: { dur: .5, fn: (k) => ({ open: bump(k) * .12, brow: bump(k) * .15 }) },
  wake: { dur: 1.5, fn: (k) => {
    const lids = k < .25 ? -1 + k / .25 * .55 : k < .38 ? -.45 - (k - .25) / .13 * .4 : k < .62 ? -.85 + (k - .38) / .24 * .85 : 0;
    const stretch = bump(clamp((k - .3) / .45, 0, 1));
    const shake = k > .62 ? Math.sin((k - .62) * 40) * decay(k - .62, 6) * 4 : 0;
    return { open: lids, sy: stretch * .1, sx: -stretch * .05, y: -stretch * 3, rot: shake, tilt: shake * 1.5, brow: stretch * .5, spread: stretch * .5 };
  } },
  sent: { dur: .65, fn: (k) => { const a = anticipate(k, .3); return { y: -a * 4, sy: a * .07, gy: -bump(k) * .4, spread: bump(k) * .5, glow: bump(k) * .4 }; } },
  done: { dur: 1.1, fn: (k) => {
    const hop = k < .18 ? -Math.sin(k / .18 * Math.PI) * .4 : k < .62 ? Math.sin((k - .18) / .44 * Math.PI) : -Math.sin((k - .62) / .38 * Math.PI) * .18;
    return { y: -hop * 7, sy: hop * .09 - (k < .18 ? .04 * bump(k / .18) : 0), sx: -hop * .05, rot: Math.sin(k * Math.PI * 2) * 3 * (1 - k), spread: Math.max(0, hop) * .6, glow: bump(k) * .3 };
  } },
  error: { dur: 1.05, fn: (k) => {
    const recoil = k < .2 ? bump(k / .2) : 0;
    const shake = k > .15 ? Math.sin((k - .15) * 46) * decay(k - .15, 4.5) * 3.2 : 0;
    return { y: recoil * 2.5, sy: -recoil * .07, sx: recoil * .05, x: shake, rot: shake * .8, open: recoil * .25, spread: recoil * .4 };
  } },
  alert: { dur: .7, fn: (k) => { const a = anticipate(k, .25); return { y: -a * 4.5, sy: a * .08, open: bump(k) * .25, brow: bump(k) * .4, spread: bump(k) * .45 }; } },
  cancel: { dur: .9, fn: (k) => { const s = bump(clamp(k / .5, 0, 1)); return { sy: -s * .06, sx: s * .04, y: s * 2.4, open: -s * .2 }; } },
  select: { dur: .8, fn: (k) => { const a = anticipate(k, .25); return { y: -a * 4, sy: a * .08, sx: -a * .04, rot: Math.sin(k * Math.PI * 2) * 2.5 * (1 - k), spread: bump(k) * .6, smile: bump(k) * .4 }; } },
  shift: { dur: .32, fn: (k) => ({ y: bump(k) * 1.1, sy: -bump(k) * .025, sx: bump(k) * .015 }) },
  nod: { dur: .28, fn: (k) => ({ tilt: bump(k) * 2.5, y: bump(k) * .8, gy: bump(k) * .12 }) },
} satisfies Record<string, Reaction>;

export type ReactionName = keyof typeof REACTIONS;

const ENTRY: Partial<Record<MascotState, ReactionName>> = { sent: 'sent', done: 'done', error: 'error', permission: 'alert', cancelled: 'cancel', selected: 'select' };

export type Frame = Pose & {
  t: number; lt: number; blink: number; work: number; near: number; over: number;
  breath: number; headLag: number; alertPulse: number; state: MascotState; sleeping: boolean;
};

export class Brain {
  readonly agent: AgentId;
  private p: Personality;
  reduced: boolean;
  autoSleep: boolean;
  sleepAfter: number;
  state: MascotState = 'idle';
  private stateSince = 0;
  private t = rand(0, 10);
  private seed = Math.random() * 100;
  private springs = Object.fromEntries(Object.entries(NEUTRAL).map(([k, v]) => [k, new Spring(v)])) as Record<keyof Pose, Spring>;
  private idleW = new Spring(1);
  private workW = new Spring(0);
  private gaze = { x: new Spring(0), y: new Spring(0) };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccade = 0;
  private wander = { x: 0, y: 0 };
  private micro = { x: 0, y: 0 };
  private blinkState = { next: rand(1, 3), start: -1, double: false };
  private reactions: { name: ReactionName; start: number; dur: number }[] = [];
  private pointer = { x: 0, y: 0, active: false, over: false, lastMove: -99 };
  private near = new Spring(0);
  private over = new Spring(0);
  private lastInteraction: number;
  readonly out: Frame;

  constructor(agent: AgentId, opts: { reduced?: boolean; autoSleep?: boolean; sleepAfter?: number } = {}) {
    this.agent = agent;
    this.p = PERSONALITY[agent];
    this.reduced = !!opts.reduced;
    this.autoSleep = opts.autoSleep ?? true;
    this.sleepAfter = opts.sleepAfter ?? 60;
    this.lastInteraction = this.t;
    this.out = { ...NEUTRAL, t: 0, lt: 0, blink: 0, work: 0, near: 0, over: 0, breath: 0, headLag: 0, alertPulse: 0, state: 'idle', sleeping: false };
  }

  get def() { return STATES[this.state]; }

  setState(next: MascotState, silent = false) {
    if (next === this.state) return;
    const was = this.state;
    this.state = next;
    this.stateSince = this.t;
    if (silent) return;
    if (was === 'sleep') this.react('wake');
    else this.react(ENTRY[next] ?? 'shift');
    if (next !== 'sleep') this.lastInteraction = this.t;
    if (Math.random() < .55 && next !== 'sleep') this.blinkSoon(.06);
  }

  react(name: ReactionName) {
    if (this.reduced) return;
    this.reactions = this.reactions.filter((r) => r.name !== name);
    this.reactions.push({ name, start: this.t, dur: REACTIONS[name].dur });
  }

  private blinkSoon(delay = 0) { this.blinkState.next = this.t + delay; }

  /** Puntero normalizado al personaje: (0,0) centro, 1 = un «radio» del personaje. */
  pointerAt(nx: number, ny: number, over: boolean) {
    const p = this.pointer;
    const moved = Math.hypot(nx - p.x, ny - p.y) > .02;
    p.x = nx; p.y = ny; p.active = true; p.over = over;
    if (moved) { p.lastMove = this.t; this.lastInteraction = this.t; }
    if (this.state === 'sleep' && moved && Math.hypot(nx, ny) < 2.2) this.setState('idle');
  }
  pointerLeave() { this.pointer.active = false; this.pointer.over = false; }

  click() {
    this.lastInteraction = this.t;
    if (this.state === 'sleep') return this.setState('idle');
    this.react(this.def.play < .3 ? 'ack' : 'click');
    this.blinkSoon(.05);
  }

  keystroke() {
    this.lastInteraction = this.t;
    if (this.state === 'sleep') return this.setState('idle');
    if (Math.random() < .35) this.react('nod');
  }

  update(dtIn: number): Frame {
    const dt = Math.min(dtIn, 1 / 20);
    this.t += dt;
    const { t, p: P, def: S, reduced: R } = this;
    if (this.autoSleep && this.state === 'idle' && t - this.lastInteraction > this.sleepAfter) this.setState('sleep');

    const pose = POSES[this.state];
    const target: Pose = { ...NEUTRAL, ...pose };
    target.tilt *= P.tilt;

    const add: Partial2 = {};
    this.reactions = this.reactions.filter((r) => {
      const k = (t - r.start) / r.dur;
      if (k >= 1) return false;
      const o = REACTIONS[r.name].fn(clamp(k, 0, 1)) as Partial2;
      for (const key in o) {
        const name = key as keyof Pose;
        add[name] = (add[name] ?? 0) + (o[name] ?? 0);
      }
      return true;
    });

    // Decorativas: acercamiento y hover, ponderadas por lo que admite el estado.
    const play = R ? 0 : S.play;
    const ptr = this.pointer;
    const dist = ptr.active ? Math.hypot(ptr.x, ptr.y) : 9;
    this.near.t = ptr.active ? clamp(1 - (dist - .6) / 2.4, 0, 1) * play : 0;
    this.over.t = ptr.over ? play : 0;
    const near = this.near.step(dt, 60, 14);
    const over = this.over.step(dt, 80, 16);
    target.open += near * .12;
    target.brow += near * .25;
    target.glow += near * .15 + over * .1;
    target.smile += over * .4;
    target.mouth += over * .35;
    target.y -= near * 1.2;
    target.x += (ptr.active ? clamp(ptr.x, -1.5, 1.5) : 0) * near * 1.6;
    target.tilt += (ptr.active ? clamp(ptr.x, -1, 1) : 0) * near * 5 * P.tilt;

    const k = R ? 700 : P.k;
    const c = R ? 2 * Math.sqrt(700) : P.c;
    const o = this.out;
    for (const key in this.springs) {
      const name = key as keyof Pose;
      const s = this.springs[name];
      s.t = target[name];
      o[name] = s.step(dt, k, c);
    }

    // Capa ambiental
    this.idleW.t = R ? 0 : S.idle;
    this.workW.t = R ? 0 : (S.run ? 1 : this.state === 'permission' ? .6 : 0);
    const iw = this.idleW.step(dt, 30, 11);
    const ww = this.workW.step(dt, 40, 13);
    const sleeping = this.state === 'sleep';
    const bp = sleeping ? P.breath * 1.6 : P.breath;
    const breath = Math.sin((t / bp) * Math.PI * 2);
    const breath2 = Math.sin((t / bp) * Math.PI * 2 - .9);
    const swayN = Math.sin(t * .53 + this.seed) * .6 + Math.sin(t * .91 + this.seed * 2) * .4;
    o.y += breath * -.9 * P.breathAmp * iw;
    o.sy += breath * .014 * P.breathAmp * iw;
    o.sx -= breath * .006 * P.breathAmp * iw;
    o.rot += swayN * 1.1 * P.sway * iw;
    o.tilt += (Math.sin(t * .37 + this.seed) * 2.2 * P.sway + breath2 * .6) * iw;
    o.headLag = breath2 * .5 * iw;
    o.breath = breath * iw;

    // Capa de trabajo
    const st = this.state;
    const lt = t - this.stateSince;
    let wgx = 0, wgy = 0;
    o.work = ww;
    o.alertPulse = 0;
    if (!R) {
      if (st === 'thinking') {
        wgx = Math.sin(lt * .9) * .35 * P.wander; wgy = Math.sin(lt * 1.3) * .15;
        o.tilt += Math.sin(lt * .8) * 3 * P.tilt * ww;
      } else if (st === 'reading') {
        const line = (lt % 1.25) / 1.25;
        wgx = line < .8 ? -.6 + line / .8 * 1.2 : .6 - (line - .8) / .2 * 1.2;
        wgy = ((Math.floor(lt / 1.25) % 3) - 1) * .12;
      } else if (st === 'editing') {
        o.y += Math.max(0, Math.sin(lt * 11)) ** 3 * .7 * ww;
        wgx = Math.sin(lt * 1.6) * .25;
      } else if (st === 'command') {
        o.glow += ((lt * 2.4) % 1 < .12 ? .25 : 0) * ww;
        wgx = Math.round(Math.sin(lt * 1.9) * 2) / 2 * .35;
      } else if (st === 'streaming') {
        const syl = Math.max(0, Math.sin(lt * 13.7) * .5 + Math.sin(lt * 7.3 + 1) * .35 + Math.sin(lt * 3.1) * .25);
        o.mouthOpen += syl * .55 * ww;
        o.tilt += Math.sin(lt * 2.1) * 1.4 * ww;
        wgx = Math.sin(lt * .7) * .2;
      } else if (st === 'preparing') {
        o.glow += (Math.sin(lt * 5) * .5 + .5) * .3 * ww;
        o.spread += (Math.sin(lt * 5) * .5 + .5) * .12;
      } else if (st === 'permission') {
        o.alertPulse = Math.sin(lt * 3.2) * .5 + .5;
      } else if (st === 'queued') {
        wgx = Math.sin(lt * .8) > .6 ? .5 : 0;
      }
    }
    o.lt = lt;
    for (const key in add) {
      const name = key as keyof Pose;
      o[name] += add[name] ?? 0;
    }

    // Mirada
    const look = R ? 0 : S.look;
    const recent = ptr.active && t - ptr.lastMove < 2.8;
    if (t > this.nextSaccade) {
      this.nextSaccade = t + rand(...P.saccade);
      if (!recent || look === 0) {
        const w = P.wander * iw;
        let x = rand(-.7, .7) * w, y = rand(-.45, .35) * w;
        if (this.agent === 'codex') { x = Math.round(x * 3) / 3; y = Math.round(y * 3) / 3; }
        this.wander = { x, y };
      }
      this.micro = { x: rand(-.05, .05), y: rand(-.04, .04) };
    }
    const cursorW = recent ? look : 0;
    const px = clamp(ptr.x / 2.2, -1, 1), py = clamp(ptr.y / 2.2, -1, 1);
    const wanderW = cursorW ? 0 : (S.look > 0 ? iw : 0);
    const baseX = target.gx + wgx + this.wander.x * wanderW;
    const baseY = target.gy + wgy + this.wander.y * wanderW;
    const gx = baseX + (px - baseX) * cursorW + this.micro.x + (add.gx ?? 0);
    const gy = baseY + (py - baseY) * cursorW + this.micro.y + (add.gy ?? 0);
    if (Math.hypot(gx - this.gazeTarget.x, gy - this.gazeTarget.y) > .55 && Math.random() < .3) this.blinkSoon(0);
    this.gazeTarget = { x: gx, y: gy };
    this.gaze.x.t = clamp(gx, -1.1, 1.1); this.gaze.y.t = clamp(gy, -1.1, 1.1);
    o.gx = R ? this.gaze.x.t : this.gaze.x.step(dt, P.gazeK, P.gazeC);
    o.gy = R ? this.gaze.y.t : this.gaze.y.step(dt, P.gazeK, P.gazeC);

    // Parpadeo
    let blink = 0;
    if (!R && !sleeping) {
      const b = this.blinkState;
      if (t >= b.next && b.start < 0) { b.start = t; b.double = Math.random() < P.double; }
      if (b.start >= 0) {
        const e = t - b.start;
        const one = (x: number) => (x < .07 ? x / .07 : x < .11 ? 1 : x < .24 ? 1 - (x - .11) / .13 : 0);
        blink = one(e) || (b.double && e > .26 ? one(e - .26) : 0);
        if (e > (b.double ? .52 : .26)) { b.start = -1; b.next = t + rand(...P.blink) * (st === 'reading' || st === 'editing' ? 1.4 : 1); }
      }
    }
    o.blink = blink;
    o.open = clamp(o.open, 0, 1.4) * (1 - blink);
    o.near = near;
    o.over = over;
    o.t = t;
    o.state = st;
    o.sleeping = sleeping;
    o.smile = clamp(o.smile, 0, 1.2);
    o.glow = clamp(o.glow, 0, 1.3);
    o.spread = clamp(o.spread, -.2, 1.2);
    o.mouthOpen = clamp(o.mouthOpen, 0, 1);
    return o;
  }
}

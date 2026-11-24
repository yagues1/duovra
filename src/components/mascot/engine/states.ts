/**
 * Mascotas 2.0 (1.0.7) — estados del personaje.
 *
 * Todo lo que la mascota comunica sale de un dato real de Duovra (ver `lib/activity.ts`); el cursor,
 * el hover, el clic y el despertar son reacciones decorativas. `priority` decide qué manda cuando
 * coinciden varias señales: ninguna reacción decorativa tapa un permiso pendiente o un error.
 */
import type { Activity } from '../../../lib/activity';

export type MascotState =
  | 'idle' | 'sleep' | 'selected' | 'typing' | 'queued' | 'sent' | 'preparing'
  | 'thinking' | 'reading' | 'editing' | 'command' | 'streaming'
  | 'permission' | 'done' | 'error' | 'cancelled';

export type Tone = 'agent' | 'warn' | 'danger' | 'success' | 'muted';

export interface StateDef {
  priority: number;
  /** Peso del seguimiento del cursor. */
  look: number;
  /** Peso de las reacciones decorativas (hover, clic, acercamiento). */
  play: number;
  /** Peso de la capa ambiental (respiración, balanceo, mirar alrededor). */
  idle: number;
  tone: Tone;
  /** Estados de ejecución: activan la capa de trabajo. */
  run?: boolean;
}

export const STATES: Record<MascotState, StateDef> = {
  idle: { priority: 0, look: 1, play: 1, idle: 1, tone: 'agent' },
  sleep: { priority: 1, look: 0, play: .6, idle: 1.3, tone: 'agent' },
  selected: { priority: 30, look: .8, play: 1, idle: 1, tone: 'agent' },
  typing: { priority: 40, look: .35, play: .5, idle: .7, tone: 'agent' },
  queued: { priority: 45, look: .3, play: .3, idle: .6, tone: 'agent', run: true },
  sent: { priority: 50, look: 0, play: 0, idle: .3, tone: 'agent' },
  preparing: { priority: 55, look: 0, play: 0, idle: .4, tone: 'agent', run: true },
  thinking: { priority: 60, look: 0, play: .15, idle: .5, tone: 'agent', run: true },
  reading: { priority: 60, look: 0, play: .15, idle: .4, tone: 'agent', run: true },
  editing: { priority: 60, look: 0, play: .15, idle: .4, tone: 'agent', run: true },
  command: { priority: 60, look: 0, play: .15, idle: .4, tone: 'agent', run: true },
  streaming: { priority: 60, look: .15, play: .15, idle: .5, tone: 'agent', run: true },
  permission: { priority: 85, look: .25, play: 0, idle: .15, tone: 'warn' },
  done: { priority: 70, look: .5, play: .6, idle: .8, tone: 'success' },
  error: { priority: 90, look: .2, play: 0, idle: .3, tone: 'danger' },
  cancelled: { priority: 75, look: .3, play: .2, idle: .5, tone: 'muted' },
};

export const TONES: Record<Exclude<Tone, 'agent'>, string> = {
  warn: '#e8bf7f',
  danger: '#f39ca7',
  success: '#94d6ad',
  muted: '#a7aca4',
};

export const AGENT_COLORS = {
  claude: { main: '#eba37e', light: '#f7c29d', deep: '#bb6d51' },
  codex: { main: '#83d4e1', light: '#b2e9ed', deep: '#4ba2b6' },
} as const;

/** Actividad real de 1.0.6 → estado del personaje. */
export function fromActivity(a: Activity, opts: { phase?: 'starting'; stopping?: boolean } = {}): MascotState {
  if (opts.stopping) return 'cancelled';
  if (opts.phase === 'starting') return 'preparing';
  switch (a) {
    case 'writing': return 'streaming';
    case 'coding': return 'editing';
    case 'tools': return 'command';
    case 'waiting': return 'permission';
    default: return a;
  }
}

export type Pose = {
  x: number; y: number; rot: number; sx: number; sy: number; tilt: number;
  gx: number; gy: number; open: number; smile: number; squint: number; brow: number; browIn: number;
  mouth: number; mouthOpen: number; mouthW: number; glow: number; spread: number; alert: number;
};

export const NEUTRAL: Pose = {
  x: 0, y: 0, rot: 0, sx: 0, sy: 0, tilt: 0,
  gx: 0, gy: 0, open: 1, smile: 0, squint: 0, brow: 0, browIn: 0,
  mouth: .25, mouthOpen: 0, mouthW: .5, glow: .35, spread: 0, alert: 0,
};

export const POSES: Record<MascotState, Partial<Pose>> = {
  idle: {},
  sleep: { y: 2.5, rot: -4, tilt: -8, open: 0, mouth: .05, glow: .12, sy: -.03, sx: .02 },
  selected: { y: -1.5, open: 1.12, smile: .45, brow: .5, mouth: .6, glow: .7, sy: .02 },
  typing: { gx: -.35, gy: .75, tilt: 5, y: .5, brow: .25, open: 1.05, mouth: .2, glow: .45 },
  queued: { gx: .55, gy: .4, tilt: -3, brow: .15, mouth: .1, glow: .3 },
  sent: { y: -2, gy: -.3, open: 1.1, brow: .4, mouth: .5, glow: .8 },
  preparing: { gy: -.15, open: 1.08, brow: .35, squint: .05, mouth: .05, glow: .75, spread: .15 },
  thinking: { gx: .45, gy: -.6, tilt: -7, rot: -2, squint: .25, brow: .3, browIn: .2, mouth: -.05, mouthW: .35, glow: .6, spread: .2 },
  reading: { gy: .45, tilt: 3, squint: .2, brow: -.05, mouth: 0, mouthW: .35, glow: .55, spread: .1 },
  command: { gy: .25, squint: .35, browIn: .45, brow: -.1, mouth: -.05, mouthW: .3, glow: .75, spread: .3 },
  editing: { gy: .55, tilt: -2, squint: .3, browIn: .35, mouth: .1, mouthW: .4, glow: .7, spread: .25 },
  streaming: { gy: .05, open: 1.02, brow: .2, mouth: .35, mouthOpen: .25, glow: .6, spread: .1 },
  permission: { y: -1, gy: .15, open: 1.18, brow: .7, mouth: 0, mouthW: .35, glow: .9, alert: 1 },
  done: { y: -1, open: .9, smile: 1, brow: .45, mouth: .9, mouthW: .6, glow: .85 },
  error: { y: 1.5, rot: 3, tilt: 6, gy: .45, open: .85, brow: -.8, browIn: -.2, mouth: -.75, mouthW: .4, glow: .65, sy: -.025 },
  cancelled: { y: 1.2, gy: .3, open: .65, brow: -.25, mouth: -.15, mouthW: .35, glow: .2, sy: -.035, sx: .015 },
};

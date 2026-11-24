/* Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt. */
/**
 * The light field behind the conversation surface: evaluated on the CPU from two precomputed noise
 * tables (no WebGL), drawn in one of two textures:
 *
 * - `dither`: one pixel per cell, ordered-dithered to a few levels and scaled up without
 *   smoothing. Large stages get coarser cells so a frame stays under 24k cells.
 * - `ascii`: the same field on a glyph grid, one Geist Mono character per cell picked from
 *   a brightness ramp and tinted with the cell's colour. Glyphs are blitted from a small white
 *   atlas into a persistent mask, and only cells whose glyph changed are redrawn; colour is
 *   applied in one composite pass.
 * - `halftone`: the glyph machinery with a ramp of round dots (drawn here) on a square grid.
 * - `soft`: no texture: the dither renderer without quantization, scaled up smoothly. With an
 *   image it is the image itself, cover-fitted and dimmed (`softImageRenderer`).
 *
 * An image (`FieldEngine.setImage`) replaces the pattern: its brightness drives every texture,
 * coloured by the palette or by its own colours. `Look.spot` confines the light around a point
 * with a smooth falloff applied before quantization, so its edge is dithered like the rest.
 *
 * This module has no DOM dependencies, so it runs both in `field.worker.ts` on an
 * OffscreenCanvas (the normal path) and on the main thread as a fallback. `FieldEngine` owns
 * the clock and frame loop; whoever hosts it decides when it runs.
 */

export type DitherVariant = 'streaks' | 'aurora' | 'streak' | 'bloom' | 'tubes' | 'tiles';
export type DitherPalette = 'ember' | 'iris' | 'forest' | 'mint' | 'amber' | 'spectrum' | 'mono' | 'custom';
export type DitherTexture = 'dither' | 'ascii' | 'halftone' | 'soft' | 'dots';

export interface Look {
  /**
   * Confines the light around a point: [x, y] 0..1 across the stage, and reach 0..1 (1 = even,
   * no falloff). Absent means no falloff beyond the variant's own.
   */
  spot?: [number, number, number] | null;
  /** Direction of streaks and of the sweep / tubes' wave, in degrees. Absent: the built-in drift. */
  angle?: number;
  /** The 'custom' palette: hue 0..360 and saturation 0..1. */
  hue?: number;
  sat?: number;
  /** Hex de la paleta fija en Duovra. El matiz de Beta 2 conserva su rampa original. */
  color?: string;
  /** Parámetros normalizados de los patrones editables de Duovra. */
  shaping?: {
    scale: number;
    amplitude: number;
    contrast: number;
    brightness: number;
    softness: number;
    spread: number;
  };
  /** With an image: its own colours instead of the palette. */
  imageColour?: boolean;
  /** With an image: the variant's moving pattern played as light over it, 0..1 (0 or absent: the image alone). */
  overlay?: number;
  variant: DitherVariant;
  palette: DitherPalette;
  focus: [number, number];
  gain: number;
  speed: number;
  seed: number;
  /** A full-bleed backdrop: even light edge to edge, darkened softly behind the centre column, capped well below white. */
  full: boolean;
  /** Where the pointer is, -0.5..0.5 across the field; the vanishing point eases a few percent toward it. */
  pointer?: [number, number] | null;
  /** How strongly beats (send, done, fail) show on this field: 0 none, 1 full; above 1 lifts a dim field's beats. */
  react?: number;
}

/**
 * A one-shot disturbance that travels through the cells:
 * - `send`: a pressure wave leaves the point: a thin bright crest that bends the pattern outward,
 *   a darker trough behind it, a weaker echo, and a short flash where it started.
 * - `pulse`: the same wave, softer (onboarding steps, sign-in, the ultra edge).
 * - `done`: the reverse: a soft ring closes in on the point and settles there.
 * - `fail`: the light dips, spreading out from the point, and recovers.
 */
export type FieldBeat = 'send' | 'pulse' | 'done' | 'fail';

/** What the host measured: CSS size, device pixel ratio, and the requested cell size (dither). */
export interface Metrics {
  width: number;
  height: number;
  dpr: number;
  cell: number;
  dotSize?: number;
  /** Height of the original conversation horizon, within the full stage. */
  bandHeight?: number;
}

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** shadow → body → light → hot */
const PALETTES: Record<DitherPalette, [RGB, RGB, RGB, RGB]> = {
  // The shadow stop is the stage colour (--sheet), so the field melts into the surface.
  ember: [hex('#0c0c0e'), hex('#7a2608'), hex('#f2702e'), hex('#ffe2bc')],
  iris: [hex('#0c0c0e'), hex('#262c84'), hex('#6c88ff'), hex('#e2ebff')],
  // Sunlit foliage: deep green through yellow-green to pale cream.
  forest: [hex('#0c0c0e'), hex('#174a1e'), hex('#9cc23e'), hex('#f3efc8')],
  mint: [hex('#0c0c0e'), hex('#0b6444'), hex('#45dc98'), hex('#e4ffec')],
  // --amber: waiting on you.
  amber: [hex('#0c0c0e'), hex('#7a5206'), hex('#ecc064'), hex('#fff3d6')],
  spectrum: [hex('#0c0c0e'), hex('#3a1a66'), hex('#e0649e'), hex('#ffe6c8')],
  mono: [hex('#0c0c0e'), hex('#2c2c30'), hex('#909096'), hex('#f2f2f0')],
  // Replaced by customPalette() from the look's hue and saturation.
  custom: [hex('#0c0c0e'), hex('#2c2c30'), hex('#909096'), hex('#f2f2f0')],
};

function hsl(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
  return [f(0), f(8), f(4)];
}

let customKey = '';
let customStops: [RGB, RGB, RGB, RGB] = PALETTES.custom;
/** A palette from one hue: the same shadow, a deep body, a clear light and a pale, less saturated hot end. */
function customPalette(hue = 28, sat = 0.7): [RGB, RGB, RGB, RGB] {
  const key = `${hue}/${sat}`;
  if (key !== customKey) {
    customKey = key;
    customStops = [PALETTES.mono[0], hsl(hue, sat * 0.9, 0.2), hsl(hue, sat, 0.56), hsl(hue, sat * 0.5, 0.9)];
  }
  return customStops;
}

const paletteOf = (s: Look) => (s.palette === 'custom' ? customPalette(s.hue, s.sat) : PALETTES[s.palette]);

let fixedKey: string | undefined;
let fixedStops: [RGB, RGB, RGB, RGB] = PALETTES.custom;
function fieldPalette(look: Look) {
  const color = look.color;
  if (look.palette !== 'custom' || !color) return paletteOf(look);
  if (fixedKey !== color) {
    fixedKey = color;
    const light = hex(color);
    const body = light.map((channel) => Math.round(channel * 0.32 + 10)) as RGB;
    const hot = light.map((channel) => Math.round(channel + (255 - channel) * 0.52)) as RGB;
    fixedStops = [PALETTES.custom[0], body, light, hot];
  }
  return fixedStops;
}

/** An image as the field samples it: cover-fitted to the stage, brightness and colour per pixel (0..1). */
interface ImagePixels {
  w: number;
  h: number;
  aspect: number;
  lum: Float32Array;
  rgb: Float32Array;
}

/** Rows an image is sampled at; finer than any texture's rows, so cells never see its pixels. */
const IMAGE_ROWS = 240;

function rasterize(src: CanvasImageSource & { width: number; height: number }, aspect: number): ImagePixels | null {
  const h = IMAGE_ROWS;
  const w = Math.max(2, Math.min(720, Math.round(h * aspect)));
  const c = scratch(w, h);
  const ctx = context(c, { willReadFrequently: true });
  if (!ctx || !src.width || !src.height) return null;
  // Cover: the image fills the stage, cropped evenly on the long side.
  const k = Math.max(w / src.width, h / src.height);
  const dw = src.width * k;
  const dh = src.height * k;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const r = d[o] / 255;
    const g = d[o + 1] / 255;
    const b = d[o + 2] / 255;
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    lum[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
  }
  return { w, h, aspect, lum, rgb };
}

// ── noise tables (built once per thread, shared by every field) ──

const N = 256;
const MASK = N - 1;
let tables: [Float32Array, Float32Array] | null = null;

function buildNoise(seed: number): Float32Array {
  // Tileable value-noise fbm: each octave is a wrapped lattice, so the table repeats seamlessly.
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(N * N);
  let amp = 0.5;
  let total = 0;
  for (let period = 4; period <= 64; period *= 2) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const scale = period / N;
    for (let y = 0; y < N; y++) {
      const fy = y * scale;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % period) * period;
      const yb = ((y0 + 1) % period) * period;
      for (let x = 0; x < N; x++) {
        const fx = x * scale;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % period;
        const xb = (x0 + 1) % period;
        const top = lattice[ya + xa] + (lattice[ya + xb] - lattice[ya + xa]) * sx;
        const bot = lattice[yb + xa] + (lattice[yb + xb] - lattice[yb + xa]) * sx;
        out[y * N + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function getTables() {
  return (tables ??= [buildNoise(7), buildNoise(1913)]);
}

/** Bilinear sample; one unit of (x, y) spans the whole table. */
function sample(tex: Float32Array, x: number, y: number): number {
  const fx = x * N;
  const fy = y * N;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = x0 & MASK;
  const xb = (x0 + 1) & MASK;
  const ya = (y0 & MASK) * N;
  const yb = ((y0 + 1) & MASK) * N;
  const top = tex[ya + xa] + (tex[ya + xb] - tex[ya + xa]) * tx;
  const bot = tex[yb + xa] + (tex[yb + xb] - tex[yb + xa]) * tx;
  return top + (bot - top) * ty;
}

const BAYER = (() => {
  const m = new Float32Array(64);
  const b2 = [0, 2, 3, 1];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let bit = 0; bit < 3; bit++) {
        const xx = (x >> bit) & 1;
        const yy = (y >> bit) & 1;
        // The finest spatial bit carries the most weight: that is what makes the pattern fine-grained.
        v += b2[yy * 2 + xx] / 4 ** (bit + 1);
      }
      m[y * 8 + x] = v - 0.5;
    }
  return m;
})();

const sstep = (a: number, b: number, x: number) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

const TAU = 6.28318;

/** How long each beat lasts, ms. */
const BEAT_MS: Record<FieldBeat, number> = { send: 1800, pulse: 1400, done: 1250, fail: 1100 };
const MAX_BEATS = 3;
/** Fronts drawn per frame: a beat draws up to three (its crest, an echo, a flash or settle at its origin). */
const MAX_FRONTS = 9;
/** Floats per front: cx, cy, radius, lead, tail, amp, push, disk, multiply, trough. */
const FS = 10;
/** The pointer's light: reach (field heights), strength, and the spring it follows the pointer on. */
const LIGHT_R = 0.4;
const LIGHT_K = 0.34;
const LIGHT_W = 5.2;

/**
 * The spectrum palette's hues (blue, violet, pink,
 * ember and gold) as a closed loop, held a little below full saturation so a whole stage of
 * it stays a wash of light rather than a rainbow.
 */
const HUE_N = 512;
const HUES = (() => {
  const stops = ['#5b8cf0', '#9a78f2', '#e46aa4', '#f07a48', '#eaa850', '#e46aa4', '#9a78f2'].map(hex);
  const t = new Float32Array(HUE_N * 3);
  for (let i = 0; i < HUE_N; i++) {
    const f = (i / HUE_N) * stops.length;
    const k = Math.floor(f);
    const u = sstep(0, 1, f - k);
    const a = stops[k % stops.length];
    const b = stops[(k + 1) % stops.length];
    const rgb = [0, 1, 2].map((j) => (a[j] + (b[j] - a[j]) * u) / 255);
    const grey = rgb[0] * 0.3 + rgb[1] * 0.55 + rgb[2] * 0.15;
    for (let j = 0; j < 3; j++) t[i * 3 + j] = grey + (rgb[j] - grey) * 0.82;
  }
  return t;
})();
/** cos(x) by table, for per-cell waves: 1024 steps around the circle are far finer than a cell. */
const COS_N = 1024;
const COS = (() => {
  const t = new Float32Array(COS_N);
  for (let i = 0; i < COS_N; i++) t[i] = Math.cos((i / COS_N) * Math.PI * 2);
  return t;
})();
const COS_K = COS_N / (Math.PI * 2);
const fcos = (x: number) => COS[((x * COS_K) | 0) & (COS_N - 1)];
/** The session's horizon, in band heights: where its crest is (from the top), how far it sinks to the
    stage's edges, how far its glow rises, how thick the bright edge is, and the light left below it. */
const HORIZON_APEX = 0.47;
const HORIZON_SAG = 0.6;
const HORIZON_GLOW = 0.36;
const HORIZON_RIM = 0.08;
const HORIZON_GROUND = 0.24;
const STREAK_COS = Math.cos(-0.6);
const STREAK_SIN = Math.sin(-0.6);
/** Streaks run along a 35° diagonal, rising to the right on screen (y grows downward). */
const STREAKS_COS = Math.cos((35 * Math.PI) / 180);
const STREAKS_SIN = Math.sin((35 * Math.PI) / 180);

/** Tubes: grid pitch (in field heights), and how far the light reaches from the focus. */
const TUBE_G = 0.2;
/** A full-bleed field of tubes is a finer, regular grid. */
const TUBE_G_FULL = 0.1;
const TUBE_REACH = 0.92;
/** Past this distance the brightest rim, after the falloff, stays under the black floor: never evaluated. */
const TUBE_SPAN = 0.8;
/** The travelling wave: radians per tube along its direction, and its angular speed (a 4.2 s period). */
const WAVE_K = 0.9;
const WAVE_W = TAU / 4.2;
/** Full bleed: one long, slow sweep crossing the stage (about 20 tubes per wavelength, an 11 s period). */
const WAVE_K_FULL = 0.32;
const WAVE_W_FULL = TAU / 11;
/** Tiles: a plane seen from above at a slight angle. Horizon (field heights above the top), scales across and along. */
const TILE_H = -2.2;
const TILE_SU = 25;
const TILE_SV = 92;
const TILE_REACH = 0.88;
const TILE_SPAN = 0.84;
/** Tile body: half size and corner radius in cell units, and the width of the lit edge. */
const TILE_HALF = 0.4;
const TILE_R = 0.16;
const TILE_RIM = 0.075;
/** Full bleed: the soft darkening behind the centre column (field heights) and how deep it goes. */
const HOLLOW_Y = 0.45;
const HOLLOW_RX = 0.62;
const HOLLOW_RY = 0.4;
const HOLLOW = 0.64;
/** Full bleed: light above this knee rolls off toward KNEE + ROLL, so the brightest cells stay well below white. */
const KNEE = 0.4;
const ROLL = 0.24;
/** Full bleed: how strongly each variant shows, so they sit at the same calm level. */
const FULL_GAIN: Partial<Record<DitherVariant, number>> = { streaks: 2.1, aurora: 1.3, tubes: 0.85, tiles: 0.85 };

// ── the field (shared by both textures) ──

/**
 * The eased look and clock of one field, and the per-point evaluation. `step` once per
 * frame, then `shade` every cell inside `span`. Coordinates are in units of the field's
 * height: px in 0..aspect left to right, py in 0..1 top to bottom.
 */
export class Field {
  /** Palette ramp, 256 entries of rgb in 0..1. `lut[0..2]` is the ground colour. */
  readonly lut = new Float32Array(256 * 3);
  private readonly A: Float32Array;
  private readonly B: Float32Array;
  // Eased state, so palette / gain / focus changes cross-fade instead of snapping.
  private readonly colors: RGB[];
  private spectrum: number;
  private readonly focusNow: number[];
  private readonly par = [0, 0];
  private gainNow: number;
  private fullNow: number;
  private clock: number;
  private last = 0;
  private first = true;
  // Per-frame constants read by shade().
  private t = 0;
  private aspect = 1;
  private fx = 0;
  private fy = 0;
  /** The vanishing point: the focus, nudged toward the pointer. */
  private vx = 0;
  private vy = 0;
  private reach = Infinity;
  private full = false;
  private mode: DitherVariant = 'bloom';
  private sd = 0;
  private wc = 1;
  private ws = 0;
  private l1x = 0;
  private l1y = 0;
  private l2x = 0;
  private l2y = 0;
  private breath = 1;
  private fullK = 1;
  private hollowK = 0;
  private tubeG = TUBE_G;
  private waveK = WAVE_K;
  private waveW = WAVE_W;
  // Per-cell cache: tubes and tiles are evaluated once per tube or tile, not once per pixel.
  private ci = 1e9;
  private cj = 1e9;
  private c0 = 0;
  private c1 = 0;
  private c2 = 0;
  private c3 = 0;
  private c4 = 0;
  private c5 = 0;
  private c6 = 0;
  // Per-row cache for tiles.
  private ry = -1;
  private rh = 0;
  private riz = 0;
  private riv = 0;
  private rlv = 0;
  /** The hue the variant chose for this point (spectrum palette). */
  private hue = 0;
  // Per-row cache for the hollow.
  private hy = -1;
  private hq = 0;
  // Beats: one-shot disturbances travelling through the cells (see FieldBeat). Each frame they are
  // turned into a few fronts (rings or soft disks); `fn` is how many are live, so a quiet field pays
  // one test per cell. Per point, `wave` leaves the light to add, the factor to multiply by and how
  // far the pattern is pushed.
  private readonly beats: { kind: FieldBeat; x: number; y: number; t0: number; s: number }[] = [];
  private fn = 0;
  private readonly pf = new Float32Array(MAX_FRONTS * FS);
  private lift = 0;
  private wadd = 0;
  private wmul = 1;
  private wdx = 0;
  private wdy = 0;
  /** Under load the governor sheds the costly parts first: no bending, no echo, no pointer light. */
  lite = false;
  // Eased speed: working drifts faster, waiting and rest ease to a standstill instead of snapping.
  private speedNow: number;
  private restK = 1;
  /** True once nothing moves: no drift, no beat, no light easing (the engine stops drawing). */
  still = false;
  // The pointer's light: a critically damped follower, and how present it is (fades in and out).
  private plx = 0;
  private ply = 0;
  private pvx = 0;
  private pvy = 0;
  private plI = 0;
  private plOn = false;
  /** Per-frame: the light's centre in field units and its strength (0 when off). */
  private lx = 0;
  private ly = 0;
  private lI = 0;

  /** How strongly beats show (Look.react). */
  private react = 1;
  private shaping: Look['shaping'];
  private bend = 0;

  /** Starts a beat at (nx, ny), each 0..1 across the field. */
  beat(kind: FieldBeat, nx: number, ny: number, strength: number, now: number) {
    if (this.beats.length >= MAX_BEATS) this.beats.shift();
    this.beats.push({ kind, x: nx, y: ny, t0: now, s: strength < 0 ? 0 : strength > 1.6 ? 1.6 : strength });
    this.still = false;
  }

  /** True while a beat is travelling (the engine draws faster meanwhile). */
  get pulsing() {
    return this.beats.length > 0;
  }

  /** Rest: the drift eases to a standstill (and back when woken). */
  setRest(rest: boolean) {
    this.restK = rest ? 0 : 1;
    if (!rest) this.still = false;
  }

  // The spot (Look.spot), eased: centre in stage units (0..1 both ways) and reach.
  private readonly spotNow = [0.5, 0.5, 1];
  private spotOn = false;
  private spX = 0.5;
  private spY = 0.5;
  private spR = 1;
  private spIn = 0;
  private spEven = 0;
  /** Streak direction (cos, sin). */
  private sc = STREAKS_COS;
  private ss = STREAKS_SIN;
  // The image that replaces the pattern, and its pixels for the current aspect.
  private imageSrc: (CanvasImageSource & { width: number; height: number }) | null = null;
  private px: ImagePixels | null = null;
  private imgColour = false;
  /** Strength of the moving pattern over an image (Look.overlay). */
  private overlay = 0;
  /** The image colour at the point just shaded (image colours only). */
  private ir = 0;
  private ig = 0;
  private ib = 0;
  private ilum = 0;

  /** The image to draw instead of the pattern (null: the pattern). Rasterized on the next step. */
  setImage(src: (CanvasImageSource & { width: number; height: number }) | null) {
    this.imageSrc = src;
    this.px = null;
  }

  get hasImage() {
    return this.imageSrc != null;
  }

  /** Even light in place of the pattern (the soft image's light mask: the image itself is drawn as it is). */
  flat = false;

  /** The field's clock (s, scaled by speed) and the pointer's eased lean, for renderers that move on their own. */
  get clockNow() {
    return this.clock;
  }

  get parallax(): readonly number[] {
    return this.par;
  }

  constructor(look: Look) {
    [this.A, this.B] = getTables();
    this.colors = fieldPalette(look).map((c) => [...c]) as RGB[];
    this.spectrum = look.palette === 'spectrum' ? 1 : 0;
    this.focusNow = look.full ? [0.5, 0.5] : [...look.focus];
    this.gainNow = look.gain;
    this.fullNow = look.full ? 1 : 0;
    this.clock = look.seed * 10;
    this.speedNow = look.speed;
    if (look.spot) [this.spotNow[0], this.spotNow[1], this.spotNow[2]] = look.spot;
  }

  step(s: Look, now: number, aspect: number) {
    const dt = this.first ? 0 : Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    // Speed eases (about half a second): a turn starting quickens the drift, waiting and rest still it.
    const sp = s.speed * this.restK;
    const was = this.speedNow;
    this.speedNow += (sp - this.speedNow) * (this.first ? 1 : Math.min(1, dt * 2.2));
    if (Math.abs(sp - this.speedNow) < 0.004 * Math.max(0.05, s.speed)) this.speedNow = sp;
    this.clock += dt * (was + this.speedNow) * 0.5;
    const k = this.first ? 1 : Math.min(1, dt * 3);
    const kp = this.first ? 1 : Math.min(1, dt * 2.2);
    this.first = false;
    // How much the eased look still moves this frame (the engine stops drawing once nothing does).
    let moved = Math.abs(this.speedNow) + Math.abs(sp - this.speedNow);
    const target = fieldPalette(s);
    const colors = this.colors;
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 3; j++) {
        const d = target[i][j] - colors[i][j];
        colors[i][j] += d * k;
        moved += Math.abs(d) * 0.004;
      }
    this.spectrum += ((s.palette === 'spectrum' ? 1 : 0) - this.spectrum) * k;
    const focus = s.full ? [0.5, 0.5] : s.focus;
    moved += Math.abs(focus[0] - this.focusNow[0]) + Math.abs(focus[1] - this.focusNow[1]) + Math.abs(s.gain - this.gainNow);
    this.focusNow[0] += (focus[0] - this.focusNow[0]) * k;
    this.focusNow[1] += (focus[1] - this.focusNow[1]) * k;
    this.gainNow += (s.gain - this.gainNow) * k;
    this.fullNow += ((s.full ? 1 : 0) - this.fullNow) * k;
    const p = s.pointer;
    const parX = p ? p[0] * 0.07 : 0;
    const parY = p ? p[1] * 0.05 : 0;
    moved += Math.abs(parX - this.par[0]) + Math.abs(parY - this.par[1]);
    this.par[0] += (parX - this.par[0]) * kp;
    this.par[1] += (parY - this.par[1]) * kp;
    // The pointer's light (full stages only): follows on a critically damped spring, so it trails
    // the pointer by a fraction of a second and comes to rest without overshoot.
    const lightOn = !!p && s.full && !this.lite && (s.shaping != null || (s.react ?? 1) > 0);
    if (lightOn && p) {
      const tx = (p[0] + 0.5) * aspect;
      const ty = p[1] + 0.5;
      if (!this.plOn) {
        this.plx = tx;
        this.ply = ty;
        this.pvx = this.pvy = 0;
      }
      const n = Math.max(1, Math.ceil(dt / 0.016));
      for (let i = 0; i < n; i++) {
        const h = dt / n;
        this.pvx += (LIGHT_W * LIGHT_W * (tx - this.plx) - 2 * LIGHT_W * this.pvx) * h;
        this.pvy += (LIGHT_W * LIGHT_W * (ty - this.ply) - 2 * LIGHT_W * this.pvy) * h;
        this.plx += this.pvx * h;
        this.ply += this.pvy * h;
      }
      moved += Math.abs(this.pvx) + Math.abs(this.pvy);
    }
    this.plOn = lightOn;
    const li = lightOn ? 1 : 0;
    moved += Math.abs(li - this.plI);
    this.plI += (li - this.plI) * Math.min(1, dt * 1.6);
    if (Math.abs(li - this.plI) < 0.01) this.plI = li;
    this.lx = this.plx;
    this.ly = this.ply;
    this.lI = this.plI * LIGHT_K;
    this.react = s.react ?? 1;
    // The spot eases like the focus, so dragging it in Settings glides.
    const spot = s.spot ?? null;
    const sn = this.spotNow;
    const ks = this.first ? 1 : Math.min(1, dt * 6);
    sn[0] += ((spot ? spot[0] : 0.5) - sn[0]) * ks;
    sn[1] += ((spot ? spot[1] : 0.5) - sn[1]) * ks;
    sn[2] += ((spot ? spot[2] : 1) - sn[2]) * ks;
    moved += Math.abs((spot ? spot[0] : 0.5) - sn[0]) + Math.abs((spot ? spot[1] : 0.5) - sn[1]) + Math.abs((spot ? spot[2] : 1) - sn[2]);
    if (Math.abs(sn[2] - (spot ? spot[2] : 1)) < 0.002) sn[2] = spot ? spot[2] : 1;
    // Reach → falloff radius (in stage units, so the light spreads as an ellipse matching the
    // stage); near full reach the falloff blends into even light.
    const reach = sn[2];
    this.spotOn = reach < 0.999;
    this.spX = sn[0];
    this.spY = sn[1];
    this.spR = 0.1 + 1.8 * reach ** 1.3;
    this.spIn = 0;
    this.spEven = sstep(0.86, 1, reach);
    const ang = s.angle == null ? null : (s.angle * Math.PI) / 180;
    this.sc = ang == null ? STREAKS_COS : Math.cos(ang);
    this.ss = ang == null ? STREAKS_SIN : Math.sin(ang);
    this.imgColour = !!s.imageColour;
    this.overlay = s.overlay && s.overlay > 0 ? Math.min(1, s.overlay) : 0;
    this.ogFrame = (this.ogFrame + 1) >>> 0 || 1;
    if (this.imageSrc && (!this.px || Math.abs(this.px.aspect - aspect) > 0.01)) this.px = rasterize(this.imageSrc, aspect);

    const lut = this.lut;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const a = sstep(0, 0.4, t);
      const b = sstep(0.28, 0.74, t);
      const c = sstep(0.7, 1, t);
      for (let j = 0; j < 3; j++) {
        let v = colors[0][j] + (colors[1][j] - colors[0][j]) * a;
        v += (colors[2][j] - v) * b;
        v += (colors[3][j] - v) * c;
        lut[i * 3 + j] = v / 255;
      }
    }

    const t = this.clock;
    this.t = t;
    this.shaping = s.shaping;
    this.bend = s.shaping ? fcos(t * 0.63) * s.shaping.amplitude : 0;
    this.aspect = aspect;
    this.full = s.full;
    this.fx = this.focusNow[0] * aspect;
    this.fy = this.focusNow[1];
    this.vx = (this.focusNow[0] + this.par[0]) * aspect;
    this.vy = this.focusNow[1] + this.par[1];
    this.mode = s.variant;
    this.sd = s.seed * 0.137;
    this.reach = s.full ? Infinity : s.variant === 'tubes' ? TUBE_SPAN : s.variant === 'tiles' ? TILE_SPAN : Infinity;
    this.tubeG = s.full ? TUBE_G_FULL : TUBE_G;
    this.fullK = this.gainNow * (FULL_GAIN[s.variant] ?? 1);
    this.hollowK = HOLLOW * this.fullNow;
    this.waveK = s.full ? WAVE_K_FULL : WAVE_K;
    this.waveW = s.full ? WAVE_W_FULL : WAVE_W;
    // The wave's direction turns slowly: a full turn in about two minutes.
    // With an angle it holds that direction, swaying a little.
    const dir = ang == null ? t * 0.05 + this.sd * 7 : ang + 0.22 * Math.sin(t * 0.05);
    this.wc = Math.cos(dir);
    this.ws = Math.sin(dir);
    // A gentle breath, so a full stage of light is never quite still.
    this.breath = 0.92 + 0.08 * Math.sin(t * 0.42);
    // Two lights glide under the tiles on slow, unrelated loops; a full stage spreads them across its width.
    if (s.full) {
      this.l1x = aspect * (0.3 + 0.2 * Math.sin(t * 0.21 + this.sd * 9));
      this.l1y = 0.35 + 0.25 * Math.sin(t * 0.17 + 1.7);
      this.l2x = aspect * (0.7 + 0.2 * Math.sin(t * 0.15 + 3.1));
      this.l2y = 0.6 + 0.25 * Math.cos(t * 0.19);
    } else {
      this.l1x = this.fx - 0.3 + 0.24 * Math.sin(t * 0.45 + this.sd * 9);
      this.l1y = this.fy - 0.22 + 0.15 * Math.sin(t * 0.31 + 1.7);
      this.l2x = this.fx - 0.1 + 0.16 * Math.sin(t * 0.27 + 3.1);
      this.l2y = this.fy - 0.44 + 0.12 * Math.cos(t * 0.39);
    }
    this.ci = 1e9;
    this.cj = 1e9;
    this.ry = -1;
    this.hy = -1;

    this.planBeats(now, aspect);
    this.still = moved < 2e-4 && this.fn === 0;
  }

  /** Writes one front into the per-frame table (dropped when the table is full). */
  private front(cx: number, cy: number, r: number, lead: number, tail: number, amp: number, push: number, disk: boolean, mul: boolean, trough: number) {
    if (this.fn >= MAX_FRONTS) return;
    const o = this.fn++ * FS;
    const pf = this.pf;
    pf[o] = cx;
    pf[o + 1] = cy;
    pf[o + 2] = r;
    pf[o + 3] = lead;
    pf[o + 4] = tail;
    pf[o + 5] = amp;
    pf[o + 6] = this.lite ? 0 : push;
    pf[o + 7] = disk ? 1 : 0;
    pf[o + 8] = mul ? 1 : 0;
    pf[o + 9] = trough;
  }

  /**
   * The beats as this frame's fronts. Shapes are tuned in field heights, so a wave looks the same
   * on any stage; it always runs out past the farthest corner from where it started.
   */
  private planBeats(now: number, aspect: number) {
    this.fn = 0;
    let lift = 0;
    for (let i = this.beats.length - 1; i >= 0; i--) {
      const b = this.beats[i];
      const u = (now - b.t0) / BEAT_MS[b.kind];
      if (u >= 1 || u < -0.05) {
        this.beats.splice(i, 1);
        continue;
      }
      if (u < 0) continue;
      const cx = b.x * aspect;
      const cy = b.y;
      const fx = Math.max(cx, aspect - cx);
      const fy = Math.max(cy, 1 - cy);
      const far = Math.sqrt(fx * fx + fy * fy);
      const s = b.s;
      if (b.kind === 'send' || b.kind === 'pulse') {
        // The crest decelerates as it spreads (fast off the key, gliding out past the edges), thins
        // with distance like a ring on water, and widens behind as it goes.
        const e = 1 - (1 - u) ** 1.8;
        const r = 0.02 + e * far * 1.08;
        const env = (u < 0.04 ? u / 0.04 : 1) * (1 - sstep(0.35, 1, u));
        const amp = (s * env * (b.kind === 'send' ? 1 : 0.62)) / (1 + 0.3 * r);
        const lead = 0.014 + 0.026 * e;
        const tail = 0.06 + 0.2 * e;
        // Bends the pattern by up to ~7% of the field's height at the crest.
        this.front(cx, cy, r, lead, tail, amp, 0.07, false, false, 0.34);
        lift += amp;
        // A weaker echo rides behind the crest.
        if (u > 0.07 && !this.lite) this.front(cx, cy, r * 0.62, lead * 1.4, tail * 0.8, amp * 0.36, 0.012, false, false, 0.2);
        // The key flashes as the wave leaves it.
        if (b.kind === 'send' && u < 0.2) {
          const f = 1 - u / 0.2;
          this.front(cx, cy, 0.015 + 0.06 * (u / 0.2), 0.07, 0, s * 1.15 * f * f, 0, true, false, 0);
        }
      } else if (b.kind === 'done') {
        // The turn settles: one wide, nearly flat crest of light comes down through the band from
        // above its top and lands on the point (the composer's top edge), across the whole width,
        // so it is seen beside and above the composer rather than behind it. It is the top of a
        // very large ring centred far below the point, so it bows gently, its ends a little ahead.
        // It decelerates as it lands, and the light there swells once and fades.
        const R = Math.max(3, aspect * 1.6);
        const travel = cy + 0.2;
        const e = 1 - (1 - u) ** 2.4;
        const r = R + travel * (1 - e);
        const env = (u < 0.08 ? u / 0.08 : 1) * (1 - sstep(0.62, 1, u));
        const amp = s * 1.25 * env;
        // The soft side trails above, the crisp side leads below.
        this.front(cx, cy + R, r, 0.26, 0.06, amp, -0.02, false, false, 0.22);
        lift += amp * 0.5;
        if (u > 0.55) {
          const q = Math.sin((Math.PI * (u - 0.55)) / 0.45);
          this.front(cx, cy, 0.08 + 0.1 * q, 0.22, 0, s * 0.32 * q, 0, true, false, 0);
        }
      } else {
        // fail: the light dips, the dimming spreading from the point within a third of the beat,
        // then recovers slowly. Multiplied, so dark stays dark.
        const g = Math.min(1, u / 0.3);
        const r = 0.04 + (1 - (1 - g) ** 3) * far * 1.05;
        const env = u < 0.07 ? u / 0.07 : (1 - (u - 0.07) / 0.93) ** 1.7;
        this.front(cx, cy, r, 0.4, 0, -0.52 * Math.min(1, s) * env, 0, true, true, 0);
      }
    }
    this.lift = lift > 1 ? 1 : lift;
  }

  /**
   * The beats at (px, py): light to add (`wadd`), a factor (`wmul`) and how far to push the
   * pattern (`wdx`, `wdy`, in field units). Only called while a beat is live.
   */
  private wave(px: number, py: number) {
    const pf = this.pf;
    let add = 0;
    let mul = 1;
    let dx = 0;
    let dy = 0;
    for (let o = 0, end = this.fn * FS; o < end; o += FS) {
      const ox = px - pf[o];
      const oy = py - pf[o + 1];
      const d2 = ox * ox + oy * oy;
      const r = pf[o + 2];
      const lead = pf[o + 3];
      const outer = r + lead;
      if (d2 > outer * outer) continue;
      if (pf[o + 7] !== 0) {
        // A soft disk: full inside, its edge falling away over `lead`.
        let f = 1;
        if (d2 > r * r) {
          const q = 1 - (Math.sqrt(d2) - r) / lead;
          f = q * q;
        }
        if (pf[o + 8] !== 0) mul *= 1 + pf[o + 5] * f;
        else add += pf[o + 5] * f;
        continue;
      }
      const tail = pf[o + 4];
      const trough = pf[o + 9];
      const inner = r - tail * (trough > 0 ? 1.75 : 1);
      if (inner > 0 && d2 < inner * inner) continue;
      const d = Math.sqrt(d2);
      const sd = d - r;
      let crest = 0;
      let low = 0;
      if (sd >= 0) {
        const q = 1 - sd / lead;
        crest = q * q;
      } else {
        const q = -sd / tail;
        if (q < 1) crest = (1 - q) * (1 - q) * (1 - q);
        // Behind the crest the light thins for a moment: the trough that makes the crest read.
        if (trough > 0 && q > 0.55 && q < 1.75) low = trough * fcos(((q - 1.15) / 1.2) * Math.PI);
      }
      const amp = pf[o + 5];
      add += amp * (crest - low);
      const push = pf[o + 6] * amp * crest;
      if (push !== 0 && d > 1e-4) {
        dx += (ox / d) * push;
        dy += (oy / d) * push;
      }
    }
    this.wadd = add;
    this.wmul = mul;
    this.wdx = dx;
    this.wdy = dy;
  }

  /**
   * The part of row `py` that can be lit, as px from out[0] to out[1] (empty when out[0] > out[1]).
   * Outside it the light has fallen to nothing, so those cells are ground and are not evaluated.
   */
  span(py: number, out: Float32Array) {
    if (this.reach === Infinity) {
      out[0] = -1e9;
      out[1] = 1e9;
      // The spot leaves everything past its radius dark (unless it blends into even light).
      if (this.spotOn && this.spEven <= 0) {
        const dy = py - this.spY;
        const r2 = this.spR * this.spR - dy * dy;
        if (r2 <= 0) {
          out[0] = 1;
          out[1] = 0;
          return;
        }
        const r = Math.sqrt(r2);
        out[0] = (this.spX - r) * this.aspect;
        out[1] = (this.spX + r) * this.aspect;
      }
      return;
    }
    const dy = py - this.fy;
    const r2 = this.reach * this.reach - dy * dy;
    if (r2 <= 0) {
      out[0] = 1;
      out[1] = 0;
      return;
    }
    const r = Math.sqrt(r2);
    out[0] = this.fx - r;
    out[1] = this.fx + r;
  }

  /** Writes the colour (rgb in 0..1) into out[0..2] and the light level (0 = unlit) into out[3]. */
  shade(px: number, py: number, out: Float32Array) {
    // One small method per variant: each stays monomorphic and cheap for the JIT.
    const mode = this.mode;
    this.hue = 0;
    if (this.fn !== 0) {
      // A passing crest bends the pattern: it is read from a little closer to the beat's origin,
      // so the streaks and tiles visibly ripple outward with the light.
      this.wave(px, py);
      px -= this.wdx;
      py -= this.wdy;
    }
    let w = 1;
    if (this.spotOn) {
      w = this.spotAt(px, py);
      if (w <= 0) {
        // Past the spot: ground, without evaluating the pattern.
        out[0] = this.lut[0];
        out[1] = this.lut[1];
        out[2] = this.lut[2];
        out[3] = 0;
        return;
      }
    }
    const v = this.overlay > 0 && (this.flat || this.px)
      ? this.overlaid(this.flat ? 0.62 : this.image(px, py), px, py)
      : this.flat
      ? 0.62
      : this.px
        ? this.image(px, py)
      : mode === 'streaks'
        ? this.streaks(px, py)
        : mode === 'tubes'
          ? this.tubes(px, py)
          : mode === 'tiles'
            ? this.tiles(px, py)
            : this.broad(px, py);
    this.finish(v, px, py, out, w);
  }

  /** How much of the light the spot lets through at (px, py): 1 at its centre, 0 past its reach. */
  private spotAt(px: number, py: number): number {
    const dx = px / this.aspect - this.spX;
    const dy = py - this.spY;
    const d = Math.sqrt(dx * dx + dy * dy);
    // A glow: brightest at the centre and thinning out all the way to the edge (no flat top, no rim).
    const u = d <= this.spIn ? 0 : d >= this.spR ? 1 : (d - this.spIn) / (this.spR - this.spIn);
    const q = 1 - u * u;
    const f = this.shaping ? q * (q + (1 - q) * this.shaping.softness) : q * q;
    return f + (1 - f) * this.spEven;
  }

  /**
   * The moving pattern as light over an image's brightness `v`: the image steps back a little and
   * the pattern lifts it where it passes, brightest over the image's own light.
   */
  private overlaid(v: number, px: number, py: number): number {
    // The pattern is read from a grid at half the cell rows, each node worked out once per frame
    // and interpolated between (as the soft variants draw themselves), so the light over an image
    // costs about what the pattern alone does.
    const rows = this.cellRows > 0 ? Math.max(8, Math.ceil(this.cellRows / 2)) : 96;
    const cols = Math.ceil(this.aspect * rows) + 3;
    const n = (rows + 3) * cols;
    if (this.ogRows !== rows || this.ogCols !== cols) {
      this.ogRows = rows;
      this.ogCols = cols;
      if (this.og.length < n) {
        this.og = new Float32Array(n);
        this.ogStamp = new Uint32Array(n);
      } else this.ogStamp.fill(0);
    }
    let gx = px * rows;
    let gy = py * rows;
    gx = gx < 0 ? 0 : gx > cols - 2 ? cols - 2 : gx;
    gy = gy < 0 ? 0 : gy > rows + 1 ? rows + 1 : gy;
    const i = gx | 0;
    const j = gy | 0;
    const tx = gx - i;
    const ty = gy - j;
    const a = this.ogAt(i, j, rows, cols);
    const b = this.ogAt(i + 1, j, rows, cols);
    const c = this.ogAt(i, j + 1, rows, cols);
    const d = this.ogAt(i + 1, j + 1, rows, cols);
    const top = a + (b - a) * tx;
    const p = top + (c + (d - c) * tx - top) * ty;
    const k = this.overlay;
    return v * (1 - 0.35 * k) + k * (p > 0 ? p : 0) * (0.3 + 0.7 * v);
  }

  /** The pattern at grid node (i, j) this frame (see `overlaid`). */
  private ogAt(i: number, j: number, rows: number, cols: number): number {
    const idx = j * cols + i;
    if (this.ogStamp[idx] === this.ogFrame) return this.og[idx];
    const x = i / rows;
    const y = j / rows;
    const mode = this.mode;
    const p = mode === 'streaks' ? this.streaks(x, y) : mode === 'tubes' ? this.tubes(x, y) : mode === 'tiles' ? this.tiles(x, y) : this.broad(x, y);
    this.og[idx] = p;
    this.ogStamp[idx] = this.ogFrame;
    return p;
  }

  /** An image with a moving effect over it. */
  get overlaying() {
    return this.overlay > 0 && this.imageSrc != null;
  }

  /** Rows of cells the renderer draws this frame (sets the overlay grid's spacing; 0 unknown). */
  cellRows = 0;
  private og = new Float32Array(0);
  private ogStamp = new Uint32Array(0);
  private ogFrame = 1;
  private ogRows = 0;
  private ogCols = 0;

  /** An image's brightness, with a slow drift of the threshold so a moving field is never quite still. */
  private image(px: number, py: number): number {
    const P = this.px!;
    // Zoomed in a little, so the pointer can shift it without showing an edge.
    let u = 0.5 + (px / this.aspect - 0.5) * 0.95 - this.par[0] * 0.6;
    let v = 0.5 + (py - 0.5) * 0.95 - this.par[1] * 0.6;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const fx = u * (P.w - 1);
    const fy = v * (P.h - 1);
    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = x0 + 1 < P.w ? x0 + 1 : x0;
    const y1 = y0 + 1 < P.h ? y0 + 1 : y0;
    const tx = fx - x0;
    const ty = fy - y0;
    const a = y0 * P.w + x0;
    const b = y0 * P.w + x1;
    const c = y1 * P.w + x0;
    const d = y1 * P.w + x1;
    const L = P.lum;
    const top = L[a] + (L[b] - L[a]) * tx;
    const lum = top + (L[c] + (L[d] - L[c]) * tx - top) * ty;
    if (this.imgColour) {
      const R = P.rgb;
      const mix = (j: number) => {
        const t0 = R[a * 3 + j] + (R[b * 3 + j] - R[a * 3 + j]) * tx;
        return t0 + (R[c * 3 + j] + (R[d * 3 + j] - R[c * 3 + j]) * tx - t0) * ty;
      };
      this.ir = mix(0);
      this.ig = mix(1);
      this.ib = mix(2);
    }
    this.ilum = lum;
    const t = this.t;
    const n = sample(this.A, px * 0.32 + t * 0.012 + this.sd, py * 0.32 - t * 0.009);
    return lum * (0.84 + 0.32 * n);
  }

  private streaks(px: number, py: number): number {
    const A = this.A;
    const B = this.B;
    const t = this.t;
    const sd = this.sd;
    let v: number;
    // Long soft bands of light along a diagonal, like a slow exposure of sunlit leaves: two
    // stretched noise layers of different widths, drifting along the streak, under a broad
    // light that is brightest toward the top right and leaves dark pockets.
    let a = px * this.sc - py * this.ss;
    let c = px * this.ss + py * this.sc;
    const shape = this.shaping;
    if (shape) {
      a -= this.par[0] * this.aspect;
      c = (c + shape.amplitude * fcos(a * 2.9 - t * 0.63)) * shape.scale - this.par[1];
    }
    const drift = t * 0.011;
    const n1 = sample(A, a * 0.045 + drift + sd, c * 0.42);
    const n2 = sample(B, a * 0.085 + drift * 1.7, c * 1.25 + 0.37);
    const n3 = sample(A, a * 0.16 - drift * 0.6 + 0.5, c * 2.2 + sd);
    const bands = shape
      ? n1 * (0.6 + 0.12 * shape.softness) + n2 * (0.42 - 0.09 * shape.softness) + n3 * (0.16 - 0.1 * shape.softness)
      : n1 * 0.6 + n2 * 0.42 + n3 * 0.16;
    const lit = sstep(0.22, 0.82, bands);
    const L = sample(B, px * 0.16 + sd * 0.5 + t * 0.0016, py * 0.16 - t * 0.0012);
    const corner = (px / this.aspect) * 0.55 + (1 - py) * 0.45;
    v = lit * (0.5 + 0.6 * sstep(0.25, 0.75, L)) * (0.38 + 0.95 * corner) * this.breath;
    this.hue = a * 0.12 + n1 * 0.6 + t * 0.006;
    return v;
  }

  private tubes(px: number, py: number): number {
    const A = this.A;
    const t = this.t;
    const sd = this.sd;
    const full = this.full;
    let v: number;
    if (!full) {
      // Tubes never get brighter than ~1.7: where the falloff keeps even that under the floor, it is ground.
      const dx = px - this.fx;
      const dy = py - this.fy;
      if ((1 - sstep(0.12, TUBE_REACH, Math.sqrt(dx * dx + dy * dy))) * this.gainNow * 1.7 < 0.09) return 0;
    }
    // A grid of glowing tubes seen from above. Each leans away from the vanishing point,
    // more so the further out it stands. A wave of light travels across the grid along a
    // slowly turning direction: the rims catch it first, then the bores fill.
    const g = this.tubeG;
    const ix = Math.floor(px / g);
    const iy = Math.floor(py / g);
    const cx = (ix + 0.5) * g;
    const cy = (iy + 0.5) * g;
    if (ix !== this.ci || iy !== this.cj) {
      this.ci = ix;
      this.cj = iy;
      const ox = cx - this.vx;
      const oy = cy - this.vy;
      const od = Math.sqrt(ox * ox + oy * oy) || 1;
      const lean = Math.min(0.3, od * (full ? 0.22 : 0.34)) * g;
      this.c0 = (ox / od) * lean;
      this.c1 = (oy / od) * lean;
      const ph = ((cx * this.wc + cy * this.ws) / g) * this.waveK - t * this.waveW;
      const body = 0.5 + 0.5 * Math.cos(ph);
      const rim = 0.5 + 0.5 * Math.cos(ph - 0.75);
      const n = sample(A, ix * 0.07 + t * 0.03 + sd, iy * 0.07 - t * 0.022);
      if (full) {
        // A calm sweep: softer peaks, so the whole grid glows and the wave passes through it.
        this.c2 = 0.42 + 0.36 * n + 0.6 * body * body;
        this.c3 = 0.6 + 0.26 * n + 0.5 * rim * rim;
      } else {
        this.c2 = 0.34 + 0.4 * n + 0.95 * body * body * body;
        this.c3 = 0.52 + 0.28 * n + 0.8 * rim * rim * rim;
      }
      this.c4 = ix * 0.045 + iy * 0.03 + t * 0.045 + n * 0.5;
    }
    const lx = this.c0;
    const ly = this.c1;
    const R = g * 0.4;
    const rimW = g * 0.07;
    const tx = px - (cx + lx);
    const ty = py - (cy + ly);
    const dTop2 = tx * tx + ty * ty;
    const bx = px - cx;
    const by = py - cy;
    const ll = lx * lx + ly * ly || 1e-6;
    let u = (bx * lx + by * ly) / ll;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const ex = bx - lx * u;
    const ey = by - ly * u;
    const dBody2 = ex * ex + ey * ey;
    // Squared distances decide the region; a root is taken only where a distance is needed.
    const Ri = R - rimW;
    let depth = 0;
    if (dTop2 < Ri * Ri) {
      // Looking down the bore: its floor sits toward the vanishing point.
      const hx = px - (cx - lx * 0.9);
      const hy = py - (cy - ly * 0.9);
      const dh = Math.sqrt(hx * hx + hy * hy) / R;
      const lum = 0.05 + 0.82 * sstep(0.2, 1.25, dh);
      depth = 1 - lum;
      v = lum * this.c2;
    } else if (dTop2 < R * R) {
      v = this.c3;
    } else if (dBody2 < R * R) {
      v = (0.2 + 0.5 * u) * this.c2;
      depth = 0.8 - 0.8 * u;
    } else {
      // The halo, spent after a few decay lengths.
      const m2 = dTop2 < dBody2 ? dTop2 : dBody2;
      // Past this the halo is under the floor anyway (sooner on a full stage, where it is dimmer): skip the exp.
    const far = R + g * (full ? 0.14 : 0.3);
      v = m2 > far * far ? 0 : 0.2 * Math.exp(-(Math.sqrt(m2) - R) / (g * 0.09)) * this.c2;
    }
    this.hue = this.c4 + depth * 0.16;
    return v;
  }

  private tiles(px: number, py: number): number {
    const B = this.B;
    const t = this.t;
    const sd = this.sd;
    const full = this.full;
    const fy = this.fy;
    let v: number;
    // Softly rounded frosted keys on a plane seen at a slight angle, lit from underneath by
    // two lights that glide about: faces glow, and the edges facing a light catch it.
    // Everything that depends only on the row is worked out once per row.
    if (py !== this.ry) {
      this.ry = py;
      const H = TILE_H + (this.vy - fy) * 2;
      this.rh = H;
      this.riz = (1 / (py - H)) * TILE_SU;
      const w = TILE_SV / (py - H);
      this.riv = Math.floor(w);
      // Rows run up the screen as w grows, so screen-down within a tile is -w.
      this.rlv = this.riv + 0.5 - w;
    }
    const H = this.rh;
    const iv = this.riv;
    const lv = this.rlv;
    const u = (px - this.vx) * this.riz;
    const iu = Math.floor(u);
    if (iu !== this.ci || iv !== this.cj) {
      this.ci = iu;
      this.cj = iv;
      // The tile's centre on screen.
      const cyy = TILE_SV / (iv + 0.5);
      const cy = cyy + H;
      const cx = this.vx + ((iu + 0.5) * cyy) / TILE_SU;
      const ax = this.l1x - cx;
      const ay = this.l1y - cy;
      const bx = this.l2x - cx;
      const by = this.l2y - cy;
      const a2 = ax * ax + ay * ay;
      const b2 = bx * bx + by * by;
      // A full stage spreads the lights wide, so every key is lit and the lights are broad swells.
      const ia = full ? Math.exp(-a2 / 0.3) : Math.exp(-a2 / 0.12);
      const ib = full ? 0.8 * Math.exp(-b2 / 0.24) : 0.65 * Math.exp(-b2 / 0.07);
      const n = sample(B, iu * 0.13 + sd, iv * 0.13 + t * 0.012);
      // Every key glows a little; the lights passing underneath make it bloom.
      this.c2 = ((full ? 0.42 : 0.32) + ia + ib) * (0.8 + 0.45 * n);
      // Direction toward the light, weighted by how much each light gives.
      const la = Math.sqrt(a2) || 1;
      const lb = Math.sqrt(b2) || 1;
      const mx = (ax / la) * ia + (bx / lb) * ib;
      const my = (ay / la) * ia + (by / lb) * ib;
      const ml = Math.sqrt(mx * mx + my * my) || 1;
      this.c5 = mx / ml;
      this.c6 = my / ml;
      this.c4 = iu * 0.05 + iv * 0.045 + t * 0.06 + n * 0.35;
    }
    const lu = u - iu - 0.5;
    const qx = Math.abs(lu) - (TILE_HALF - TILE_R);
    const qy = Math.abs(lv) - (TILE_HALF - TILE_R);
    const ox = qx > 0 ? qx : 0;
    const oy = qy > 0 ? qy : 0;
    const d = Math.sqrt(ox * ox + oy * oy) + Math.min(qx > qy ? qx : qy, 0) - TILE_R;
    const I = this.c2;
    if (d > 0) {
      // The gap: dark, with a thin halo where light leaks past the edge.
      v = d > (full ? 0.05 : 0.1) ? 0 : I * 0.22 * Math.exp(-d / 0.035);
    } else {
      // Frosted face, brighter on the side toward the light.
      const toward = lu * this.c5 + lv * this.c6;
      v = I * (0.44 + 0.34 * toward);
      if (d > -TILE_RIM) {
        // The edge, catching the light where it faces it.
        const facing = toward > 0 ? toward / (Math.sqrt(lu * lu + lv * lv) || 1) : 0;
        const e = 1 + d / TILE_RIM;
        v += I * e * e * (0.3 + facing);
      }
    }
    this.hue = this.c4;
    return v;
  }

  /** The broad fields: bloom, streak (the session's floor of light) and aurora. */
  private broad(px: number, py: number): number {
    const A = this.A;
    const B = this.B;
    const t = this.t;
    const sd = this.sd;
    const full = this.full;
    const mode = this.mode;
    const dx = px - this.fx;
    const dy = py - this.fy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    let v: number;
    if (mode === 'bloom') {
      const ang = Math.atan2(dy, dx);
      const wob = sample(A, dx * 0.42 + sd + t * 0.008, dy * 0.42 + t * 0.006);
      const petals = 0.5 + 0.5 * Math.cos(ang * 5 + t * 0.07 + wob * 5.2);
      const shape = 1 - sstep(0, 0.6, dist - 0.16 - 0.36 * petals);
      const core = 1 - sstep(0, 0.42, dist);
      const grain = sample(B, px * 0.6 - t * 0.01, py * 0.6 + sd);
      v = shape * (0.34 + 0.6 * grain) + core * 0.3;
    } else if (mode === 'streak') {
      const qx = (px * STREAK_COS - py * STREAK_SIN) * 0.085 + sd;
      const qy = (px * STREAK_SIN + py * STREAK_COS) * 0.9;
      const n = sample(A, qx + t * 0.011, qy);
      const n2 = sample(B, qx * 0.5 - t * 0.007, qy * 2.3 + 0.31);
      // Over a floor: the horizon's edge stays one line, and the noise breaks its brightness, not its shape.
      v = 0.62 + 0.38 * sstep(0.3, 0.74, n * 0.62 + n2 * 0.46);
      if (this.shaping) {
        const { scale, spread } = this.shaping;
        const phase = (qy * (0.7 + spread) + qx * (1 - spread)) * scale * 8 + this.bend * 6;
        v *= 0.84 + 0.16 * fcos(phase);
      }
    } else {
      const shape = this.shaping;
      const qx = shape ? (px - this.par[0] * this.aspect) * 0.3 * shape.scale + sd : px * 0.3 + sd;
      const qy = shape ? (py - this.par[1] + this.bend) * 0.3 * shape.scale : py * 0.3;
      const w1 = sample(A, qx, qy + t * 0.008);
      const w2 = sample(B, qx + 0.52, qy - t * 0.006);
      const n = sample(A, qx + w1 * 0.42 + t * 0.004, qy + w2 * 0.42);
      // La distribución mezcla el campo extendido con bolsas de luz más concentradas.
      // A full stage keeps a faint floor of light everywhere, so no part of it goes empty.
      v = full ? 0.24 + 0.62 * sstep(shape ? 0.22 + 0.22 * shape.spread : 0.22, 0.76, n) : sstep(0.34, 0.72, n);
    }
    return v;
  }

  /**
   * The session's horizon (the streak's falloff): the edge of a wide circle that crests at the
   * middle of the band, where the composer's top edge is, and sinks to the stage's lower corners.
   * Brightest on the edge itself, a glow that thins out above it, a dim ground below it; all of it
   * strongest under the composer and fading towards the sides. The streak's noise is multiplied
   * into it, so the line is drawn in broken dither, not as a stroke.
   */
  private horizon(px: number, py: number): number {
    const a = this.aspect * 0.5;
    const r = (a * a + HORIZON_SAG * HORIZON_SAG) / (2 * HORIZON_SAG);
    const ex = px - a;
    const ey = py - HORIZON_APEX - r;
    // Above the edge: positive.
    const d = Math.sqrt(ex * ex + ey * ey) - r;
    const side = ex / a;
    const reach = 1 - 0.74 * side * side;
    if (reach <= 0) return 0;
    if (d >= 0) {
      const g = 1 - d / HORIZON_GLOW;
      return g <= 0 ? 0 : g * g * 0.8 * reach;
    }
    const k = -d / HORIZON_RIM;
    return (k >= 1 ? HORIZON_GROUND : 1 - (1 - HORIZON_GROUND) * k * k * (3 - 2 * k)) * reach;
  }

  /** Falloff (or, full bleed, the sweep, hollow and roll-off), the floor, the palette and the spectrum's hues. */
  private finish(v: number, px: number, py: number, out: Float32Array, spot = 1) {
    const lut = this.lut;
    const img = this.px != null || this.flat;
    // A crest or the pointer's light can light even an unlit cell of a full stage.
    const lit = this.full && ((this.fn !== 0 && this.wadd > 0) || this.lI > 0);
    if (v <= 0 && !lit) {
      // Unlit (the gaps between tubes and tiles): ground, with nothing more to work out.
      out[0] = lut[0];
      out[1] = lut[1];
      out[2] = lut[2];
      out[3] = 0;
      return;
    }
    const B = this.B;
    const t = this.t;
    const sd = this.sd;
    const full = this.full;
    const mode = this.mode;
    const hue = this.hue;
    const dx = px - this.fx;
    const dy = py - this.fy;
    const dist = full ? 0 : Math.sqrt(dx * dx + dy * dy);
    if (full) {
      // Even light edge to edge. A long, slow sweep crosses the stage (tubes carry their own wave),
      // and a soft, wide hollow behind the centre column keeps the headline and composer on calm ground.
      // An image keeps its own light: no sweep, a shallower hollow and a higher knee.
      if (mode !== 'tubes' && !img) {
        const sweep = 0.5 + 0.5 * fcos((px * this.wc + py * this.ws) * 2.2 - t * 0.55);
        v *= mode === 'streaks' ? 0.84 + 0.22 * sweep : 0.74 + 0.36 * sweep;
      }
      if (py !== this.hy) {
        this.hy = py;
        const ey = (py - HOLLOW_Y) / HOLLOW_RY;
        this.hq = ey * ey;
      }
      const ex = (px - this.aspect * 0.5) / HOLLOW_RX;
      const q = ex * ex + this.hq;
      // A spot already keeps light off most of the stage, so the hollow eases off with it.
      const hollow = this.hollowK * (img ? 0.6 : 1) * (this.spotOn ? 0.35 + 0.65 * this.spEven : 1);
      v *= (1 - hollow / (1 + q * q)) * (img ? this.gainNow * 1.15 : this.fullK);
      const knee = img ? 0.72 : KNEE;
      if (v > knee) {
        const x = v - knee;
        v = knee + x / (1 + x / ROLL);
      }
      if (v < 0) v = 0;
      // The pointer's light: a broad, faint lift that trails the pointer.
      if (this.lI > 0) {
        const ex2 = px - this.lx;
        const ey2 = py - this.ly;
        const q = 1 - (ex2 * ex2 + ey2 * ey2) / (LIGHT_R * LIGHT_R);
        if (q > 0) v += this.lI * q * q * (0.45 + v);
      }
      // A beat lifts what it passes, lit cells most (and may push past the knee for its moment), or dims it.
      if (this.fn !== 0) {
        const k = this.wadd * this.react;
        if (k !== 0) v += k * (0.18 + 0.6 * v);
        if (v < 0) v = 0;
        // Past the light stop the crest bends over, so it never goes white.
        else if (v > 0.68) v = 0.68 + (v - 0.68) / (1 + (v - 0.68) / 0.14);
        v *= this.wmul;
      }
    } else {
      // Light falls away from the focus, leaving a dark ground for text.
      // Tubes and tiles fade out completely with distance so they never sit behind the reading area.
      // A streak is the session's horizon: an arc of light that crests under the composer.
      const fall =
        mode === 'tubes'
          ? 1 - sstep(0.12, TUBE_REACH, dist)
          : mode === 'tiles'
            ? 1 - sstep(0.18, TILE_REACH, dist)
            : mode === 'streak'
              ? this.horizon(px, py)
              : 0.1 + 0.9 * (1 - sstep(0.05, 1.3, dist));
      v *= fall * this.gainNow;
      // The band under the dock lifts as a whole while a front crosses it, most where the front is,
      // and the crest itself shows as a line of light travelling along the band.
      if (this.fn !== 0) {
        const k = this.react;
        const v0 = v;
        v = (v * (1 + k * (0.35 * this.lift + 1.1 * this.wadd)) + k * 0.6 * this.wadd * fall * this.gainNow) * this.wmul;
        if (v < 0) v = 0;
        // The crest bends over before the palette's pale end, so it reads as light, not as grey.
        else if (v > v0 && v > 0.6) v = Math.max(v0, 0.6 + (v - 0.6) / (1 + (v - 0.6) / 0.12));
      }
    }
    // The spot's falloff, before the floor and quantization, so its edge dithers away like the rest.
    v *= spot;
    if (this.shaping) {
      const { brightness, contrast } = this.shaping;
      v = Math.max(0, 0.23 + (v - 0.23) * contrast) * brightness * Math.min(1, v * 8);
    }
    // A floor, so the dark side is clean ground rather than a scatter of stray cells.
    v = v < 0.09 ? 0 : (v - 0.09) * 1.099;
    if (this.px && this.imgColour) {
      // The image's own colour at this point, scaled by what happened to its brightness.
      const k = v <= 0 ? 0 : Math.min(1.6, v / (this.ilum > 0.03 ? this.ilum : 0.03));
      out[0] = lut[0] + (this.ir - lut[0]) * k;
      out[1] = lut[1] + (this.ig - lut[1]) * k;
      out[2] = lut[2] + (this.ib - lut[2]) * k;
      out[3] = v;
      return;
    }
    const vi = v <= 0 ? 0 : v >= 1 ? 765 : ((v * 255) | 0) * 3;
    let r = lut[vi];
    let g = lut[vi + 1];
    let b = lut[vi + 2];

    const spectrum = img ? 0 : this.spectrum;
    if (spectrum > 0.01 && v > 0) {
      const hueAt =
        mode === 'tubes' || mode === 'tiles' || mode === 'streaks'
          ? hue
          : sample(B, px * 0.21 + sd + t * 0.003, py * 0.21) * 1.7 + px * 0.22 - py * 0.2 + t * 0.008;
      const mix = sstep(0.1, 0.6, v) * (full ? 0.72 : 0.9) * spectrum;
      const lum = 0.14 + v * 1.05;
      const hi = (((hueAt - Math.floor(hueAt)) * HUE_N) | 0) * 3;
      r += (HUES[hi] * lum - r) * mix;
      g += (HUES[hi + 1] * lum - g) * mix;
      b += (HUES[hi + 2] * lum - b) * mix;
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    out[3] = v;
  }
}

// ── layout (shared with the host, so it can size the canvas element to match) ──

/** Above this many cells a dither stage gets coarser cells: the frame cost stays flat on big screens. */
const MAX_CELLS = 52_000;

export function ditherLayout(width: number, height: number, cell: number, dpr = 1) {
  let requested = cell;
  let c = Math.round(requested * dpr) / dpr;
  let cols = Math.max(2, Math.ceil(width / c));
  let rows = Math.max(2, Math.ceil(height / c));
  while (cols * rows > MAX_CELLS && requested < 24) {
    c = Math.round(++requested * dpr) / dpr;
    cols = Math.max(2, Math.ceil(width / c));
    rows = Math.max(2, Math.ceil(height / c));
  }
  return { cell: c, cols, rows };
}

/** Glyph cell in CSS px (Geist Mono advances ~0.6em, so 12.5px type fills an 8px column). */
const GLYPH_W = 8;
const GLYPH_H = 14;
const GLYPH_FONT = 12.5;
/** Above this stage area (CSS px²) glyphs grow by a quarter: big screens get fewer, larger characters. */
const GLYPH_BIG_AREA = 1.5e6;
/** Dark to bright. Index 0 is never drawn. */
export const RAMP = ' .·:-=+*xo#%@';

/** The dither cell the glyph size is judged against: at this cell, glyphs are their default size. */
const GLYPH_REF_CELL = 5;

/** `cell` (the dither cell asked for) scales the glyphs: finer cells, smaller characters. */
export function asciiLayout(width: number, height: number, dpr: number, cell = GLYPH_REF_CELL) {
  const d = Math.min(3, Math.max(0.75, dpr || 1));
  // Whole device pixels per cell keep every glyph on the pixel grid: crisp at any ratio.
  const k = Math.min(2.4, Math.max(0.8, cell / GLYPH_REF_CELL));
  const s = (width * height > GLYPH_BIG_AREA ? 1.25 : 1) * k;
  const gw = Math.round(GLYPH_W * s * d);
  const gh = Math.round(GLYPH_H * s * d);
  return { dpr: d, font: GLYPH_FONT * s, cols: Math.max(2, Math.ceil(width * d / gw)), rows: Math.max(2, Math.ceil(height * d / gh)), gw, gh };
}

/** At most this many dots: each is a blit when it changes, like a glyph. */
const MAX_DOTS = 9000;

/** Halftone: square cells a little larger than the dither cell, sized in whole device pixels. */
export function halftoneLayout(width: number, height: number, dpr: number, cell: number) {
  // El lienzo y su máscara comparten resolución. Acota la memoria en pantallas grandes/HiDPI.
  const rasterBudget = Math.max(0.5, Math.sqrt(2_100_000 / Math.max(1, width * height)));
  const d = Math.min(2, Math.max(0.5, dpr || 1), rasterBudget);
  let c = Math.max(5, cell * 1.6);
  let g = Math.round(c * d);
  let cols = Math.max(2, Math.ceil(width * d / g));
  let rows = Math.max(2, Math.ceil(height * d / g));
  while (cols * rows > MAX_DOTS) {
    g = Math.round(++c * d);
    cols = Math.max(2, Math.ceil(width * d / g));
    rows = Math.max(2, Math.ceil(height * d / g));
  }
  return { dpr: d, cols, rows, gw: g, gh: g };
}

/** The soft image's canvas resolution: about one device pixel per CSS pixel, capped. */
export function softImageLayout(width: number, height: number, dpr: number) {
  const k = Math.min(1.25, Math.max(0.5, dpr || 1), 1600 / Math.max(1, width));
  return { w: Math.max(2, Math.round(width * k)), h: Math.max(2, Math.round(height * k)) };
}

/**
 * How big the host should make the canvas element (CSS px) for a texture, and for glyphs the
 * atlas it must draw and send.
 */
export function fieldLayout(texture: DitherTexture, image: boolean, width: number, height: number, dpr: number, cell: number): { cssW: number; cssH: number; cell: number; atlas?: { gw: number; gh: number; dpr: number; font: number } } {
  if (texture === 'soft' && image) return { cssW: width, cssH: height, cell };
  if (texture === 'dots') {
    const L = dotsLayout(width, height, dpr, cell);
    return { cssW: L.cssW, cssH: L.cssH, cell: L.g / L.d };
  }
  if (texture === 'ascii') {
    const L = asciiLayout(width, height, dpr, cell);
    return { cssW: (L.cols * L.gw) / L.dpr, cssH: (L.rows * L.gh) / L.dpr, cell, atlas: { gw: L.gw, gh: L.gh, dpr: L.dpr, font: L.font } };
  }
  if (texture === 'halftone') {
    const L = halftoneLayout(width, height, dpr, cell);
    return { cssW: (L.cols * L.gw) / L.dpr, cssH: (L.rows * L.gh) / L.dpr, cell: L.gw / L.dpr };
  }
  const L = ditherLayout(width, height, cell, dpr);
  return { cssW: L.cols * L.cell, cssH: L.rows * L.cell, cell: L.cell };
}

// ── renderers ──

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Source = CanvasImageSource;

function context(el: Surface, opts?: CanvasRenderingContext2DSettings): Ctx | null {
  return (el as HTMLCanvasElement).getContext('2d', opts) as Ctx | null;
}

function scratch(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

interface Renderer {
  resize(m: Metrics): void;
  /** False when nothing could be drawn yet (glyphs before their atlas arrives). */
  draw(field: Field, look: Look, now: number): boolean;
  setAtlas?(atlas: Source): void;
  setImage?(image: ImageSource | null): void;
}

type ImageSource = CanvasImageSource & { width: number; height: number };

const LEVELS = 4;
const NONE: [number, number] = [1, 0];
const FULL_ROW: [number, number] = [0, 1e9];

/** The first and last column of a `cols`-wide row that the light can reach (none when first > last). */
function litColumns(field: Field, py: number, aspect: number, cols: number, sp: Float32Array): [number, number] {
  field.span(py, sp);
  if (sp[0] > sp[1]) return NONE;
  const a = Math.ceil((sp[0] / aspect) * cols - 0.5);
  const b = Math.floor((sp[1] / aspect) * cols - 0.5);
  return [a < 0 ? 0 : a, b > cols - 1 ? cols - 1 : b];
}

/** `soft`: the same field without quantization (a whisper of ordered noise keeps gradients from banding). */
function ditherRenderer(el: Surface, soft = false): Renderer | null {
  // One canvas may move between renderers (a texture change), so every renderer asks for the same context.
  const ctx = context(el);
  if (!ctx) return null;
  let w = 0;
  let h = 0;
  let bandRows = 0;
  let image: ImageData | null = null;
  const c = new Float32Array(4);
  const sp = new Float32Array(2);
  let coarse = new Float32Array(0);
  let coarseW = 0;
  return {
    resize(m) {
      const { cols, rows, cell } = ditherLayout(m.width, m.height, m.cell, m.dpr);
      const litRows = m.bandHeight ? Math.min(rows, Math.ceil(m.bandHeight / cell)) : rows;
      if (cols === w && rows === h && litRows === bandRows) return;
      w = cols;
      h = rows;
      bandRows = litRows;
      el.width = w;
      el.height = h;
      image = ctx.createImageData(w, h);
    },
    draw(field, look, now) {
      if (!image) return false;
      const aspect = w / bandRows;
      field.step(look, now, aspect);
      const lut = field.lut;
      const r0 = lut[0];
      const g0 = lut[1];
      const b0 = lut[2];
      const data = image.data;
      const R0 = r0 * 255;
      const G0 = g0 * 255;
      const B0 = b0 * 255;
      // The broad, soft variants are evaluated on every other cell and interpolated between:
      // a quarter of the work, and nothing they draw is finer than two cells. Tubes and tiles
      // have crisp edges and are evaluated per cell (they cache per tube or tile).
      // An image is sampled per cell: its detail is the point.
      // With a moving effect over an image, the image is read like the soft variants too: the frame
      // then costs what the pattern alone does.
      const smooth = look.variant !== 'tubes' && look.variant !== 'tiles' && (!field.hasImage || field.overlaying);
      field.cellRows = bandRows;
      // A full-bleed backdrop gets a couple more levels: its dim reaches read as soft light, not scattered dots.
      const levels = look.full ? LEVELS + 2 : LEVELS;
      if (smooth) {
        const cw = (w >> 1) + 2;
        const ch = (bandRows >> 1) + 2;
        if (coarse.length < cw * ch * 3) coarse = new Float32Array(cw * ch * 3);
        let k = 0;
        for (let j = 0; j < ch; j++) {
          const py = (2 * j + 0.5) / bandRows;
          for (let i = 0; i < cw; i++, k += 3) {
            field.shade(((2 * i + 0.5) / w) * aspect, py, c);
            coarse[k] = c[0];
            coarse[k + 1] = c[1];
            coarse[k + 2] = c[2];
          }
        }
        coarseW = cw;
      }
      // The horizon keeps its own proportions; the rest of the full stage is transparent.
      let o = (h - bandRows) * w * 4;
      for (let y = 0; y < bandRows; y++) {
        const py = (y + 0.5) / bandRows;
        const brow = (y & 7) * 8;
        const [xa, xb] = smooth ? FULL_ROW : litColumns(field, py, aspect, w, sp);
        const row0 = (y >> 1) * coarseW * 3;
        const row1 = row0 + coarseW * 3;
        const fy = (y & 1) * 0.5;
        for (let x = 0; x < w; x++, o += 4) {
          if (x < xa || x > xb) {
            data[o] = R0;
            data[o + 1] = G0;
            data[o + 2] = B0;
            data[o + 3] = 255;
            continue;
          }
          let r: number;
          let g: number;
          let b: number;
          if (smooth) {
            const a = row0 + (x >> 1) * 3;
            const d = row1 + (x >> 1) * 3;
            if (x & 1) {
              // Halfway between two coarse columns.
              const t0 = (coarse[a] + coarse[a + 3]) * 0.5;
              const t1 = (coarse[a + 1] + coarse[a + 4]) * 0.5;
              const t2 = (coarse[a + 2] + coarse[a + 5]) * 0.5;
              r = t0 + ((coarse[d] + coarse[d + 3]) * 0.5 - t0) * fy;
              g = t1 + ((coarse[d + 1] + coarse[d + 4]) * 0.5 - t1) * fy;
              b = t2 + ((coarse[d + 2] + coarse[d + 5]) * 0.5 - t2) * fy;
            } else {
              r = coarse[a] + (coarse[d] - coarse[a]) * fy;
              g = coarse[a + 1] + (coarse[d + 1] - coarse[a + 1]) * fy;
              b = coarse[a + 2] + (coarse[d + 2] - coarse[a + 2]) * fy;
            }
          } else {
            field.shade(((x + 0.5) / w) * aspect, py, c);
            r = c[0];
            g = c[1];
            b = c[2];
          }
          // Dither the light above the ground colour, so unlit cells are exactly the stage colour.
          // The cell's brightness is quantized, not each channel on its own, so a cell keeps its
          // hue at every level instead of scattering off-colour specks through dark areas.
          const lr = r > r0 ? r - r0 : 0;
          const lg = g > g0 ? g - g0 : 0;
          const lb = b > b0 ? b - b0 : 0;
          const m = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
          if (m < 0.002) {
            data[o] = R0;
            data[o + 1] = G0;
            data[o + 2] = B0;
            data[o + 3] = 255;
            continue;
          }
          if (soft) {
            // Unbroken light reads brighter than the same light dithered: held a little lower.
            const n = BAYER[brow + (x & 7)] * 1.5;
            data[o] = R0 + lr * 204 + n;
            data[o + 1] = G0 + lg * 204 + n;
            data[o + 2] = B0 + lb * 204 + n;
            data[o + 3] = 255;
            continue;
          }
          // Light above the ground is never negative, so truncation is the floor.
          const q = (((m * levels + BAYER[brow + (x & 7)] + 0.5) | 0) / levels / m) * 255;
          data[o] = R0 + lr * q;
          data[o + 1] = G0 + lg * q;
          data[o + 2] = B0 + lb * q;
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(image, 0, 0);
      return true;
    },
  };
}

/** Light level that maps to the last glyph of the ramp (broad fields; tubes peak at 1). */
const GLYPH_PEAK = 1.3;
/** A full-bleed backdrop is capped near 0.6, so its glyph ramp tops out there. */
const GLYPH_PEAK_FULL = 0.75;
/** Strength of the soft halo drawn under the characters. */
const GLOW = 0.16;

/** A broad field on every other cell (colour and level), interpolated back: a quarter of the evaluations. */
class Coarse {
  private buf = new Float32Array(0);
  private w = 0;

  fill(field: Field, cols: number, rows: number, aspect: number, c: Float32Array) {
    const cw = (cols >> 1) + 2;
    const ch = (rows >> 1) + 2;
    if (this.buf.length < cw * ch * 4) this.buf = new Float32Array(cw * ch * 4);
    const buf = this.buf;
    let k = 0;
    for (let j = 0; j < ch; j++) {
      const py = (2 * j + 0.5) / rows;
      for (let i = 0; i < cw; i++, k += 4) {
        field.shade(((2 * i + 0.5) / cols) * aspect, py, c);
        buf[k] = c[0];
        buf[k + 1] = c[1];
        buf[k + 2] = c[2];
        buf[k + 3] = c[3];
      }
    }
    this.w = cw;
  }

  at(x: number, y: number, out: Float32Array) {
    const buf = this.buf;
    const a = ((y >> 1) * this.w + (x >> 1)) * 4;
    const d = a + this.w * 4;
    const fy = (y & 1) * 0.5;
    const fx = (x & 1) * 0.5;
    for (let j = 0; j < 4; j++) {
      const top = buf[a + j] + (buf[a + 4 + j] - buf[a + j]) * fx;
      const bot = buf[d + j] + (buf[d + 4 + j] - buf[d + j]) * fx;
      out[j] = top + (bot - top) * fy;
    }
  }
}

/** A ramp of white dots, area proportional to the level, one `g`-px cell each, side by side (like the glyph atlas). */
function dotAtlas(g: number, size: number): Source | null {
  const c = scratch(g * RAMP.length, g);
  const ctx = context(c);
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  const top = RAMP.length - 1;
  for (let i = 1; i <= top; i++) {
    const r = Math.max(0.6, g * 0.5 * size * Math.sqrt(i / top));
    ctx.beginPath();
    ctx.arc(i * g + g / 2, g / 2, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** Characters (`ascii`, atlas from the host) or dots (`halftone`, atlas drawn here). */
function asciiRenderer(el: Surface, kind: 'ascii' | 'halftone' = 'ascii'): Renderer | null {
  const ctx = context(el);
  const tint = scratch(2, 2);
  const tctx = context(tint);
  const mask = scratch(2, 2);
  const mctx = context(mask);
  if (!ctx || !tctx || !mctx) return null;
  const dots = kind === 'halftone';
  // Dots carry brightness in their size; a fainter halo keeps them crisp.
  const glow = dots ? 0.07 : GLOW;
  let cols = 0;
  let rows = 0;
  let gw = 0;
  let gh = 0;
  let dotSize = 0.96;
  let image: ImageData | null = null;
  let atlas: Source | null = null;
  /** The glyph each cell of the mask holds; 255 forces a redraw. */
  let held = new Uint8Array(0);
  const coarse = new Coarse();
  const c = new Float32Array(4);
  const sp = new Float32Array(2);

  return {
    setAtlas(next) {
      if (dots) return;
      atlas = next;
      held.fill(255);
    },
    resize(m) {
      const L = dots ? halftoneLayout(m.width, m.height, m.dpr, m.cell) : asciiLayout(m.width, m.height, m.dpr, m.cell);
      const size = m.dotSize ?? 0.96;
      const sameGrid = L.cols === cols && L.rows === rows && L.gw === gw && L.gh === gh;
      if (dots && (!sameGrid || dotSize !== size)) {
        dotSize = size;
        atlas = dotAtlas(L.gw, dotSize);
        held.fill(255);
      }
      if (sameGrid) return;
      ({ cols, rows, gw, gh } = L);
      el.width = cols * gw;
      el.height = rows * gh;
      mask.width = cols * gw;
      mask.height = rows * gh;
      tint.width = cols;
      tint.height = rows;
      image = tctx.createImageData(cols, rows);
      held = new Uint8Array(cols * rows).fill(255);
    },
    draw(field, look, now) {
      if (!image || !atlas) return false;
      const aspect = (cols * gw) / (rows * gh);
      field.step(look, now, aspect);
      const lut = field.lut;
      const r0 = lut[0];
      const g0 = lut[1];
      const b0 = lut[2];
      const data = image.data;
      const top = RAMP.length - 1;
      // Tubes and tiles are crisp lines and edges of light; they lean on the dense glyphs to read.
      const tubes = look.variant === 'tubes' || look.variant === 'tiles';
      const full = look.full;
      const peak = full ? GLYPH_PEAK_FULL : GLYPH_PEAK;
      const W = cols * gw;
      const H = rows * gh;

      // The broad variants are evaluated on every other glyph and interpolated (see the dither renderer).
      const smooth = !tubes && (!field.hasImage || field.overlaying);
      field.cellRows = rows;
      if (smooth) coarse.fill(field, cols, rows, aspect, c);

      // 1. Glyph masks: only cells whose glyph changed since the last frame are touched.
      let o = 0;
      let i = 0;
      for (let y = 0; y < rows; y++) {
        const py = (y + 0.5) / rows;
        const brow = (y & 7) * 8;
        const dy = y * gh;
        const [xa, xb] = litColumns(field, py, aspect, cols, sp);
        for (let x = 0; x < cols; x++, o += 4, i++) {
          let gi = 0;
          if (x >= xa && x <= xb) {
            if (smooth) coarse.at(x, y, c);
            else field.shade(((x + 0.5) / cols) * aspect, py, c);
            const v = c[3] > 1 ? 1 : c[3];
            if (v > 0) {
              // Ordered dither between neighbouring glyphs, so the ramp shades smoothly. Tubes are thin
              // lines of light and lean on the dense glyphs to read; the broad fields keep the densest
              // glyphs for their headroom past 1, so bright areas stay a weave instead of a wall of @.
              let gf: number;
              if (tubes) gf = Math.sqrt(v) * top + BAYER[brow + (x & 7)] * 0.9 + 0.5;
              else {
                const level = c[3] >= peak ? 1 : c[3] / peak;
                gf = level * Math.sqrt(level) * top + BAYER[brow + (x & 7)] * 0.9 + 0.5;
              }
              gi = Math.floor(gf);
              // Hysteresis: a cell keeps its glyph until the light has clearly moved on, so slow drift
              // and breathing do not flip glyphs back and forth (each flip is a blit).
              const h = held[i];
              if (h !== 255 && h !== gi && h > 0 && gf > h - 0.15 && gf < h + 1.15) gi = h;
              if (gi > top) gi = top;
              // The light above the ground, keeping its hue and lifted so dim cells still read.
              const lr = c[0] > r0 ? c[0] - r0 : 0;
              const lg = c[1] > g0 ? c[1] - g0 : 0;
              const lb = c[2] > b0 ? c[2] - b0 : 0;
              const m = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
              if (gi < 0 || m < 0.004) gi = 0;
              else {
                // A full-bleed backdrop is lifted less: characters stay a texture of light, not a wall of type.
                const lift = ((full ? 0.3 + 0.48 * Math.sqrt(v) : 0.42 + 0.58 * Math.sqrt(v)) * 255) / m;
                data[o] = lr * lift;
                data[o + 1] = lg * lift;
                data[o + 2] = lb * lift;
              }
            }
          }
          data[o + 3] = gi > 0 ? 255 : 0;
          if (held[i] !== gi) {
            held[i] = gi;
            mctx.clearRect(x * gw, dy, gw, gh);
            if (gi > 0) mctx.drawImage(atlas, gi * gw, 0, gw, gh, x * gw, dy, gw, gh);
          }
        }
      }
      tctx.putImageData(image, 0, 0);

      // 2. Colour the masks: one cell-sized pixel per glyph, scaled up hard.
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tint, 0, 0, W, H);
      // 3. A soft halo under the characters: the same colours scaled up smoothly.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = glow;
      ctx.drawImage(tint, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // The ground is the host's background (every palette's shadow stop is --sheet).
      return true;
    },
  };
}

/** Cells of the soft image's light mask (CSS px); the mask is scaled up smoothly. */
const SOFT_MASK_CELL = 12;

/**
 * The image itself, cover-fitted and dimmed: drawn from a cached copy (recoloured once for a
 * palette or mono), drifting very slightly and leaning with the pointer, under a light mask
 * from the field (gain, hollow, spot, pulses) that is ordered-dithered before it is scaled up.
 */
function softImageRenderer(el: Surface): Renderer | null {
  const ctx = context(el);
  const mask = scratch(2, 2);
  const mctx = context(mask);
  if (!ctx || !mctx) return null;
  let w = 0;
  let h = 0;
  let mw = 0;
  let mh = 0;
  let src: ImageSource | null = null;
  let cache: Surface | null = null;
  let cacheKey = '';
  let mimg: ImageData | null = null;
  const c = new Float32Array(4);

  /** The image at stage size with a little overscan for drift, recoloured unless it keeps its own colours. */
  function prepare(look: Look, field: Field) {
    if (!src) return null;
    const own = !!look.imageColour;
    const key = `${w}x${h}/${own ? 'own' : `${field.lut[600]},${field.lut[601]},${field.lut[602]}`}`;
    if (cache && key === cacheKey) return cache;
    const cw = Math.round(w * 1.06);
    const ch = Math.round(h * 1.06);
    const out = scratch(cw, ch);
    const o = context(out);
    if (!o) return null;
    const k = Math.max(cw / src.width, ch / src.height);
    o.imageSmoothingQuality = 'high';
    o.drawImage(src, (cw - src.width * k) / 2, (ch - src.height * k) / 2, src.width * k, src.height * k);
    if (!own) {
      // Keep the image's light, take the palette's colour: the light stop's hue over its luminosity.
      const L = field.lut;
      o.globalCompositeOperation = 'color';
      o.fillStyle = `rgb(${Math.round(L[600] * 255)} ${Math.round(L[601] * 255)} ${Math.round(L[602] * 255)})`;
      o.fillRect(0, 0, cw, ch);
      o.globalCompositeOperation = 'source-over';
    }
    cache = out;
    cacheKey = key;
    return out;
  }

  return {
    setImage(next) {
      src = next;
      cache = null;
      cacheKey = '';
    },
    resize(m) {
      const L = softImageLayout(m.width, m.height, m.dpr);
      const nmw = Math.max(2, Math.ceil(m.width / SOFT_MASK_CELL));
      const nmh = Math.max(2, Math.ceil(m.height / SOFT_MASK_CELL));
      if (L.w === w && L.h === h && nmw === mw && nmh === mh) return;
      w = L.w;
      h = L.h;
      el.width = w;
      el.height = h;
      mw = nmw;
      mh = nmh;
      mask.width = mw;
      mask.height = mh;
      mimg = mctx.createImageData(mw, mh);
      cache = null;
    },
    draw(field, look, now) {
      if (!src || !mimg || !w) return false;
      const aspect = w / h;
      field.step(look, now, aspect);
      const img = prepare(look, field);
      if (!img) return false;
      // The light mask: the field's level per cell (an even, bright image gives the strength the
      // gain, hollow and spot leave), dithered so its gradient does not band.
      const d = mimg.data;
      let o = 0;
      field.cellRows = mh;
      for (let y = 0; y < mh; y++) {
        const py = (y + 0.5) / mh;
        const brow = (y & 7) * 8;
        for (let x = 0; x < mw; x++, o += 4) {
          field.shade(((x + 0.5) / mw) * aspect, py, c);
          const a = Math.min(1, c[3] * 1.25) * 255 + BAYER[brow + (x & 7)] * 6;
          d[o] = d[o + 1] = d[o + 2] = 255;
          d[o + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
        }
      }
      mctx.putImageData(mimg, 0, 0);
      // The picture, drifting a hair and leaning with the pointer (the field's own parallax).
      const t = field.clockNow;
      const [lx, ly] = field.parallax;
      const ox = (img.width - w) / 2;
      const oy = (img.height - h) / 2;
      const dx = -ox + Math.sin(t * 0.021) * ox * 0.5 - lx * ox * 6;
      const dy = -oy + Math.cos(t * 0.017) * oy * 0.5 - ly * oy * 6;
      ctx.globalCompositeOperation = 'copy';
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, dx, dy);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      return true;
    },
  };
}

// ── dots: Duovra Original's horizon as crisp, round points of light ──

/** Device pixels a dots canvas may hold (band only): bounds the per-frame fill on 4K and HiDPI. */
const DOT_PIXEL_BUDGET = 1_300_000;
/** Brightness steps of a dot (the ordered dither survives as which dots are lit, and how big). */
const DOT_LEVELS = 4;
/** Radius of a dot per level, in cells (level 0 is never drawn). */
const DOT_RADIUS = [0, 0.27, 0.33, 0.39, 0.45];
/** Brightness of a dot per level (its brightest channel above the ground, 0..1). */
const DOT_GLOW = [0, 0.62, 0.8, 0.93, 1];
/** Radius bins of the precomputed dot masks. */
const DOT_BINS = 20;
const DOT_RMIN = 0.1;
const DOT_RMAX = 0.52;

/**
 * The dots grid for a stage: whole device pixels per cell, so every dot sits on the pixel grid,
 * and a device scale bounded by `DOT_PIXEL_BUDGET`. `height` is the lit band (the canvas covers only it).
 */
export function dotsLayout(width: number, height: number, dpr: number, cell: number) {
  const budget = Math.sqrt(DOT_PIXEL_BUDGET / Math.max(1, width * height));
  const d = Math.min(2.5, Math.max(0.75, dpr || 1), Math.max(0.75, budget));
  const g = Math.max(4, Math.round(cell * d));
  const cols = Math.max(2, Math.ceil((width * d) / g));
  const rows = Math.max(2, Math.ceil((height * d) / g));
  return { d, g, cols, rows, cssW: (cols * g) / d, cssH: (rows * g) / d };
}

interface DotMask {
  /** Offsets from the cell's top-left pixel (row-major in the canvas) and the coverage at each (1..255). */
  off: Int32Array;
  alpha: Uint8Array;
}

/** Anti-aliased discs centred in the cell, one per radius bin, for one cell size and canvas width. */
function dotMasks(g: number, stride: number): DotMask[] {
  const masks: DotMask[] = [];
  const S = 4;
  const c = g / 2;
  for (let b = 0; b < DOT_BINS; b++) {
    const r = (DOT_RMIN + ((DOT_RMAX - DOT_RMIN) * b) / (DOT_BINS - 1)) * g;
    const off: number[] = [];
    const alpha: number[] = [];
    // A disc stays inside its cell (its anti-aliased rim at the largest bin is clipped to it).
    for (let y = 0; y < g; y++)
      for (let x = 0; x < g; x++) {
        let hit = 0;
        for (let sy = 0; sy < S; sy++)
          for (let sx = 0; sx < S; sx++) {
            const ox = x + (sx + 0.5) / S - c;
            const oy = y + (sy + 0.5) / S - c;
            if (ox * ox + oy * oy <= r * r) hit++;
          }
        if (!hit) continue;
        off.push(y * stride + x);
        alpha.push(Math.max(1, Math.round((hit / (S * S)) * 255)));
      }
    masks.push({ off: Int32Array.from(off), alpha: Uint8Array.from(alpha) });
  }
  return masks;
}

/**
 * Duovra Original as round points of light on a transparent canvas the size of its band, at device
 * resolution: nothing is scaled up, so every dot is sharp at any scale. The field gives each cell its
 * light; an ordered dither picks which dots are lit and how big, so the original texture is kept.
 * The dots do not follow the pointer.
 */
function dotsRenderer(el: Surface): Renderer | null {
  const ctx = context(el);
  if (!ctx) return null;
  let cols = 0;
  let rows = 0;
  let g = 0;
  let W = 0;
  let image: ImageData | null = null;
  let buf = new Uint32Array(0);
  let masks: DotMask[] = [];
  const c = new Float32Array(4);
  return {
    resize(m) {
      const L = dotsLayout(m.width, m.bandHeight ?? m.height, m.dpr, m.cell);
      if (L.cols === cols && L.rows === rows && L.g === g && image) return;
      ({ cols, rows, g } = L);
      W = cols * g;
      el.width = W;
      el.height = rows * g;
      image = ctx.createImageData(W, rows * g);
      buf = new Uint32Array(image.data.buffer);
      masks = dotMasks(g, W);
    },
    draw(field, look, now) {
      if (!image) return false;
      const aspect = cols / rows;
      field.cellRows = rows;
      // The horizon ignores the pointer: it is never passed on to the field.
      field.step(look.pointer ? { ...look, pointer: null } : look, now, aspect);
      buf.fill(0);
      const lut = field.lut;
      const r0 = lut[0];
      const g0 = lut[1];
      const b0 = lut[2];
      const bins = DOT_BINS - 1;
      const rSpan = DOT_RMAX - DOT_RMIN;
      for (let y = 0; y < rows; y++) {
        const py = (y + 0.5) / rows;
        const brow = (y & 7) * 8;
        // Depth: dots grow toward the bottom of the band, as if the horizon lay on a floor.
        const depth = 0.8 + 0.24 * py;
        const rowBase = y * g * W;
        for (let x = 0; x < cols; x++) {
          field.shade(((x + 0.5) / cols) * aspect, py, c);
          const v = c[3];
          if (v <= 0.02) continue;
          // A little above the field's light: more dots lit in the glow and on the ground.
          const level = Math.min(DOT_LEVELS, (v * DOT_LEVELS * 1.25 + BAYER[brow + (x & 7)] + 0.5) | 0);
          if (level <= 0) continue;
          let bin = Math.round(((DOT_RADIUS[level] * depth - DOT_RMIN) / rSpan) * bins);
          bin = bin < 0 ? 0 : bin > bins ? bins : bin;
          // The palette's hue at the dot's light, at the brightness of its level (as the dither did per cell).
          const vi = v >= 1 ? 765 : ((v * 255) | 0) * 3;
          const lr = lut[vi] > r0 ? lut[vi] - r0 : 0;
          const lg = lut[vi + 1] > g0 ? lut[vi + 1] - g0 : 0;
          const lb = lut[vi + 2] > b0 ? lut[vi + 2] - b0 : 0;
          const lm = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
          if (lm < 0.004) continue;
          const k = (DOT_GLOW[level] / lm) * 255;
          const cr = Math.min(255, r0 * 255 + lr * k) | 0;
          const cg = Math.min(255, g0 * 255 + lg * k) | 0;
          const cb = Math.min(255, b0 * 255 + lb * k) | 0;
          const rgb = (cb << 16) | (cg << 8) | cr;
          const mask = masks[bin];
          const off = mask.off;
          const al = mask.alpha;
          const base = rowBase + x * g;
          for (let n = 0; n < off.length; n++) buf[base + off[n]] = ((al[n] << 24) | rgb) >>> 0;
        }
      }
      ctx.putImageData(image, 0, 0);
      return true;
    },
  };
}

// ── engine: the clock and frame loop, wherever it runs ──

/** Frame interval in ms: ~16 fps for dither cells; glyphs cost a blit per change and a full-size composite, so ~9 fps. */
const FRAME_MS: Record<DitherTexture, number> = { dither: 60, ascii: 110, halftone: 90, soft: 60, dots: 42 };
/** The soft image redraws a stage-sized picture each frame; it moves so slowly that ~12 fps is plenty. */
const SOFT_IMAGE_MS = 84;

function makeRenderer(surface: Surface, texture: DitherTexture, image: boolean): Renderer | null {
  if (texture === 'ascii' || texture === 'halftone') return asciiRenderer(surface, texture);
  if (texture === 'soft' && image) return softImageRenderer(surface);
  if (texture === 'dots') return dotsRenderer(surface);
  return ditherRenderer(surface, texture === 'soft');
}

/** Frame interval while a beat is travelling, per quality level (a beat at full quality draws at ~36 fps). */
const BEAT_FRAME_MS = [28, 44, Infinity, Infinity, Infinity];

/**
 * Adaptive quality. A busy machine is the normal case, so the field watches whether it keeps up
 * and steps down on its own: 0 full, 1 the effects shed (beats lose their bending and echo, no
 * pointer light, beats draw slower), 2 a lower frame rate, 3 also coarser cells (the host re-sizes
 * the stage with QUALITY_CELL), 4 a still frame. It steps back up after a quiet spell.
 *
 * Signals, judged once a second: the field's own frame cost against its interval, how late its
 * timer fires (a late timer means the CPU is contended, wherever the engine runs), and the main
 * thread's load as reported by the host (ms of long animation frames per second, setPressure).
 * Three stressed seconds in a row step down; `quietNeed` quiet ms step up. Bouncing straight back
 * down after a step up doubles `quietNeed` (up to a minute), so a busy machine does not flicker
 * between levels. At level 4 nothing is drawn; a cheap 1 s probe timer keeps judging.
 *
 * Rest: once nothing moves (the drift has eased to a standstill under `setRest`, or a waiting
 * field's speed is 0, and no beat or light is easing) the loop stops entirely: no timer, no frame.
 * Any change (a look, the pointer, a beat, waking) starts it again.
 */
export const QUALITY_INTERVAL = [1, 1, 1.6, 2.4, 2.4];
export const QUALITY_CELL = [1, 1, 1, 1.5, 1.5];
export const MAX_QUALITY = 4;
const STRESS_LATE_MS = 40;
const STRESS_COST = 0.4;
const STRESS_MAIN_MS = 200;
const QUIET_MS = 8000;
/** Stressed seconds in a row before a step down (Windows timers alone are ~16 ms coarse). */
const STRESS_WINDOWS = 3;
const QUIET_MAX_MS = 64_000;
const BOUNCE_MS = 15_000;
const PROBE_MS = 1000;

export interface EngineEvents {
  /** After a frame was drawn: `first` once, and a smoothed frame cost every ~20 frames. */
  frame(first: boolean, ms: number | null): void;
  /** The quality level changed (0 full .. MAX_QUALITY still). */
  quality?(level: number): void;
}

export class FieldEngine {
  private field: Field;
  private renderer: Renderer;
  private texture: DitherTexture;
  private image: ImageSource | null = null;
  private metrics: Metrics | null = null;
  private atlas: Source | null = null;
  private look: Look;
  private running = false;
  private animate = false;
  /** The loop stopped because nothing moved (see `wake`). */
  private halted = false;
  /** A frozen clock (development frame sheets), or null. */
  private fixed: number | null = null;
  private timer: ReturnType<typeof setTimeout> | 0 = 0;
  private settle: ReturnType<typeof setInterval> | 0 = 0;
  private drawn = false;
  /** The last 20 frame costs; their median is reported, so one stall on a busy machine does not skew it. */
  private readonly costs = new Float32Array(20);
  private count = 0;
  private interval: number;
  // ── governor ──
  private quality = 0;
  /** When the pending timer was due, to measure how late it fired. */
  private due = 0;
  private winStart = 0;
  private winN = 0;
  private winLate = 0;
  private winCost = 0;
  private stressed = 0;
  private quietSince = 0;
  private quietNeed = QUIET_MS;
  private lastUp = -Infinity;
  /** Main-thread load from the host: ms of long frames in the last second. */
  private mainLoad = 0;

  static create(surface: Surface, texture: DitherTexture, look: Look, events: EngineEvents): FieldEngine | null {
    const r = makeRenderer(surface, texture, false);
    return r ? new FieldEngine(surface, r, texture, look, events) : null;
  }

  private constructor(
    private readonly surface: Surface,
    renderer: Renderer,
    texture: DitherTexture,
    look: Look,
    private readonly events: EngineEvents,
  ) {
    this.renderer = renderer;
    this.texture = texture;
    this.look = look;
    this.field = new Field(look);
    this.interval = FRAME_MS[texture];
  }

  /** New size, and for glyphs the atlas drawn for it (sent whenever the glyph cell changes). */
  resize(m: Metrics, atlas?: Source, texture = this.texture) {
    this.metrics = m;
    if (atlas) {
      if (this.atlas && 'close' in this.atlas) this.atlas.close();
      this.atlas = atlas;
    }
    if (texture !== this.texture) {
      this.texture = texture;
      this.rebuild();
    } else {
      this.renderer.resize(m);
      if (atlas) this.renderer.setAtlas?.(atlas);
      this.draw();
    }
  }

  /** An image in place of the pattern (null: back to the pattern). */
  setImage(image: ImageSource | null) {
    if (image === this.image) return;
    const was = this.softImage;
    this.image = image;
    this.applyImage();
    if (this.softImage !== was) this.rebuild();
    else {
      this.renderer.setImage?.(image);
      this.draw();
    }
  }

  private get softImage() {
    return this.texture === 'soft' && this.image != null;
  }

  /** The soft image draws the picture itself, under a mask of even light; every other texture samples it. */
  private applyImage() {
    const soft = this.softImage;
    this.field.flat = soft;
    this.field.setImage(soft ? null : this.image);
  }

  private rebuild() {
    const r = makeRenderer(this.surface, this.texture, this.image != null);
    if (!r) return;
    this.renderer = r;
    this.interval = this.softImage ? SOFT_IMAGE_MS : FRAME_MS[this.texture];
    this.applyImage();
    r.setImage?.(this.image);
    if (this.metrics) r.resize(this.metrics);
    if (this.atlas) r.setAtlas?.(this.atlas);
    this.draw();
  }

  setLook(look: Look, immediate = false) {
    this.look = { ...look, pointer: this.look.pointer };
    if (immediate) {
      if (this.settle) clearInterval(this.settle);
      this.settle = 0;
      this.field = new Field(this.look);
      this.field.lite = this.quality >= 1;
      this.draw();
      return;
    }
    if (this.animate && this.running && this.quality < MAX_QUALITY) return this.wake();
    // Still mode: run a short burst so the change eases in.
    if (this.settle) clearInterval(this.settle);
    let n = 0;
    this.settle = setInterval(() => {
      this.draw();
      if (++n > 14 && this.settle) {
        clearInterval(this.settle);
        this.settle = 0;
      }
    }, 70);
  }

  setPointer(p: [number, number] | null) {
    this.look.pointer = p;
    this.wake();
  }

  /** Main-thread load reported by the host: ms spent in long frames during the last second. */
  setPressure(ms: number) {
    this.mainLoad = ms;
  }

  /** A beat from (nx, ny), each 0..1 across the field. Ignored unless the field is moving. */
  beat(kind: FieldBeat, nx: number, ny: number, strength: number) {
    if (!this.animate || !this.running || this.quality >= MAX_QUALITY) return;
    this.field.beat(kind, nx, ny, strength, this.now());
    // Start on the next frame instead of waiting out the current interval.
    this.halted = false;
    this.schedule(0);
  }

  /** Rest (no input and no running turn for a while): the drift eases to a still frame and the loop stops. */
  setRest(rest: boolean) {
    this.field.setRest(rest);
    if (!rest) this.wake();
  }

  /** `animate`: the field moves at all. `running`: the host says it is visible, uncovered and in the foreground. */
  setState(animate: boolean, running: boolean) {
    this.animate = animate;
    const on = animate && running;
    if (on === this.running) return;
    this.running = on;
    this.halted = false;
    this.resetWindow();
    if (on) this.schedule(0);
    else this.stop();
  }

  /** Starts drawing again after the loop stopped because nothing moved. */
  private wake() {
    if (!this.halted || !this.running) return;
    this.halted = false;
    this.resetWindow();
    this.schedule(0);
  }

  /**
   * Development only (frame sheets): `advance` freezes the field's clock (at the current time the
   * first call) and moves it on by that many ms, drawing one frame; null lets it run again.
   */
  clock(advance: number | null) {
    if (advance == null) {
      if (this.fixed == null) return;
      this.fixed = null;
      this.halted = false;
      if (this.running) this.schedule(0);
      return;
    }
    if (this.fixed == null) this.fixed = performance.now();
    this.fixed += advance;
    this.stop();
    this.draw();
  }

  private now() {
    return this.fixed ?? performance.now();
  }

  dispose() {
    if (this.atlas && 'close' in this.atlas) this.atlas.close();
    this.running = false;
    this.stop();
    if (this.settle) clearInterval(this.settle);
    this.settle = 0;
  }

  private stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
  }

  private schedule(wait: number) {
    this.stop();
    if (this.fixed != null) return;
    this.due = performance.now() + wait;
    this.timer = setTimeout(this.quality >= MAX_QUALITY ? this.probe : this.tick, wait);
  }

  private tick = () => {
    this.timer = 0;
    if (!this.running) return;
    const t0 = performance.now();
    const late = t0 - this.due;
    this.draw();
    const cost = performance.now() - t0;
    // A slow drift needs fewer frames to look just as smooth (beats still draw at their own rate below).
    const slow = this.look.speed < 0.75 ? 1.35 : 1;
    // Light moving over a still image: the picture holds the eye, so fewer frames read as smooth
    // and the frame budget stays that of the pattern alone.
    const base = this.interval * QUALITY_INTERVAL[this.quality] * slow * (this.field.overlaying ? 1.5 : 1);
    this.judge(late, cost, base);
    if (!this.running) return;
    // Nothing moves any more (rest, or a waiting field that has stilled): stop until something changes.
    if (this.field.still && this.quality < MAX_QUALITY) {
      this.halted = true;
      return;
    }
    // While a beat travels the field draws faster, so the front moves smoothly.
    const interval = this.field.pulsing ? Math.min(base, BEAT_FRAME_MS[this.quality]) : base;
    this.schedule(this.quality >= MAX_QUALITY ? PROBE_MS : Math.max(4, interval - cost));
  };

  /** Level 3: nothing is drawn; a timer only checks whether the machine is quiet again. */
  private probe = () => {
    this.timer = 0;
    if (!this.running) return;
    this.judge(performance.now() - this.due, 0, Infinity);
    if (!this.running) return;
    this.schedule(this.quality >= MAX_QUALITY ? PROBE_MS : 0);
  };

  private resetWindow() {
    const now = performance.now();
    this.winStart = now;
    this.winN = this.winLate = this.winCost = 0;
    this.stressed = 0;
    this.quietSince = now;
  }

  private judge(late: number, cost: number, interval: number) {
    this.winN++;
    this.winLate += late > 0 ? late : 0;
    this.winCost += cost;
    const now = performance.now();
    if (now - this.winStart < 1000) return;
    const avgLate = this.winLate / this.winN;
    const avgCost = this.winCost / this.winN;
    this.winStart = now;
    this.winN = this.winLate = this.winCost = 0;
    const stressed = avgLate > STRESS_LATE_MS || avgCost > interval * STRESS_COST || this.mainLoad > STRESS_MAIN_MS;
    if (stressed) {
      this.quietSince = now;
      if (++this.stressed >= STRESS_WINDOWS && this.quality < MAX_QUALITY) {
        this.stressed = 0;
        // Straight back down after a step up: wait longer before the next try.
        if (now - this.lastUp < BOUNCE_MS) this.quietNeed = Math.min(this.quietNeed * 2, QUIET_MAX_MS);
        this.setQuality(this.quality + 1);
      }
      return;
    }
    this.stressed = 0;
    if (now - this.lastUp > 60_000) this.quietNeed = QUIET_MS;
    if (this.quality > 0 && now - this.quietSince >= this.quietNeed) {
      this.lastUp = now;
      this.quietSince = now;
      this.setQuality(this.quality - 1);
    }
  }

  private setQuality(q: number) {
    if (q === this.quality) return;
    this.quality = q;
    this.field.lite = q >= 1;
    this.events.quality?.(q);
  }

  private draw() {
    const t0 = performance.now();
    if (!this.renderer.draw(this.field, this.look, this.now())) return;
    const d = performance.now() - t0;
    this.costs[this.count % 20] = d;
    const first = !this.drawn;
    this.drawn = true;
    if (first) this.events.frame(true, null);
    else if (++this.count % 20 === 0) this.events.frame(false, [...this.costs].sort((a, b) => a - b)[10]);
  }
}

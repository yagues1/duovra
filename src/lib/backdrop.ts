/* Partes Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt. */
/**
 * El fondo de patrón de Duovra: patrón, tratamiento, presets y la normalización por la que
 * pasa todo valor guardado o editado. Puro, sin efectos al importarlo.
 *
 * El mismo patrón se aplica en inicio y sesión. `amount` es la intensidad en la
 * conversación (vacía o con mensajes), con un límite de luz de salida común a toda la superficie.
 * Las imágenes siguen el editor propio de
 * Duovra (encuadre, oscurecimiento, opacidad y desenfoque), así que aquí solo hay patrones.
 */
export type BackdropPattern = 'streaks' | 'tubes' | 'tiles' | 'aurora';
export type BackdropStyle = 'dither' | 'ascii' | 'halftone' | 'soft';
export type BackdropColour = 'agent' | 'mono' | 'custom';

export interface PatternSettings {
  pattern: BackdropPattern;
  style: BackdropStyle;
  /** Intensidad en la conversación, 0–100 (0 no dibuja nada). */
  amount: number;
  /** Dónde se concentra la luz, 0–1 a lo ancho y alto. */
  focus: { x: number; y: number };
  /** Hasta dónde llega la luz desde el foco, 0–100; 100 cubre todo el fondo por igual. */
  reach: number;
  /** Tamaño de celda, 0 grueso a 100 fino. */
  detail: number;
  /** 0 es completamente quieto. */
  speed: number;
  /** Dirección de Streaks y de la onda de Tubes, 0–180°. */
  angle: number;
  colour: BackdropColour;
  /** Color personalizado: matiz 0–360 y saturación 0–100. */
  hue: number;
  saturation: number;
  /** La luz responde al puntero, al enviar y a la actividad de los agentes. */
  react: boolean;
}

export const BACKDROP_PATTERNS: readonly BackdropPattern[] = ['streaks', 'tubes', 'tiles', 'aurora'];
export const BACKDROP_STYLES: readonly BackdropStyle[] = ['dither', 'ascii', 'halftone', 'soft'];
const COLOURS: readonly BackdropColour[] = ['agent', 'mono', 'custom'];
/** Patrones con dirección (se aplica `angle`). */
export const DIRECTIONAL: readonly BackdropPattern[] = ['streaks', 'tubes'];

export const PATTERN_LABEL: Record<BackdropPattern, string> = { streaks: 'Streaks', tubes: 'Tubes', tiles: 'Tiles', aurora: 'Aurora' };
export const STYLE_LABEL: Record<BackdropStyle, string> = { dither: 'Dither', ascii: 'ASCII', halftone: 'Halftone', soft: 'Soft' };

/** El patrón predeterminado: luz baja en el escenario, Streaks en dither fino. */
export const DEFAULT_PATTERN: PatternSettings = {
  pattern: 'streaks',
  style: 'dither',
  amount: 8,
  focus: { x: 0.62, y: 1 },
  reach: 72,
  detail: 94,
  speed: 30,
  angle: 35,
  colour: 'agent',
  hue: 28,
  saturation: 70,
  react: true,
};

export interface PatternPreset {
  id: string;
  name: string;
  pattern: PatternSettings;
}

const preset = (id: string, name: string, patch: Partial<PatternSettings>): PatternPreset => ({ id, name, pattern: { ...DEFAULT_PATTERN, ...patch } });
/** Todo el escenario por igual (el predeterminado concentra la luz abajo). */
const FULL = { reach: 100, focus: { x: 0.72, y: 0.78 } } as const;

/**
 * Los ocho presets de patrón ajustados para el escenario de conversación. Las preferencias
 * guardadas conservan sus valores completos al actualizar.
 */
export const PATTERN_PRESETS: readonly PatternPreset[] = [
  preset('quiet', 'Quiet', { amount: 10, reach: 72, speed: 16, react: false }),
  preset('streaks', 'Streaks', { ...FULL, amount: 27, detail: 89, speed: 34 }),
  preset('corner', 'Corner', { pattern: 'aurora', amount: 38, reach: 57, focus: { x: 0.91, y: 0.88 }, speed: 22 }),
  preset('ascii', 'ASCII', { ...FULL, style: 'ascii', amount: 38, detail: 78, speed: 26 }),
  preset('halftone', 'Halftone', { style: 'halftone', pattern: 'aurora', amount: 42, reach: 82, focus: { x: 0.61, y: 0.19 }, detail: 83, speed: 25 }),
  preset('still', 'Still', { pattern: 'tiles', amount: 29, speed: 0, reach: 80, focus: { x: 0.25, y: 0.94 }, react: false }),
  preset('mono', 'Mono', { ...FULL, colour: 'mono', pattern: 'tubes', amount: 33, speed: 25 }),
  preset('vivid', 'Vivid', { ...FULL, amount: 51, detail: 86, speed: 44 }),
];
export const PATTERN_PRESET_IDS = PATTERN_PRESETS.map((item) => item.id);

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const round = (v: unknown, lo: number, hi: number, f: number) => Math.round(clamp(v, lo, hi, f));

/** Una configuración completa y válida desde cualquier valor: números acotados, claves desconocidas fuera. */
export function normalizePattern(input: unknown, defaults: PatternSettings = DEFAULT_PATTERN): PatternSettings {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const d = defaults;
  const focus = o.focus && typeof o.focus === 'object' ? (o.focus as Record<string, unknown>) : {};
  return {
    pattern: pick(o.pattern, BACKDROP_PATTERNS, d.pattern),
    style: pick(o.style, BACKDROP_STYLES, d.style),
    amount: round(o.amount, 0, 100, d.amount),
    focus: { x: Math.round(clamp(focus.x, 0, 1, d.focus.x) * 1000) / 1000, y: Math.round(clamp(focus.y, 0, 1, d.focus.y) * 1000) / 1000 },
    reach: round(o.reach, 0, 100, d.reach),
    detail: round(o.detail, 0, 100, d.detail),
    speed: round(o.speed, 0, 100, d.speed),
    angle: round(o.angle, 0, 180, d.angle),
    colour: pick(o.colour, COLOURS, d.colour),
    hue: round(o.hue, 0, 360, d.hue),
    saturation: round(o.saturation, 0, 100, d.saturation),
    react: typeof o.react === 'boolean' ? o.react : d.react,
  };
}

export function samePattern(a: PatternSettings, b: PatternSettings): boolean {
  return JSON.stringify(normalizePattern(a)) === JSON.stringify(normalizePattern(b));
}

/** Tamaño de celda en px CSS para el dither (detalle 100 = 3 px, 0 = 14 px). */
export const backdropCell = (detail: number) => Math.round(3 + ((100 - detail) / 100) * 11);

/** La intensidad a la que el escenario se ve como antes de existir la configuración. */
const REFERENCE_AMOUNT = 60;
/**
 * Intensidad → ganancia del campo (luz de entrada) y opacidad (salida). Con poca intensidad el campo
 * se atenúa y adelgaza. La curva de entrada conserva las texturas del patrón. La opacidad de salida
 * limita la luz por igual detrás de los mensajes y en los márgenes.
 */
export function backdropStrength(amount: number) {
  const k = amount / REFERENCE_AMOUNT;
  return {
    gain: amount <= REFERENCE_AMOUNT ? 0.45 + 0.55 * k : 1 + ((amount - REFERENCE_AMOUNT) / 40) * 0.6,
    opacity: 0.055 + 0.41 * Math.pow(amount / 100, 0.78),
  };
}

const hexRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
/** Matiz y saturación (0–360, 0–100) de un color hexadecimal, para traer el color fijo de un fondo antiguo. */
export function hexHueSat(hex: string): { hue: number; saturation: number } {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return { hue: DEFAULT_PATTERN.hue, saturation: DEFAULT_PATTERN.saturation };
  const [r, g, b] = hexRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return { hue: 0, saturation: 0 };
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: Math.round(((h * 60) + 360) % 360), saturation: Math.round(Math.min(1, s) * 100) };
}

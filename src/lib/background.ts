import { ambientMotion, fieldIntensity, type AmbientMotion, type FieldIntensity } from './appearance';
import { asHue, type HueId } from './hues';
import type { Settings } from './types';
import { DEFAULT_PATTERN, PATTERN_PRESETS, hexHueSat, normalizePattern, type BackdropPattern, type BackdropStyle, type PatternSettings } from './backdrop';
import { tr } from '../i18n';

export const BACKGROUND_KEY = 'appearance.background.v1';
export const MAX_BACKGROUND_PRESETS = 40;
export const MAX_PRESET_NAME = 48;

export interface FieldSettings {
  color: string;
  palette: 'agent' | 'fixed';
  intensity: number;
  contrast: number;
  brightness: number;
  size: number;
  density: number;
  speed: number;
  amplitude: number;
  ambient: boolean;
  activity: number;
  pointer: boolean;
  reach: number;
  x: number;
  y: number;
  distribution: number;
  softness: number;
}

export interface ImageSettings {
  id: string | null;
  fit: 'cover' | 'contain';
  x: number;
  y: number;
  dim: number;
  opacity: number;
  blur: number;
  tint: number;
}

type FieldKind = 'waves' | 'particles' | 'ambient';
interface OriginalFieldSettings { intensity: FieldIntensity; ambient: AmbientMotion; reactions: boolean; hue: HueId }
export type BackgroundConfig =
  | { kind: 'original'; legacy?: true; field?: FieldSettings; stock?: OriginalFieldSettings }
  | { kind: 'minimal'; legacy?: true }
  | { kind: FieldKind; field: FieldSettings }
  | { kind: 'pattern'; pattern: PatternSettings }
  | { kind: 'image'; image: ImageSettings };

export interface BackgroundPreset { id: string; name: string; config: BackgroundConfig }
export interface BackgroundSelection { presetId: string; config: BackgroundConfig }
export interface BackgroundPreferences { active: BackgroundSelection; presets: BackgroundPreset[] }

export const DEFAULT_FIELD: FieldSettings = {
  color: '#8199ff', palette: 'agent', intensity: 55, contrast: 50, brightness: 50, size: 50,
  density: 50, speed: 45, amplitude: 50, ambient: true, activity: 60, pointer: true,
  reach: 70, x: 60, y: 78, distribution: 50, softness: 50,
};

export const DEFAULT_IMAGE: ImageSettings = { id: null, fit: 'cover', x: 50, y: 50, dim: 36, opacity: 82, blur: 0, tint: 0 };
export const DEFAULT_BACKGROUND: BackgroundSelection = { presetId: 'original', config: { kind: 'original' } };

const FIELD_DEFAULTS: Record<FieldKind, FieldSettings> = {
  waves: { ...DEFAULT_FIELD, color: '#847cff', intensity: 68, reach: 94, x: 62, y: 74 },
  particles: { ...DEFAULT_FIELD, color: '#55dbbf', intensity: 67, density: 72, reach: 88, x: 50, y: 56 },
  ambient: { ...DEFAULT_FIELD, color: '#7b9fff', intensity: 54, speed: 25, softness: 78, reach: 82, x: 68, y: 47 },
};

/** Los ocho presets de patrón (src/lib/backdrop.ts), como fondos de la conversación. */
export const PATTERN_BACKGROUND_PRESETS: readonly BackgroundPreset[] = PATTERN_PRESETS.map(({ id, name, pattern }) => ({ id, name, config: { kind: 'pattern', pattern } }));

/** Fondos integrados de Duovra además de los presets de patrón. */
export const DUOVRA_PRESETS: readonly BackgroundPreset[] = [
  { id: 'original', name: 'Duovra Original', config: DEFAULT_BACKGROUND.config },
  { id: 'minimal', name: 'Minimalista', config: { kind: 'minimal' } },
  { id: 'image', name: 'Imagen', config: { kind: 'image', image: DEFAULT_IMAGE } },
];

/** Nombre visible de un preset: los integrados se traducen; los personales se muestran tal cual. */
export function presetName(preset: Pick<BackgroundPreset, 'id' | 'name'>): string {
  const builtIn: Record<string, string> = { original: 'Duovra Original', minimal: tr('Minimalista'), image: tr('Imagen'), waves: tr('Ondas'), particles: tr('Partículas'), ambient: tr('Ambiental') };
  return builtIn[preset.id] ?? preset.name;
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [...PATTERN_BACKGROUND_PRESETS, ...DUOVRA_PRESETS];

/**
 * Los fondos editables de la beta (Ondas, Partículas, Ambiental) siguen disponibles
 * en la colección Duovra y en los presets personales que los usaban.
 */
export const LEGACY_FIELD_PRESETS: readonly BackgroundPreset[] = [
  { id: 'waves', name: 'Ondas', config: { kind: 'waves', field: FIELD_DEFAULTS.waves } },
  { id: 'particles', name: 'Partículas', config: { kind: 'particles', field: FIELD_DEFAULTS.particles } },
  { id: 'ambient', name: 'Ambiental', config: { kind: 'ambient', field: FIELD_DEFAULTS.ambient } },
];

const LEGACY_LOOK: Record<FieldKind, { pattern: BackdropPattern; style: BackdropStyle }> = {
  waves: { pattern: 'streaks', style: 'dither' },
  particles: { pattern: 'aurora', style: 'halftone' },
  ambient: { pattern: 'aurora', style: 'soft' },
};

/**
 * Un fondo editable de la beta como patrón, para seguir editándolo con el editor nuevo. El
 * original no se toca hasta pulsar Aplicar (y un preset personal conserva su versión anterior).
 */
export function legacyToPattern(config: BackgroundConfig): PatternSettings | null {
  if (config.kind === 'pattern') return config.pattern;
  if (config.kind === 'image' || config.kind === 'minimal') return null;
  const field = 'field' in config ? config.field : undefined;
  const look = config.kind === 'original' ? { pattern: 'streaks' as const, style: 'dither' as const } : LEGACY_LOOK[config.kind];
  if (!field) return { ...DEFAULT_PATTERN, ...look };
  const colour = field.palette === 'fixed' ? hexHueSat(field.color) : null;
  return normalizePattern({
    ...look,
    amount: Math.round(field.intensity * 0.6),
    focus: { x: field.x / 100, y: field.y / 100 },
    reach: field.reach,
    detail: Math.round(field.density * 0.6 + 40),
    speed: field.ambient ? Math.round(field.speed * 0.7) : 0,
    angle: Math.round(Math.min(180, Math.max(0, 35 + (field.distribution - 50) * 1.8))),
    colour: colour ? 'custom' : 'agent',
    hue: colour?.hue ?? DEFAULT_PATTERN.hue,
    saturation: colour?.saturation ?? DEFAULT_PATTERN.saturation,
    react: field.pointer || field.activity > 0,
  });
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const level = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(100, Math.max(0, Math.round(value))) : fallback;

function readField(value: unknown, defaults: FieldSettings): FieldSettings {
  const field = record(value);
  return {
    color: typeof field.color === 'string' && /^#[0-9a-f]{6}$/i.test(field.color) ? field.color.toLowerCase() : defaults.color,
    palette: field.palette === 'fixed' ? 'fixed' : 'agent',
    intensity: level(field.intensity, defaults.intensity),
    contrast: level(field.contrast, defaults.contrast),
    brightness: level(field.brightness, defaults.brightness),
    size: level(field.size, defaults.size),
    density: level(field.density, defaults.density),
    speed: level(field.speed, defaults.speed),
    amplitude: level(field.amplitude, defaults.amplitude),
    ambient: typeof field.ambient === 'boolean' ? field.ambient : defaults.ambient,
    activity: level(field.activity, defaults.activity),
    pointer: typeof field.pointer === 'boolean' ? field.pointer : defaults.pointer,
    reach: level(field.reach, defaults.reach),
    x: level(field.x, defaults.x),
    y: level(field.y, defaults.y),
    distribution: level(field.distribution, defaults.distribution),
    softness: level(field.softness, defaults.softness),
  };
}

function readConfig(value: unknown): BackgroundConfig | null {
  const config = record(value);
  switch (config.kind) {
    case 'minimal':
      return config.legacy === true ? { kind: 'minimal', legacy: true } : { kind: 'minimal' };
    case 'original':
      if (config.field && typeof config.field === 'object') return { kind: 'original', field: readField(config.field, DEFAULT_FIELD) };
      if (config.stock && typeof config.stock === 'object') {
        const stock = record(config.stock);
        return { kind: 'original', stock: {
          intensity: stock.intensity === 'soft' || stock.intensity === 'vivid' ? stock.intensity : 'normal',
          ambient: stock.ambient === 'off' || stock.ambient === 'subtle' ? stock.ambient : 'normal',
          reactions: stock.reactions !== false,
          hue: asHue(stock.hue),
        } };
      }
      return config.legacy === true ? { kind: 'original', legacy: true } : { kind: 'original' };
    case 'waves': case 'particles': case 'ambient':
      return { kind: config.kind, field: readField(config.field, FIELD_DEFAULTS[config.kind]) };
    case 'pattern':
      return { kind: 'pattern', pattern: normalizePattern(config.pattern) };
    case 'image': {
      const image = record(config.image);
      return { kind: 'image', image: {
        id: typeof image.id === 'string' && UUID.test(image.id) ? image.id : null,
        fit: image.fit === 'contain' ? 'contain' : 'cover',
        x: level(image.x, DEFAULT_IMAGE.x), y: level(image.y, DEFAULT_IMAGE.y),
        dim: level(image.dim, DEFAULT_IMAGE.dim), opacity: level(image.opacity, DEFAULT_IMAGE.opacity),
        blur: level(image.blur, DEFAULT_IMAGE.blur), tint: level(image.tint, DEFAULT_IMAGE.tint),
      } };
    }
    default:
      return null;
  }
}

export function readBackground(value: unknown): BackgroundPreferences | null {
  const state = record(value);
  const active = record(state.active);
  const config = readConfig(active.config);
  if (!config) return null;
  const seen = new Set<string>();
  const presets: BackgroundPreset[] = [];
  if (Array.isArray(state.presets)) {
    for (const item of state.presets.slice(0, MAX_BACKGROUND_PRESETS)) {
      const { id, name, config: input } = record(item);
      if (typeof id !== 'string' || !UUID.test(id) || seen.has(id) || typeof name !== 'string' || !name.trim()) continue;
      const config = readConfig(input);
      if (!config || (config.kind === 'image' && !config.image.id)) continue;
      seen.add(id);
      presets.push({ id, name: name.trim().slice(0, MAX_PRESET_NAME), config });
    }
  }
  const id = active.presetId;
  const builtIn = [...BACKGROUND_PRESETS, ...LEGACY_FIELD_PRESETS].find((preset) => preset.id === id);
  const presetId = typeof id === 'string' && (builtIn?.config.kind === config.kind || seen.has(id)) ? id : 'custom';
  return { active: { presetId, config }, presets };
}

/** Conserva el perfil anterior hasta que se aplica un nuevo fondo explícitamente. */
export function backgroundPreferences(settings: Settings): BackgroundPreferences {
  const stored = readBackground(settings[BACKGROUND_KEY]);
  if (stored) return stored;
  if (settings['appearance.backdrop'] === 'off') return { active: { presetId: 'minimal', config: { kind: 'minimal', legacy: true } }, presets: [] };
  const legacy = fieldIntensity(settings) !== 'normal' || ambientMotion(settings) !== 'normal' || settings['appearance.background'] === false;
  return { active: legacy ? { presetId: 'original', config: { kind: 'original', legacy: true } } : DEFAULT_BACKGROUND, presets: [] };
}

export function sameBackground(a: BackgroundSelection, b: BackgroundSelection): boolean {
  return a.presetId === b.presetId && JSON.stringify(a.config) === JSON.stringify(b.config);
}

export function backgroundImageId(config: BackgroundConfig): string | null {
  return config.kind === 'image' ? config.image.id : null;
}

/** Un preset del campo Original conserva el aspecto que tenía al guardarse. */
export function snapshotBackground(config: BackgroundConfig, settings: Settings): BackgroundConfig {
  if (config.kind !== 'original' || config.field || config.stock) return config;
  return { kind: 'original', stock: {
    intensity: config.legacy ? fieldIntensity(settings) : 'normal',
    ambient: config.legacy ? ambientMotion(settings) : 'normal',
    reactions: !config.legacy || settings['appearance.background'] !== false,
    hue: asHue(settings['appearance.hue']),
  } };
}

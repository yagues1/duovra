import { describe, expect, it } from 'vitest';
import { DEFAULT_PATTERN, PATTERN_PRESETS, backdropCell, backdropStrength, hexHueSat, normalizePattern } from './backdrop';
import { BACKGROUND_PRESETS, DEFAULT_FIELD, legacyToPattern, readBackground } from './background';

const presetId = '3fddeeb0-d6d5-4d6e-bdd2-4d77db80127d';

describe('patrones de fondo', () => {
  it('normaliza cualquier valor a una configuración completa y acotada', () => {
    const value = normalizePattern({ pattern: 'spiral', style: 'ascii', amount: 400, focus: { x: -3, y: '0.5' }, angle: 999, hue: 'x', extra: true });
    expect(value).toEqual({ ...DEFAULT_PATTERN, style: 'ascii', amount: 100, focus: { x: 0, y: 0.5 }, angle: 180 });
    expect(normalizePattern(null)).toEqual(DEFAULT_PATTERN);
  });

  it('conserva los ocho presets de patrón con diferencias reales de geometría, textura, luz y movimiento', () => {
    expect(PATTERN_PRESETS.map((p) => p.id)).toEqual(['quiet', 'streaks', 'corner', 'ascii', 'halftone', 'still', 'mono', 'vivid']);
    const patterns = new Set(PATTERN_PRESETS.map((p) => p.pattern.pattern));
    const styles = new Set(PATTERN_PRESETS.map((p) => p.pattern.style));
    expect(patterns).toEqual(new Set(['streaks', 'aurora', 'tiles', 'tubes']));
    expect(styles).toEqual(new Set(['dither', 'ascii', 'halftone']));
    const signatures = PATTERN_PRESETS.map(({ pattern }) => JSON.stringify(pattern));
    expect(new Set(signatures).size).toBe(8);
    expect(PATTERN_PRESETS.find((p) => p.id === 'still')?.pattern.speed).toBe(0);
    expect(PATTERN_PRESETS.find((p) => p.id === 'mono')?.pattern.colour).toBe('mono');
    // Corner concentra la luz cerca de la esquina inferior derecha y no la reparte por todo el fondo.
    const corner = PATTERN_PRESETS.find((p) => p.id === 'corner')?.pattern;
    expect(corner?.focus.x).toBeGreaterThanOrEqual(0.85);
    expect(corner?.focus.y).toBeGreaterThanOrEqual(0.85);
    expect(corner?.reach).toBeLessThan(100);
  });

  it('traduce intensidad y detalle según las curvas del patrón, con la luz de salida limitada en la conversación', () => {
    // La ganancia de entrada sigue la curva cuadrática.
    expect(backdropStrength(60).gain).toBe(1);
    expect(backdropStrength(100).gain).toBeCloseTo(1.6);
    // La opacidad de salida sustituye al velo de lectura: crece con la intensidad y nunca satura.
    expect(backdropStrength(0).opacity).toBeCloseTo(0.055);
    expect(backdropStrength(100).opacity).toBeCloseTo(0.465);
    const levels = [0, 10, 30, 60, 80, 100].map((amount) => backdropStrength(amount).opacity);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    expect(backdropCell(100)).toBe(3);
    expect(backdropCell(0)).toBe(14);
  });

  it('lee un patrón guardado y reconoce el preset integrado', () => {
    const pattern = PATTERN_PRESETS[3].pattern;
    const state = readBackground({ active: { presetId: 'ascii', config: { kind: 'pattern', pattern } }, presets: [{ id: presetId, name: 'Mío', config: { kind: 'pattern', pattern: { ...pattern, amount: 12 } } }] });
    expect(state?.active).toEqual({ presetId: 'ascii', config: { kind: 'pattern', pattern } });
    expect(state?.presets[0].config).toEqual({ kind: 'pattern', pattern: { ...pattern, amount: 12 } });
    // Un id integrado con otro tipo de fondo no se acepta.
    expect(readBackground({ active: { presetId: 'ascii', config: { kind: 'minimal' } } })?.active.presetId).toBe('custom');
    expect(BACKGROUND_PRESETS.filter((p) => p.config.kind === 'pattern')).toHaveLength(8);
  });

  it('convierte los fondos editables de la beta sin perder su color fijo', () => {
    const waves = legacyToPattern({ kind: 'waves', field: { ...DEFAULT_FIELD, palette: 'fixed', color: '#847cff', intensity: 80, ambient: false } });
    expect(waves).toMatchObject({ pattern: 'streaks', style: 'dither', colour: 'custom', amount: 48, speed: 0 });
    expect(waves?.hue).toBe(hexHueSat('#847cff').hue);
    expect(legacyToPattern({ kind: 'particles', field: DEFAULT_FIELD })).toMatchObject({ pattern: 'aurora', style: 'halftone', colour: 'agent' });
    expect(legacyToPattern({ kind: 'ambient', field: DEFAULT_FIELD })).toMatchObject({ pattern: 'aurora', style: 'soft' });
    expect(legacyToPattern({ kind: 'minimal' })).toBeNull();
    expect(hexHueSat('#ff0000')).toEqual({ hue: 0, saturation: 100 });
  });
});

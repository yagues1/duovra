import { describe, expect, it } from 'vitest';
import { BACKGROUND_KEY, BACKGROUND_PRESETS, DEFAULT_BACKGROUND, backgroundPreferences, readBackground, snapshotBackground } from './background';

const imageId = '1f8dd554-9ef2-4c42-b032-f36f6bda6db7';
const presetId = '3fddeeb0-d6d5-4d6e-bdd2-4d77db80127d';

describe('preferencias de fondo', () => {
  it('conserva los valores predeterminados y reconoce las preferencias antiguas', () => {
    expect(backgroundPreferences({}).active).toEqual(DEFAULT_BACKGROUND);
    expect(backgroundPreferences({ 'appearance.backdrop': 'enabled' }).active).toEqual(DEFAULT_BACKGROUND);
    expect(backgroundPreferences({ 'appearance.backdrop': 'off' }).active).toEqual({ presetId: 'minimal', config: { kind: 'minimal', legacy: true } });
    expect(backgroundPreferences({ 'appearance.fieldIntensity': 'soft', 'appearance.ambient': 'off' }).active.config).toEqual({ kind: 'original', legacy: true });
    expect(backgroundPreferences({ 'appearance.background': false }).active.config).toEqual({ kind: 'original', legacy: true });
  });

  it('prioriza la selección aplicada y normaliza un preset con imagen al volver a leerlo', () => {
    const state = {
      active: { presetId, config: { kind: 'image', image: { id: imageId, fit: 'contain', x: 34 } } },
      presets: [{ id: presetId, name: ' Foto ', config: { kind: 'image', image: { id: imageId, fit: 'contain', x: 34 } } }],
    };
    const parsed = backgroundPreferences({ [BACKGROUND_KEY]: state, 'appearance.backdrop': 'off' });
    expect(parsed.active.config).toMatchObject({ kind: 'image', image: { id: imageId, fit: 'contain', x: 34 } });
    expect(parsed.presets[0]).toEqual({ id: presetId, name: 'Foto', config: parsed.active.config });
    expect(readBackground(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('recupera valores válidos y descarta referencias que no son IDs', () => {
    const result = readBackground({
      active: { presetId: 'waves', config: { kind: 'waves', field: { color: 'url(evil)', intensity: 800, density: -1, amplitude: Infinity } } },
      presets: [{ id: presetId, name: 'Incorrecto', config: { kind: 'image', image: { id: '../original.png' } } }],
    });
    expect(result?.active.config).toMatchObject({ field: { color: '#847cff', intensity: 100, density: 0, amplitude: 50 } });
    expect(result?.presets).toEqual([]);
    expect(BACKGROUND_PRESETS).toHaveLength(11);
  });

  it('guarda el aspecto de Original en un preset aunque después cambie la apariencia general', () => {
    const settings = { 'appearance.fieldIntensity': 'soft', 'appearance.ambient': 'off', 'appearance.background': false, 'appearance.hue': 'lavanda' };
    const config = snapshotBackground(backgroundPreferences(settings).active.config, settings);
    expect(config).toEqual({ kind: 'original', stock: { intensity: 'soft', ambient: 'off', reactions: false, hue: 'lavanda' } });
    expect(snapshotBackground(config, {})).toEqual(config);
    expect(readBackground({ active: { presetId: 'original', config }, presets: [] })?.active.config).toEqual(config);
  });

  it('conserva los parámetros de un preset integrado que ya estaba en uso', () => {
    const vivid = BACKGROUND_PRESETS.find((preset) => preset.id === 'vivid');
    if (vivid?.config.kind !== 'pattern') throw new Error('Falta Vivid');
    const active = { presetId: vivid.id, config: { kind: 'pattern', pattern: { ...vivid.config.pattern, amount: 60, detail: 82 } } };
    expect(readBackground({ active, presets: [] })?.active).toEqual(active);
  });
});

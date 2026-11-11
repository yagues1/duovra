// AUD-001: Ajustes → Modelos dejaba la ventana vacía.
// Causa reproducida con el catálogo real de Claude Code 2.1.316: Haiku 4.5 llega sin
// `supportedEffortLevels` y el adaptador lo entregaba como `efforts: null`; `m.efforts.map`
// lanzaba «TypeError: Cannot read properties of null (reading 'map')» y, sin ErrorBoundary,
// React desmontaba toda la aplicación.
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import raw from './fixtures/claude-catalog-2.1.316.json';
import { useStore } from '../state/store';
import { SettingsView } from '../components/settings/SettingsView';

/** En renderizado de servidor, Zustand lee el estado inicial: se siembra ahí. */
function seed(patch: Record<string, unknown>) {
  Object.assign(useStore.getInitialState(), patch);
  useStore.setState(patch);
}
const render = () => renderToString(createElement(SettingsView));

describe('AUD-001 · Ajustes → Modelos', () => {
  it('se representa con el catálogo real sin normalizar (efforts: null)', () => {
    seed({ settingsSection: 'models', catalogs: { claude: raw, codex: 'loading' } });
    const html = render();
    expect(html).toContain('Haiku 4.5');
    expect(html).toContain('Haiku 5.5');
    expect(html).toContain('Sin niveles de razonamiento informados');
    expect(html).not.toContain('No se pudo mostrar');
  });

  it('muestra estados recuperables con catálogos vacíos, con error o corruptos', () => {
    seed({ settingsSection: 'models', catalogs: { claude: { source: 'x', models: [] }, codex: { error: 'Codex App Server no respondió' } } });
    let html = render();
    expect(html).toContain('no ha informado ningún modelo');
    expect(html).toContain('Codex App Server no respondió');

    seed({ settingsSection: 'models', catalogs: { claude: { models: [null, { id: 3 }, { id: 'ok' }, { id: 'ok' }] }, codex: 42 } });
    html = render();
    expect(html).toContain('ok');
    expect(html).toContain('3 entradas sin identificador válido o duplicadas omitidas');
    expect(html).toContain('catálogo de modelos vacío o no válido');
  });

  it('mantiene la navegación de ajustes aunque falle una sección', () => {
    seed({ settingsSection: 'models', catalogs: { claude: raw, codex: undefined } });
    const html = render();
    expect(html).toContain('Secciones de ajustes');
    expect(html).toContain('Apariencia');
  });
});

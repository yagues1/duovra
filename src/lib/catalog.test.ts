import { describe, expect, it } from 'vitest';
import raw from '../test/fixtures/claude-catalog-2.1.316.json';
import { normalizeCatalog } from './catalog';
import { resolvePrefs } from '../state/store';
import type { Conversation, ModelCatalog } from './types';

describe('normalizeCatalog', () => {
  it('convierte efforts null en lista vacía y conserva los niveles válidos', () => {
    const c = normalizeCatalog(raw) as ModelCatalog;
    expect(c.models.find((m) => m.id === 'claude-haiku-4-5-20251001')?.efforts).toEqual([]);
    expect(c.models.find((m) => m.id === 'haiku')?.efforts).toContain('medium');
    expect(c.models.find((m) => m.id === 'haiku')?.resolved).toBe('claude-haiku-5-5');
  });
  it('descarta entradas sin id, duplicadas y valores no textuales', () => {
    const c = normalizeCatalog({ models: [{ id: 'a', efforts: ['low', 3, null, 'low'], defaultEffort: 'zzz' }, { id: 'a' }, {}] }) as ModelCatalog;
    expect(c.models).toHaveLength(1);
    expect(c.models[0]).toMatchObject({ id: 'a', label: 'a', efforts: ['low'], defaultEffort: null });
    expect(c.skipped).toBe(2);
  });
  it('devuelve error legible ante respuestas inválidas', () => {
    expect(normalizeCatalog(null)).toHaveProperty('error');
    expect(normalizeCatalog({ error: 'x' })).toEqual({ error: 'x' });
  });
});

const catalogs = {
  claude: normalizeCatalog(raw) as ModelCatalog,
  codex: normalizeCatalog({
    source: 'codex',
    models: [
      { id: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', isDefault: true },
      { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
    ],
  }) as ModelCatalog,
};
const conv = (p: Partial<Conversation> = {}): Conversation => ({
  id: 'c', projectId: 'p', title: 't', createdAt: 0, updatedAt: 0, lastAgent: null, lastModel: null, lastEffort: null, draft: '', ...p,
});

describe('resolvePrefs · AUD-004', () => {
  it('recupera la combinación propia de cada agente al alternar', () => {
    const c = conv({
      lastAgent: 'codex', lastModel: 'gpt-6-luna', lastEffort: 'high',
      agentPrefs: { claude: { model: 'haiku', effort: 'medium' }, codex: { model: 'gpt-6-luna', effort: 'high' } },
    });
    expect(resolvePrefs(c, { settings: {}, catalogs }, 'claude')).toMatchObject({ agent: 'claude', model: 'haiku', effort: 'medium', replaced: null });
    expect(resolvePrefs(c, { settings: {}, catalogs }, 'codex')).toMatchObject({ agent: 'codex', model: 'gpt-6-luna', effort: 'high', replaced: null });
  });
  it('sin preferencia guardada usa el predeterminado del usuario y después el del catálogo', () => {
    expect(resolvePrefs(conv(), { settings: { 'defaults.model.codex': 'gpt-6-luna' }, catalogs }, 'codex')).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' });
    expect(resolvePrefs(conv(), { settings: {}, catalogs }, 'codex')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'low' });
  });
  it('anuncia el reemplazo cuando el modelo guardado ya no existe', () => {
    const c = conv({ agentPrefs: { codex: { model: 'gpt-retirado', effort: 'high' } } });
    const p = resolvePrefs(c, { settings: {}, catalogs }, 'codex');
    expect(p.replaced).toEqual({ from: 'gpt-retirado' });
    expect(p.model).toBe('gpt-6.1-sol');
  });
  it('no marca reemplazo mientras el catálogo carga', () => {
    const c = conv({ agentPrefs: { codex: { model: 'gpt-6-luna', effort: 'high' } } });
    expect(resolvePrefs(c, { settings: {}, catalogs: { codex: 'loading' } }, 'codex')).toMatchObject({ model: 'gpt-6-luna', effort: 'high', replaced: null });
  });
});

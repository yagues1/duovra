import { describe, expect, it } from 'vitest';
import { familyOf, groupModels, searchModels } from './modelGroups';
import { normalizeCatalog } from './catalog';
import raw from '../test/fixtures/claude-catalog-2.1.316.json';
import type { ModelCatalog, ModelInfo } from './types';

const claude = (normalizeCatalog(raw) as ModelCatalog).models;
const m = (id: string, p: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, efforts: [], ...p });

describe('familyOf', () => {
  it('deduce familia y versión', () => {
    expect(familyOf('claude-opus-4-6')).toEqual({ family: 'opus', version: [4, 6] });
    expect(familyOf('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', version: [4, 5] });
    expect(familyOf('gpt-6.1-sol')).toEqual({ family: 'sol', version: [6, 1] });
    expect(familyOf('opus')).toEqual({ family: 'opus', version: null });
    expect(familyOf('opusplan')).toEqual({ family: 'opusplan', version: null });
    expect(familyOf('default')).toEqual({ family: 'default', version: null });
  });
});

describe('groupModels', () => {
  it('catálogo real de Claude Code: alias en la lista principal y el resto en «Más modelos»', () => {
    const g = groupModels(claude);
    expect(g.primary.map((x) => x.id)).toEqual(['default', 'opus', 'sonnet', 'fable', 'haiku', 'opusplan']);
    expect(g.more.map((x) => x.id)).toEqual([
      'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'claude-sonnet-5', 'claude-sonnet-4-6',
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
    ]);
  });
  it('sin alias, la versión más alta es la principal', () => {
    const g = groupModels([m('gpt-6-sol'), m('gpt-6.1-sol'), m('gpt-6-luna')]);
    expect(g.primary.map((x) => x.id)).toEqual(['gpt-6-sol'.replace('6-', '6.1-'), 'gpt-6-luna']);
    expect(g.more.map((x) => x.id)).toEqual(['gpt-6-sol']);
  });
  it('si empatan en versión gana el predeterminado', () => {
    const g = groupModels([m('gpt-6-sol'), m('gpt-6-sol-x'), m('x-6-sol', { isDefault: true })]);
    expect(g.primary.map((x) => x.id)).toContain('x-6-sol');
  });
  it('un modelo antiguo elegido aparece también en la principal', () => {
    const g = groupModels(claude, 'claude-opus-4-6');
    expect(g.primary[g.primary.length - 1].id).toBe('claude-opus-4-6');
    expect(g.more.some((x) => x.id === 'claude-opus-4-6')).toBe(true);
    expect(g.legacy).toBe('claude-opus-4-6');
    expect(groupModels(claude, 'retirado').primary).toHaveLength(6);
  });
  it('ningún modelo se pierde', () => {
    const g = groupModels(claude);
    expect(new Set([...g.primary, ...g.more].map((x) => x.id)).size).toBe(claude.length);
  });
  it('catálogo vacío', () => expect(groupModels([])).toEqual({ primary: [], more: [], legacy: null }));
});

describe('searchModels', () => {
  const list = [m('opus', { label: 'Opus 5.5', exact: 'claude-opus-5-5' }), m('claude-opus-4-8', { label: 'Opus 4.8' }), m('gpt-6-luna', { label: 'GPT-6-Luna' })];
  it('busca por nombre, identificador y exacto, en el orden del proveedor', () => {
    expect(searchModels(list, 'opus').map((x) => x.id)).toEqual(['opus', 'claude-opus-4-8']);
    expect(searchModels(list, '5-5').map((x) => x.id)).toEqual(['opus']);
    expect(searchModels(list, 'luna gpt').map((x) => x.id)).toEqual(['gpt-6-luna']);
    expect(searchModels(list, '  ')).toHaveLength(3);
    expect(searchModels(list, 'sonnet')).toEqual([]);
  });
  it('un modelo nuevo comunicado por el proveedor aparece sin listas de Duovra', () => {
    const groups = groupModels([...list, m('claude-zephyr-1', { label: 'Zephyr 1' })]);
    expect(groups.primary.map((x) => x.id)).toContain('claude-zephyr-1');
    expect(searchModels([...list, m('claude-zephyr-1', { label: 'Zephyr 1' })], 'zephyr')).toHaveLength(1);
  });
});

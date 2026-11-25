import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import { changeAgent } from '../lib/actions';
import type { Conversation, ModelCatalog, QueueView } from '../lib/types';
import { canDispatch, draftOf, ensureCatalog, useStore } from './store';

const original = useStore.getState();
const state = useStore.getState;
const conversation = (id: string, lastAgent: Conversation['lastAgent'] = null): Conversation => ({
  id, projectId: 'project', title: id, createdAt: 0, updatedAt: 0,
  lastAgent, lastModel: null, lastEffort: null, draft: '',
});
const catalog = (id: string, effort = 'medium'): ModelCatalog => ({
  source: 'fixture', models: [{ id, label: id, defaultEffort: effort, efforts: [effort], isDefault: true }],
});
const queue: QueueView = { entries: [], pauseReason: null, reviewMessageId: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useStore.setState({ conversations: [conversation('a'), conversation('b', 'codex')], settings: { 'defaults.agent': 'claude' }, toast: vi.fn() });
  vi.spyOn(api, 'setSetting').mockResolvedValue();
  vi.spyOn(api, 'setConversationPrefs').mockResolvedValue();
  vi.spyOn(api, 'messageQueue').mockResolvedValue(queue);
  vi.spyOn(api, 'listMessages').mockResolvedValue({ messages: [], sessions: [] });
});
afterEach(async () => {
  await state().flushDrafts();
  useStore.setState(original);
  vi.restoreAllMocks();
});

describe('Selección del compositor con catálogos pendientes', () => {
  it.each([
    ['a', 'claude', 'codex', 'luna'],
    ['b', 'codex', 'claude', 'haiku'],
  ] as const)('conserva el cambio en frío de %s: %s → %s', async (id, from, to, model) => {
    const first = deferred<ModelCatalog>();
    const second = deferred<ModelCatalog>();
    vi.spyOn(api, 'agentModels').mockImplementation((agent) => agent === from ? first.promise : second.promise);
    await state().selectConversation(id);
    const originalRead = state().refreshCatalog(from);
    const selectedRead = state().refreshCatalog(to);
    changeAgent(to, id);
    expect(state().prefs[id]?.agent).toBe(to);
    first.resolve(catalog('irrelevante'));
    await originalRead;
    expect(state().prefs[id]).toMatchObject({ agent: to, model: '' });
    second.resolve(catalog(model));
    await selectedRead;
    expect(state().prefs[id]).toMatchObject({ agent: to, model, effort: 'medium' });
  });

  it('restaura ajustes al arrancar con historial pendiente y mantiene la selección de cada conversación', async () => {
    const history = deferred<Awaited<ReturnType<typeof api.listMessages>>>();
    const claude = deferred<ModelCatalog>();
    const codex = deferred<ModelCatalog>();
    const project = { id: 'project', path: 'proyecto', name: 'proyecto', createdAt: 0, updatedAt: 0 };
    vi.spyOn(api, 'bootstrap').mockResolvedValue({
      projects: [project], conversations: state().conversations, settings: state().settings,
      accounts: [], activeRuns: [], appVersion: 'qa',
    });
    vi.spyOn(api, 'detectAgents').mockResolvedValue([]);
    vi.mocked(api.listMessages).mockReturnValueOnce(history.promise);
    vi.spyOn(api, 'agentModels').mockImplementation((agent) => agent === 'claude' ? claude.promise : codex.promise);
    await state().init();
    expect(state().prefs.a.agent).toBe('claude');
    expect(api.agentModels).toHaveBeenCalledExactlyOnceWith('claude', false);
    changeAgent('codex', 'a');
    // El compositor solicita el catálogo del proveedor al mostrar la nueva selección.
    ensureCatalog('codex');
    await state().selectConversation('b');
    changeAgent('claude', 'b');
    claude.resolve(catalog('haiku'));
    codex.resolve(catalog('luna', 'high'));
    history.resolve({ messages: [], sessions: [] });
    await history.promise;
    expect(state().activeConversationId).toBe('b');
    expect(state().prefs.a).toMatchObject({ agent: 'codex', model: 'luna', effort: 'high' });
    expect(state().prefs.b).toMatchObject({ agent: 'claude', model: 'haiku', effort: 'medium' });
  });

  it('ignora el catálogo obsoleto y serializa la escritura de cambios rápidos', async () => {
    const slow = deferred<ModelCatalog>();
    const firstWrite = deferred<void>();
    const started = deferred<void>();
    vi.mocked(api.setConversationPrefs).mockImplementationOnce(() => {
      started.resolve();
      return firstWrite.promise;
    });
    vi.spyOn(api, 'agentModels').mockReturnValueOnce(slow.promise).mockResolvedValueOnce(catalog('luna', 'high'));
    await state().selectConversation('a');
    const stale = state().refreshCatalog('codex');
    changeAgent('codex', 'a');
    await started.promise;
    changeAgent('claude', 'a');
    changeAgent('codex', 'a');
    await state().refreshCatalog('codex', true);
    slow.resolve(catalog('anterior'));
    await stale;
    expect(state().prefs.a).toMatchObject({ agent: 'codex', model: 'luna', effort: 'high' });
    expect(api.setConversationPrefs).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await state().flushDrafts();
    expect(vi.mocked(api.setConversationPrefs).mock.calls.map((call) => call[1])).toEqual(['codex', 'claude', 'codex']);
  });

  it('rechaza catálogos pendientes o vacíos y exige confirmar un nuevo esfuerzo sin alterar encargos', async () => {
    const codex = deferred<ModelCatalog>();
    const codexCatalog = catalog('luna', 'high');
    vi.spyOn(api, 'agentModels').mockReturnValueOnce(codex.promise)
      .mockResolvedValueOnce({ source: 'fixture', models: [] })
      .mockResolvedValueOnce(catalog('haiku'))
      .mockResolvedValueOnce(codexCatalog)
      .mockResolvedValueOnce({ source: 'fixture', models: [{ id: 'luna', label: 'luna', efforts: [], isDefault: true }] });
    const send = vi.spyOn(api, 'sendMessage');
    const enqueue = vi.spyOn(api, 'enqueueMessage').mockResolvedValue(queue);
    await state().selectConversation('a');
    const loading = state().refreshCatalog('codex');
    changeAgent('codex', 'a');
    expect(await state().send('a', 'ahora', [])).toBe(false);
    expect(await state().enqueue('a', 'después', [], true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    codex.resolve(codexCatalog);
    await loading;
    await state().enqueue('a', 'después Codex', [], true);
    await state().refreshCatalog('codex');
    expect(await state().send('a', 'modelo ausente', [])).toBe(false);
    await state().refreshCatalog('claude');
    changeAgent('claude', 'a');
    await state().enqueue('a', 'después Claude', [], true);
    changeAgent('codex', 'a');
    await state().refreshCatalog('codex');
    state().setPrefs('a', { effort: 'incompatible' });
    expect(state().prefs.a.effort).toBe('high');
    await state().refreshCatalog('codex');
    expect(state().prefs.a.effort).toBe('high');
    expect(await state().send('a', 'esfuerzo retirado', [])).toBe(false);
    expect(await state().enqueue('a', 'esfuerzo retirado', [], true)).toBe(false);
    state().setPrefs('a', { effort: null });
    expect(state().prefs.a.effort).toBeNull();
    expect(canDispatch(state().prefs.a, state().catalogs.codex)).toBe(true);
    expect(enqueue.mock.calls.map(([, request]) => [request.agent, request.model, request.effort])).toEqual([
      ['codex', 'luna', 'high'], ['claude', 'haiku', 'medium'],
    ]);
  });

  it('conserva una elección manual tras dos fallos, una respuesta tardía y cambios rápidos de agente', async () => {
    const latest = deferred<ModelCatalog>();
    const stale = deferred<ModelCatalog>();
    const read = vi.spyOn(api, 'agentModels').mockResolvedValueOnce(catalog('haiku'))
      .mockResolvedValueOnce(catalog('luna', 'high'))
      .mockRejectedValueOnce(new Error('Primer fallo'))
      .mockRejectedValueOnce(new Error('Segundo fallo'))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    await state().refreshCatalog('claude');
    await state().refreshCatalog('codex');
    await state().selectConversation('a');
    changeAgent('codex', 'a');
    const selection = state().prefs.a;
    await state().refreshCatalog('codex', true);
    expect(state().prefs.a).toBe(selection);
    await state().refreshCatalog('codex', true);
    expect(state().prefs.a).toBe(selection);
    expect(state().catalogs.codex).toEqual({ error: 'Segundo fallo' });

    const firstRetry = state().refreshCatalog('codex', true);
    changeAgent('claude', 'a');
    expect(state().prefs.a).toEqual({ agent: 'claude', model: 'haiku', effort: 'medium' });
    changeAgent('codex', 'a');
    const lastRetry = state().refreshCatalog('codex', true);
    latest.resolve(catalog('vigente'));
    await lastRetry;
    stale.reject(new Error('Obsoleto'));
    await firstRetry;
    expect(read).toHaveBeenCalledTimes(6);
    expect(state().prefs.a).toEqual(selection);
    expect(state().catalogs.codex).toMatchObject({ models: [{ id: 'vigente' }] });
    expect(canDispatch(state().prefs.a, state().catalogs.codex)).toBe(false);
    state().setPrefs('a', { model: 'vigente', effort: 'medium' });
    expect(canDispatch(state().prefs.a, state().catalogs.codex)).toBe(true);
  });

  it('espera el guardado anterior y permite recuperar el borrador si falla el cierre', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    try {
      const first = deferred<void>();
      const save = vi.spyOn(api, 'setDraft').mockReturnValueOnce(first.promise)
        .mockRejectedValueOnce(new Error('SQLite ocupado')).mockResolvedValue();
      state().saveDraft('a', 'primer borrador');
      await vi.advanceTimersByTimeAsync(350);
      state().saveDraft('a', 'versión más reciente');
      const closing = expect(state().flushDrafts()).rejects.toThrow('No se pudo guardar el borrador');
      expect(save).toHaveBeenCalledTimes(1);
      first.resolve();
      await closing;
      expect(draftOf(state().conversations[0])).toBe('versión más reciente');
      await state().flushDrafts();
      expect(save.mock.calls).toEqual([
        ['a', 'primer borrador'], ['a', 'versión más reciente'], ['a', 'versión más reciente'],
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

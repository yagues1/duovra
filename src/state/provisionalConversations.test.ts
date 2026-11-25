import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import type { Conversation } from '../lib/types';
import { isListed, useStore } from './store';

const original = useStore.getState();

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, projectId: 'p1', title: 'Nueva conversación', createdAt: 1, updatedAt: 1, lastAgent: null, lastModel: null,
    lastEffort: null, draft: '', draftAttachments: [], started: false, ...extra,
  };
}

function setup(conversations: Conversation[], active: string | null) {
  vi.spyOn(api, 'listMessages').mockResolvedValue({ messages: [], sessions: [] });
  vi.spyOn(api, 'messageQueue').mockResolvedValue({ entries: [], pauseReason: null } as never);
  vi.spyOn(api, 'setSetting').mockResolvedValue(undefined);
  useStore.setState({
    projects: [{ id: 'p1', name: 'Demo', path: 'C:\\demo', createdAt: 1, updatedAt: 1 }],
    conversations, activeProjectId: 'p1', activeConversationId: active, view: 'chat', settingsOpen: false,
    messages: {}, runs: {}, queues: {}, prefs: {}, settings: {},
  });
}

afterEach(() => {
  useStore.setState(original);
  vi.restoreAllMocks();
});

describe('Chats provisionales', () => {
  it('pulsar varias veces «Nueva conversación» crea un único chat', async () => {
    setup([], null);
    let n = 0;
    const create = vi.spyOn(api, 'createConversation').mockImplementation(async () => conv(`n${++n}`));
    const { newConversation } = useStore.getState();
    await Promise.all([newConversation(), newConversation(), newConversation()]);
    await newConversation();
    await newConversation();
    expect(create).toHaveBeenCalledTimes(1);
    expect(useStore.getState().conversations.map((c) => c.id)).toEqual(['n1']);
    expect(useStore.getState().activeConversationId).toBe('n1');
  });

  it('no aparece en la lista mientras está vacío y sí con borrador o adjuntos', () => {
    expect(isListed(conv('a'))).toBe(false);
    expect(isListed(conv('b', { draft: 'hola' }))).toBe(true);
    expect(isListed(conv('c', { draftAttachments: ['C:\\a.txt'] }))).toBe(true);
    expect(isListed(conv('d', { started: true }))).toBe(true);
    // Conversaciones anteriores sin el campo: siempre definitivas.
    expect(isListed(conv('e', { started: undefined }))).toBe(true);
  });

  it('al abandonar un chat vacío se descarta; con borrador o adjuntos se conserva', async () => {
    setup([conv('vacio'), conv('texto', { draft: 'pendiente' }), conv('adjunto', { draftAttachments: ['C:\\a.png'] }), conv('viejo', { started: true })], 'vacio');
    const discard = vi.spyOn(api, 'discardEmptyConversation').mockResolvedValue(true);
    await useStore.getState().selectConversation('texto');
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('vacio'));
    await vi.waitFor(() => expect(useStore.getState().conversations.some((c) => c.id === 'vacio')).toBe(false));
    await useStore.getState().selectConversation('adjunto');
    await useStore.getState().selectConversation('viejo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(useStore.getState().conversations.map((c) => c.id)).toEqual(['texto', 'adjunto', 'viejo']);
  });

  it('no descarta un chat si el backend detecta contenido', async () => {
    setup([conv('vacio'), conv('otro', { started: true })], 'vacio');
    vi.spyOn(api, 'discardEmptyConversation').mockResolvedValue(false);
    await useStore.getState().selectConversation('otro');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().conversations.some((c) => c.id === 'vacio')).toBe(true);
  });

  it('reutiliza el chat provisional vacío del proyecto en lugar de crear otro', async () => {
    setup([conv('vacio'), conv('otro', { started: true })], 'otro');
    const create = vi.spyOn(api, 'createConversation');
    await useStore.getState().newConversation();
    expect(create).not.toHaveBeenCalled();
    expect(useStore.getState().activeConversationId).toBe('vacio');
  });
});

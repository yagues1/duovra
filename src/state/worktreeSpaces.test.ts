import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import type { Conversation } from '../lib/types';
import type { Worktree } from '../lib/worktrees';
import { activeRoot, activeSpace, useStore } from './store';
import { integrationPrompt } from '../components/worktrees/worktreeActions';

const original = useStore.getState();

const conv = (id: string, worktreeId: string | null, extra: Partial<Conversation> = {}): Conversation => ({
  id, projectId: 'p1', title: id, createdAt: 1, updatedAt: 1, lastAgent: null, lastModel: null, lastEffort: null,
  draft: '', draftAttachments: [], started: true, worktreeId, ...extra,
});

const worktree: Worktree = {
  id: 'w1', projectId: 'p1', path: 'C:\\demo.worktrees\\pagos', branch: 'feat/pagos', label: 'pagos', managed: true,
  baseRef: 'main', retired: false, createdAt: 1, exists: true,
};

function setup(conversations: Conversation[], active: string | null, activeWorktreeId: string | null = null) {
  vi.spyOn(api, 'listMessages').mockResolvedValue({ messages: [], sessions: [] });
  vi.spyOn(api, 'messageQueue').mockResolvedValue({ entries: [], pauseReason: null } as never);
  vi.spyOn(api, 'setSetting').mockResolvedValue(undefined);
  vi.spyOn(api, 'worktreeStatus').mockResolvedValue({ exists: true } as never);
  useStore.setState({
    projects: [{ id: 'p1', name: 'Demo', path: 'C:\\demo', createdAt: 1, updatedAt: 1 }],
    worktrees: [worktree], conversations, activeProjectId: 'p1', activeConversationId: active, activeWorktreeId,
    view: 'chat', settingsOpen: false, messages: {}, runs: {}, queues: {}, prefs: {}, settings: {},
    panel: { open: true, tabs: [{ id: 'file:a', kind: 'file', title: 'a', payload: {} }], active: 'file:a' },
  });
}

afterEach(() => {
  useStore.setState(original);
  vi.restoreAllMocks();
});

describe('Espacios de trabajo (worktrees)', () => {
  it('la conversación fija el espacio activo y Workbench no mezcla espacios', async () => {
    setup([conv('main', null), conv('wt', 'w1')], 'main');
    expect(activeRoot(useStore.getState())).toBe('C:\\demo');
    await useStore.getState().selectConversation('wt');
    const s = useStore.getState();
    expect(s.activeWorktreeId).toBe('w1');
    expect(activeSpace(s)).toBe('w1');
    expect(activeRoot(s)).toBe('C:\\demo.worktrees\\pagos');
    expect(s.panel.tabs).toEqual([]);
  });

  it('una conversación nueva nace en el espacio activo y reutiliza solo provisionales del mismo espacio', async () => {
    setup([conv('main', null), conv('vacio-principal', null, { started: false })], 'main', 'w1');
    let n = 0;
    const create = vi.spyOn(api, 'createConversation').mockImplementation(async (_p, _t, w) => conv(`n${++n}`, w ?? null, { started: false }));
    await useStore.getState().newConversation();
    expect(create).toHaveBeenCalledWith('p1', undefined, 'w1');
    expect(useStore.getState().conversations.find((c) => c.id === 'n1')?.worktreeId).toBe('w1');
    // En el directorio principal reutiliza su provisional en lugar de crear otro.
    await useStore.getState().newConversation('p1', null);
    expect(create).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeConversationId).toBe('vacio-principal');
  });

  it('elegir un worktree sin conversaciones lo deja activo y recuerda el espacio', async () => {
    setup([conv('main', null)], 'main');
    const saved = vi.spyOn(api, 'setSetting');
    await useStore.getState().selectSpace('p1', 'w1');
    const s = useStore.getState();
    expect([s.activeWorktreeId, s.activeConversationId]).toEqual(['w1', null]);
    expect(saved).toHaveBeenCalledWith('ui.lastWorktreeId', 'w1');
    await useStore.getState().selectProject('p1');
    expect(useStore.getState().activeWorktreeId).toBe(null);
  });

  it('la instrucción de integración informa sin ejecutar nada', () => {
    const text = integrationPrompt(worktree, {
      source: 'feat/pagos', target: 'main', ahead: 2, behind: 1, changed: 3, untracked: 1, files: ['a.ts'], conflicts: ['a.ts'], conflictsChecked: true,
    });
    expect(text).toContain('feat/pagos');
    expect(text).toContain('main');
    expect(text).toContain('a.ts');
    expect(text).toMatch(/no hagas push/);
  });
});

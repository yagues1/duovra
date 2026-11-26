/**
 * Estado del Context Engine 2.0 en la interfaz (1.0.11, fase 2).
 *
 * Separado del store principal: el estado del contexto se consulta bajo demanda (al montar el
 * indicador, al cambiar de agente y al terminar un turno), nunca mientras el usuario escribe. Los
 * eventos llegan por el mismo canal `run-event` que el resto de la ejecución.
 */
import { create } from 'zustand';
import { api, errorText } from '../lib/ipc';
import type { AgentId } from '../lib/types';
import type { Compaction, ContextPrefs, ContextStatus, Memory, MemoryDraft, ProposedMemory } from '../lib/context';
import { useStore, type RunEvent } from './store';
import { tr } from '../i18n';
import { AGENT_NAME } from '../lib/format';

/** Única superficie contextual: el gestor de memoria de una conversación (opcionalmente editando). */
export type ContextDialog = { kind: 'memory'; conversationId: string; edit?: MemoryDraft };

type CompactionEvent = { type: 'compaction'; conversationId: string; agent: AgentId; state: Compaction['state']; error?: string | null; detail?: Compaction };

interface ContextState {
  status: Record<string, ContextStatus | undefined>;
  /** Versión de los datos de cada conversación: sube al terminar un turno o cambiar la memoria. */
  version: Record<string, number>;
  compaction: Record<string, { agent: AgentId; state: Compaction['state']; error?: string | null } | undefined>;
  memories: Record<string, Memory[] | undefined>;
  dialog: ContextDialog | null;
  refreshStatus(conversationId: string, agent: AgentId, includeBlock?: boolean): Promise<ContextStatus | null>;
  loadMemories(conversationId: string): Promise<Memory[]>;
  saveMemory(conversationId: string, draft: MemoryDraft): Promise<Memory | null>;
  archiveMemory(memory: Memory, archived: boolean): Promise<void>;
  deleteMemory(memory: Memory): Promise<void>;
  importMemories(conversationId: string, sourceMessageId: string, items: ProposedMemory[], archive: string[]): Promise<boolean>;
  /** `mode: null` vuelve a usar el ajuste global; recuerdos y mensajes elegidos se conservan. */
  setPrefs(conversationId: string, prefs: Partial<Omit<ContextPrefs, 'mode'>> & { mode: ContextPrefs['mode'] | null }): Promise<void>;
  compact(conversationId: string, agent: AgentId): Promise<void>;
  open(dialog: ContextDialog): void;
  close(): void;
  onRunEvent(ev: RunEvent | CompactionEvent): void;
}

const key = (conversationId: string, agent: AgentId) => `${conversationId}:${agent}`;
const bump = (version: Record<string, number>, id: string) => ({ ...version, [id]: (version[id] ?? 0) + 1 });
const statusReads = new Map<string, symbol>();

export const useContextStore = create<ContextState>((set, get) => ({
  status: {},
  version: {},
  compaction: {},
  memories: {},
  dialog: null,

  async refreshStatus(conversationId, agent, includeBlock = false) {
    const k = key(conversationId, agent);
    const token = Symbol();
    statusReads.set(k, token);
    try {
      const status = await api.contextStatus(conversationId, agent, includeBlock);
      if (statusReads.get(k) !== token) return status;
      set((s) => ({
        status: { ...s.status, [k]: status },
        compaction: status.activeCompaction
          ? { ...s.compaction, [conversationId]: { agent: status.activeCompaction.agent, state: status.activeCompaction.state } }
          : s.compaction,
      }));
      return status;
    } catch {
      return null;
    } finally {
      if (statusReads.get(k) === token) statusReads.delete(k);
    }
  },

  async loadMemories(conversationId) {
    const list = await api.memoryList(conversationId, true);
    set((s) => ({ memories: { ...s.memories, [conversationId]: list } }));
    return list;
  },

  async saveMemory(conversationId, draft) {
    try {
      const saved = await api.memorySave({
        id: draft.id, conversationId, content: draft.content, category: draft.category, priority: draft.priority,
        origin: draft.id ? undefined : draft.origin ?? 'manual', sourceMessages: draft.id ? undefined : draft.sourceMessages ?? [],
      });
      set((s) => ({
        memories: { ...s.memories, [conversationId]: upsert(s.memories[conversationId] ?? [], saved) },
        version: bump(s.version, conversationId),
      }));
      return saved;
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
      return null;
    }
  },

  async archiveMemory(memory, archived) {
    try {
      const saved = await api.memoryArchive(memory.id, archived);
      set((s) => ({
        memories: { ...s.memories, [memory.conversationId]: upsert(s.memories[memory.conversationId] ?? [], saved) },
        version: bump(s.version, memory.conversationId),
      }));
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
    }
  },

  async deleteMemory(memory) {
    try {
      await api.memoryDelete(memory.id);
      set((s) => ({
        memories: { ...s.memories, [memory.conversationId]: (s.memories[memory.conversationId] ?? []).filter((m) => m.id !== memory.id) },
        version: bump(s.version, memory.conversationId),
      }));
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
    }
  },

  async importMemories(conversationId, sourceMessageId, items, archive) {
    try {
      await api.memoryImport(conversationId, sourceMessageId, items, archive);
      await get().loadMemories(conversationId);
      set((s) => ({ version: bump(s.version, conversationId) }));
      return true;
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
      return false;
    }
  },

  async setPrefs(conversationId, prefs) {
    try {
      const saved = await api.setContextPrefs(conversationId, prefs);
      useStore.setState((s) => ({ conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, contextPrefs: saved } : c)) }));
      set((s) => ({ version: bump(s.version, conversationId) }));
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
    }
  },

  async compact(conversationId, agent) {
    set((s) => ({ compaction: { ...s.compaction, [conversationId]: { agent, state: 'requested' } } }));
    try {
      await api.compactNative(conversationId, agent);
    } catch (e) {
      // El backend ya emitió el fallo; se informa por si el evento no llegó a esta vista.
      set((s) => ({ compaction: { ...s.compaction, [conversationId]: { agent, state: 'failed', error: errorText(e) } } }));
      useStore.getState().toast(errorText(e), 'error');
    }
  },


  open(dialog) {
    set({ dialog });
  },
  close() {
    set({ dialog: null });
  },

  onRunEvent(ev) {
    if (ev.type === 'compaction') {
      const terminal = ev.state === 'completed' || ev.state === 'failed' || ev.state === 'unknown';
      set((s) => ({
        compaction: { ...s.compaction, [ev.conversationId]: { agent: ev.agent, state: ev.state, error: ev.error } },
        version: terminal ? bump(s.version, ev.conversationId) : s.version,
      }));
      if (terminal) {
        const toast = useStore.getState().toast;
        if (ev.state === 'completed') toast(tr('{agent} compactó su contexto nativo.', { agent: AGENT_NAME[ev.agent] }));
        else if (ev.state === 'failed') toast(ev.error ? errorText(ev.error) : tr('No se pudo compactar el contexto de {agent}.', { agent: AGENT_NAME[ev.agent] }), 'error');
        else toast(tr('{agent} no confirmó el final de la compactación.', { agent: AGENT_NAME[ev.agent] }), 'error');
      }
      return;
    }
    if (ev.type === 'finished') set((s) => ({ version: bump(s.version, ev.conversationId) }));
  },
}));

function upsert(list: Memory[], m: Memory): Memory[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) return [m, ...list];
  const next = list.slice();
  next[i] = m;
  return next;
}


// Estado global de la interfaz (Zustand). El backend es la fuente de verdad: este almacén
// refleja la base de datos y los eventos de ejecución en curso.
import { create } from 'zustand';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errorText } from '../lib/ipc';
import { normalizeCatalog } from '../lib/catalog';
import type {
  Account,
  AgentDetection,
  AgentId,
  Approval,
  Conversation,
  Message,
  ModelCatalog,
  ModelInfo,
  Project,
  ProviderSession,
  RunView,
  Settings,
  TimelineItem,
} from '../lib/types';

export type View = 'chat' | 'projects' | 'settings';
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'conversations'
  | 'agents'
  | 'models'
  | 'accounts'
  | 'usage'
  | 'updates'
  | 'data';

export interface PanelTab {
  id: string;
  kind: 'file' | 'diff' | 'terminal' | 'details';
  title: string;
  payload: Record<string, unknown>;
}

export interface ComposerPrefs {
  agent: AgentId;
  model: string;
  effort: string | null;
  /**
   * AUD-004: el modelo guardado para este agente ya no figura en su catálogo. No se cambia en
   * silencio: el compositor lo anuncia y no envía hasta que el usuario confirma o elige otro.
   */
  replaced?: { from: string } | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

type CatalogState = ModelCatalog | { error: string } | 'loading';

interface State {
  ready: boolean;
  bootError: string | null;
  appVersion: string;
  projects: Project[];
  conversations: Conversation[];
  accounts: Account[];
  settings: Settings;
  savedPulse: number;
  activeProjectId: string | null;
  activeConversationId: string | null;
  view: View;
  settingsSection: SettingsSection;
  messages: Record<string, Message[]>;
  sessions: Record<string, ProviderSession[]>;
  runs: Record<string, RunView>;
  catalogs: Partial<Record<AgentId, CatalogState>>;
  detection: AgentDetection[] | null;
  prefs: Record<string, ComposerPrefs>;
  panel: { open: boolean; tabs: PanelTab[]; active: string | null };
  /** Barra lateral como cajón superpuesto en ventanas estrechas (AUD-002). */
  navDrawer: boolean;
  toasts: Toast[];

  init: () => Promise<void>;
  setView: (v: View, section?: SettingsSection) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  setSetting: (key: string, value: unknown) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  addProject: () => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newConversation: (projectId?: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshCatalog: (agent: AgentId, refresh?: boolean) => Promise<void>;
  refreshDetection: () => Promise<void>;
  setPrefs: (conversationId: string, patch: Partial<ComposerPrefs>) => void;
  saveDraft: (conversationId: string, draft: string) => void;
  /** Escribe ya los borradores pendientes (antes de cerrar para actualizar). */
  flushDrafts: () => Promise<void>;
  send: (conversationId: string, text: string, attachments: string[]) => Promise<boolean>;
  cancel: (conversationId: string) => Promise<void>;
  respondApproval: (conversationId: string, approvalId: string, decision: Approval['info']['options'][number]) => Promise<void>;
  openTab: (tab: PanelTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setAccounts: (a: Account[]) => void;
  setNavDrawer: (open: boolean) => void;
  handleRunEvent: (ev: RunEvent) => void;
}

export type RunEvent =
  | { type: 'item'; runId: string; conversationId: string; item: TimelineItem }
  | { type: 'delta'; runId: string; conversationId: string; itemId: string; kind: 'text' | 'reasoning'; delta: string }
  | { type: 'output'; runId: string; conversationId: string; itemId: string; delta: string }
  | { type: 'usage'; runId: string; conversationId: string; usage: RunView['usage'] }
  | { type: 'session'; runId: string; sessionId: string }
  | { type: 'model'; runId: string; model: string }
  | { type: 'approval'; runId: string; conversationId: string; approvalId: string; approval: Approval['info'] }
  | { type: 'approvalResolved'; runId: string; approvalId: string; decision: string }
  | { type: 'contextNote'; messageId: string; note: Message['contextNote'] }
  | { type: 'finished'; runId: string; conversationId: string; status: string; message: Message | null }
  | { type: 'rateLimits'; agent: AgentId; data: unknown };

let toastSeq = 0;
let initStarted = false;
const draftTimers = new Map<string, number>();

export function catalogModels(c: CatalogState | undefined): ModelInfo[] {
  return c && c !== 'loading' && 'models' in c && Array.isArray(c.models) ? c.models : [];
}

function upsertItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i === -1) return [...items, item];
  const next = items.slice();
  next[i] = { ...items[i], ...item };
  return next;
}

function runOf(state: State, runId: string): RunView | undefined {
  for (const r of Object.values(state.runs)) if (r.runId === runId) return r;
  return undefined;
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  bootError: null,
  appVersion: '',
  projects: [],
  conversations: [],
  accounts: [],
  settings: {},
  savedPulse: 0,
  activeProjectId: null,
  activeConversationId: null,
  view: 'chat',
  settingsSection: 'general',
  messages: {},
  sessions: {},
  runs: {},
  catalogs: {},
  detection: null,
  prefs: {},
  panel: { open: false, tabs: [], active: null },
  navDrawer: false,
  toasts: [],

  async init() {
    if (initStarted) return;
    initStarted = true;
    try {
      const b = await api.bootstrap();
      const prefs: Record<string, ComposerPrefs> = {};
      set({
        projects: b.projects,
        conversations: b.conversations,
        accounts: b.accounts,
        settings: b.settings,
        appVersion: b.appVersion,
        prefs,
        ready: true,
      });
      const s = b.settings;
      // Inicio: «last» (predeterminado) restaura proyecto y conversación; «projects» abre la vista
      // de proyectos. Con la restauración desactivada solo se elige el último proyecto.
      const restore = s['startup.restoreConversation'] !== false;
      if (s['startup.view'] === 'projects') set({ view: 'projects' });
      const lastProject = b.projects.find((p) => p.id === s['ui.lastProjectId']) ?? b.projects[0];
      if (lastProject) {
        set({ activeProjectId: lastProject.id });
        const lastConv =
          b.conversations.find((c) => c.id === s['ui.lastConversationId'] && c.projectId === lastProject.id) ??
          b.conversations.find((c) => c.projectId === lastProject.id);
        if (lastConv && restore) {
          const view = get().view;
          await get().selectConversation(lastConv.id);
          if (view === 'projects') set({ view });
        }
      }
      void get().refreshDetection();
      void get().refreshCatalog('codex');
      void get().refreshCatalog('claude');
    } catch (e) {
      set({ bootError: errorText(e), ready: true });
    }
  },

  setView(view, section) {
    set(section ? { view, settingsSection: section, navDrawer: false } : { view, navDrawer: false });
  },

  toast(text, tone = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6500 : 3200);
  },

  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    try {
      await api.setSetting(key, value);
      if (!key.startsWith('ui.')) set((s) => ({ savedPulse: s.savedPulse + 1 }));
    } catch (e) {
      get().toast(`No se pudo guardar el ajuste: ${errorText(e)}`, 'error');
    }
  },

  async selectProject(id) {
    set({ activeProjectId: id, view: 'chat' });
    void api.setSetting('ui.lastProjectId', id);
    const conv = get()
      .conversations.filter((c) => c.projectId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (conv) await get().selectConversation(conv.id);
    else set({ activeConversationId: null });
  },

  async selectConversation(id) {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    set({ activeConversationId: id, activeProjectId: conv.projectId, view: 'chat', navDrawer: false });
    void api.setSetting('ui.lastConversationId', id);
    void api.setSetting('ui.lastProjectId', conv.projectId);
    try {
      const { messages, sessions } = await api.listMessages(id);
      set((s) => ({ messages: { ...s.messages, [id]: messages }, sessions: { ...s.sessions, [id]: sessions } }));
    } catch (e) {
      get().toast(`No se pudo cargar la conversación: ${errorText(e)}`, 'error');
    }
  },

  async addProject() {
    const path = await openDialog({ directory: true, multiple: false, title: 'Elige la carpeta del proyecto' });
    if (!path || Array.isArray(path)) return;
    try {
      const project = await api.createProject('', path);
      set((s) => ({ projects: [...s.projects, project] }));
      await get().selectProject(project.id);
      await get().newConversation(project.id);
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async renameProject(id, name) {
    try {
      await api.renameProject(id, name);
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) }));
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async deleteProject(id) {
    try {
      await api.deleteProject(id);
      const { activeProjectId } = get();
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        conversations: s.conversations.filter((c) => c.projectId !== id),
      }));
      if (activeProjectId === id) {
        const next = get().projects[0];
        if (next) await get().selectProject(next.id);
        else set({ activeProjectId: null, activeConversationId: null });
      }
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async newConversation(projectId) {
    const pid = projectId ?? get().activeProjectId;
    if (!pid) return;
    try {
      const conv = await api.createConversation(pid);
      set((s) => ({ conversations: [conv, ...s.conversations], messages: { ...s.messages, [conv.id]: [] } }));
      await get().selectConversation(conv.id);
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async renameConversation(id, title) {
    try {
      await api.renameConversation(id, title);
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)) }));
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async deleteConversation(id) {
    try {
      await api.deleteConversation(id);
      const wasActive = get().activeConversationId === id;
      const conv = get().conversations.find((c) => c.id === id);
      set((s) => {
        const messages = { ...s.messages };
        delete messages[id];
        return { conversations: s.conversations.filter((c) => c.id !== id), messages };
      });
      if (wasActive) {
        const next = get().conversations.find((c) => c.projectId === conv?.projectId);
        if (next) await get().selectConversation(next.id);
        else set({ activeConversationId: null });
      }
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async refreshCatalog(agent, refresh = false) {
    set((s) => ({ catalogs: { ...s.catalogs, [agent]: 'loading' } }));
    try {
      const c = normalizeCatalog(await api.agentModels(agent, refresh));
      set((s) => ({ catalogs: { ...s.catalogs, [agent]: c } }));
    } catch (e) {
      set((s) => ({ catalogs: { ...s.catalogs, [agent]: { error: errorText(e) } } }));
    }
  },

  async refreshDetection() {
    try {
      set({ detection: await api.detectAgents() });
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  setPrefs(conversationId, patch) {
    const cur = get().prefs[conversationId];
    if (!cur) return;
    const next: ComposerPrefs = { ...cur, ...patch };
    // Mientras haya un reemplazo pendiente de confirmar no se guarda el modelo sustituto: la
    // preferencia del usuario sigue siendo la original hasta que decida.
    const persist = !!next.model && !next.replaced;
    set((s) => ({
      prefs: { ...s.prefs, [conversationId]: next },
      conversations: s.conversations.map((c) =>
        c.id !== conversationId
          ? c
          : persist
            ? {
                ...c,
                lastAgent: next.agent,
                lastModel: next.model,
                lastEffort: next.effort,
                agentPrefs: { ...c.agentPrefs, [next.agent]: { model: next.model, effort: next.effort } },
              }
            : { ...c, lastAgent: next.agent },
      ),
    }));
    if (persist) void api.setConversationPrefs(conversationId, next.agent, next.model, next.effort);
  },

  saveDraft(conversationId, draft) {
    set((s) => ({ conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, draft } : c)) }));
    const t = draftTimers.get(conversationId);
    if (t) window.clearTimeout(t);
    draftTimers.set(
      conversationId,
      window.setTimeout(() => {
        draftTimers.delete(conversationId);
        void api.setDraft(conversationId, draft);
      }, 350),
    );
  },

  async flushDrafts() {
    const pending = [...draftTimers.entries()];
    draftTimers.clear();
    await Promise.all(
      pending.map(([id, timer]) => {
        window.clearTimeout(timer);
        const draft = get().conversations.find((c) => c.id === id)?.draft ?? '';
        return api.setDraft(id, draft).catch(() => undefined);
      }),
    );
  },

  async send(conversationId, text, attachments) {
    const prefs = get().prefs[conversationId];
    if (!prefs) return false;
    if (get().runs[conversationId]) {
      get().toast('El agente sigue trabajando. Detén la ejecución o espera a que termine.', 'error');
      return false;
    }
    try {
      const r = await api.sendMessage({
        conversationId,
        agent: prefs.agent,
        model: prefs.model,
        effort: prefs.effort,
        text,
        attachments,
      });
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: [...(s.messages[conversationId] ?? []), r.userMessage, r.assistantMessage],
        },
        runs: {
          ...s.runs,
          [conversationId]: {
            runId: r.runId,
            conversationId,
            messageId: r.assistantMessage.id,
            agent: prefs.agent,
            model: prefs.model,
            items: [],
            usage: null,
            approvals: [],
            startedAt: Date.now(),
          },
        },
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, updatedAt: Date.now(), draft: '', title: r.renamedTitle ?? c.title }
            : c,
        ),
      }));
      get().saveDraft(conversationId, '');
      return true;
    } catch (e) {
      get().toast(errorText(e), 'error');
      return false;
    }
  },

  async cancel(conversationId) {
    const run = get().runs[conversationId];
    if (!run) return;
    set((s) => ({ runs: { ...s.runs, [conversationId]: { ...run, stopping: true } } }));
    try {
      await api.cancelRun(run.runId);
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async respondApproval(conversationId, approvalId, decision) {
    try {
      await api.respondApproval(approvalId, decision);
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
    set((s) => {
      const run = s.runs[conversationId];
      if (!run) return {};
      return { runs: { ...s.runs, [conversationId]: { ...run, approvals: run.approvals.filter((a) => a.approvalId !== approvalId) } } };
    });
  },

  openTab(tab) {
    set((s) => {
      const exists = s.panel.tabs.some((t) => t.id === tab.id);
      const tabs = exists ? s.panel.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...s.panel.tabs, tab].slice(-8);
      return { panel: { open: true, tabs, active: tab.id } };
    });
  },
  closeTab(id) {
    set((s) => {
      const tabs = s.panel.tabs.filter((t) => t.id !== id);
      const active = s.panel.active === id ? (tabs[tabs.length - 1]?.id ?? null) : s.panel.active;
      return { panel: { open: tabs.length > 0 && s.panel.open, tabs, active } };
    });
  },
  setActiveTab(id) {
    set((s) => ({ panel: { ...s.panel, active: id } }));
  },
  closePanel() {
    set((s) => ({ panel: { ...s.panel, open: false } }));
  },
  togglePanel() {
    set((s) => ({ panel: { ...s.panel, open: !s.panel.open && s.panel.tabs.length > 0 } }));
  },
  setAccounts(accounts) {
    set({ accounts });
  },
  setNavDrawer(navDrawer) {
    set({ navDrawer });
  },

  handleRunEvent(ev) {
    const state = get();
    switch (ev.type) {
      case 'item':
      case 'delta':
      case 'output': {
        const run = state.runs[ev.conversationId];
        if (!run || run.runId !== ev.runId) return;
        let items = run.items;
        if (ev.type === 'item') items = upsertItem(items, ev.item);
        else {
          const i = items.findIndex((x) => x.id === ev.itemId);
          if (ev.type === 'delta') {
            if (i === -1) items = [...items, { id: ev.itemId, kind: ev.kind, status: 'running', text: ev.delta }];
            else {
              items = items.slice();
              items[i] = { ...items[i], text: (items[i].text ?? '') + ev.delta };
            }
          } else if (i !== -1) {
            items = items.slice();
            items[i] = { ...items[i], output: (items[i].output ?? '') + ev.delta };
          }
        }
        set({ runs: { ...state.runs, [ev.conversationId]: { ...run, items } } });
        return;
      }
      case 'usage': {
        const run = state.runs[ev.conversationId];
        if (run && run.runId === ev.runId) set({ runs: { ...state.runs, [ev.conversationId]: { ...run, usage: ev.usage } } });
        return;
      }
      case 'model': {
        const run = runOf(state, ev.runId);
        if (run) set({ runs: { ...state.runs, [run.conversationId]: { ...run, resolvedModel: ev.model } } });
        return;
      }
      case 'approval': {
        const run = state.runs[ev.conversationId];
        if (!run || run.runId !== ev.runId) return;
        set({
          runs: {
            ...state.runs,
            [ev.conversationId]: { ...run, approvals: [...run.approvals, { approvalId: ev.approvalId, info: ev.approval }] },
          },
        });
        return;
      }
      case 'approvalResolved': {
        const run = runOf(state, ev.runId);
        if (run)
          set({
            runs: {
              ...state.runs,
              [run.conversationId]: { ...run, approvals: run.approvals.filter((a) => a.approvalId !== ev.approvalId) },
            },
          });
        return;
      }
      case 'contextNote': {
        const next: Record<string, Message[]> = {};
        for (const [cid, list] of Object.entries(state.messages)) {
          if (list.some((m) => m.id === ev.messageId))
            next[cid] = list.map((m) => (m.id === ev.messageId ? { ...m, contextNote: ev.note } : m));
        }
        set({ messages: { ...state.messages, ...next } });
        return;
      }
      case 'finished': {
        notifyFinished(state, ev.conversationId, ev.status);
        const runs = { ...state.runs };
        delete runs[ev.conversationId];
        const list = state.messages[ev.conversationId] ?? [];
        const msg = ev.message;
        set({
          runs,
          messages: msg
            ? { ...state.messages, [ev.conversationId]: list.map((m) => (m.id === msg.id ? msg : m)) }
            : state.messages,
          conversations: state.conversations.map((c) =>
            c.id === ev.conversationId ? { ...c, updatedAt: Date.now() } : c,
          ),
        });
        void api.listMessages(ev.conversationId).then(({ sessions }) =>
          set((s) => ({ sessions: { ...s.sessions, [ev.conversationId]: sessions } })),
        );
        return;
      }
      default:
        return;
    }
  },
}));

/**
 * Avisos al terminar una tarea (Ajustes → Notificaciones): un aviso dentro de la aplicación si la
 * conversación no está a la vista, y una petición de atención en la barra de tareas de Windows si
 * la ventana está en segundo plano. Nunca se avisa de una ejecución detenida por el usuario.
 */
function notifyFinished(state: State, conversationId: string, status: string) {
  if (status === 'cancelled' || status === 'interrupted') return;
  const conv = state.conversations.find((c) => c.id === conversationId);
  const visible = state.view === 'chat' && state.activeConversationId === conversationId && document.hasFocus();
  if (state.settings['notify.taskToast'] !== false && conv && !visible) {
    const failed = status === 'failed' || status === 'error';
    state.toast(failed ? `«${conv.title}» terminó con un error.` : `«${conv.title}» ha terminado.`, failed ? 'error' : 'info');
  }
  if (state.settings['notify.taskAttention'] !== false && !document.hasFocus()) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow, UserAttentionType }) => getCurrentWindow().requestUserAttention(UserAttentionType.Informational))
      .catch(() => undefined);
  }
}

/**
 * Preferencias efectivas del compositor para una conversación (agente, modelo y esfuerzo).
 *
 * AUD-004: cada conversación recuerda una combinación independiente por agente
 * (`conv.agentPrefs`), así que alternar Claude ↔ Codex recupera la última elección de cada uno,
 * también tras reiniciar. Orden de preferencia para el modelo: lo último usado con ese agente en
 * la conversación → el predeterminado del usuario para ese agente → el recomendado del catálogo.
 * Si el modelo guardado ya no existe, se propone el sustituto marcándolo en `replaced`.
 */
export function resolvePrefs(conv: Conversation, s: Pick<State, 'settings' | 'catalogs'>, agentOverride?: AgentId): ComposerPrefs {
  const agent: AgentId = agentOverride ?? conv.lastAgent ?? (s.settings['defaults.agent'] as AgentId) ?? 'codex';
  const models = catalogModels(s.catalogs[agent]);
  const saved = conv.agentPrefs?.[agent] ?? (agent === conv.lastAgent && conv.lastModel ? { model: conv.lastModel, effort: conv.lastEffort } : null);
  const fromSaved = !!saved?.model;
  const wanted = saved?.model || (s.settings[`defaults.model.${agent}`] as string | undefined) || '';
  const found = models.find((m) => m.id === wanted);
  const fallback = models.find((m) => m.isDefault) ?? models[0];
  const model = found?.id ?? (models.length ? (fallback?.id ?? '') : wanted);
  const info = models.find((m) => m.id === model);
  const wantedEffort = (fromSaved ? saved?.effort : null) ?? (s.settings[`defaults.effort.${agent}`] as string | undefined) ?? null;
  const efforts = info?.efforts ?? [];
  const effort = info && efforts.length ? (wantedEffort && efforts.includes(wantedEffort) ? wantedEffort : (info.defaultEffort ?? null)) : wantedEffort;
  const replaced = fromSaved && models.length > 0 && !found && wanted ? { from: wanted } : null;
  return { agent, model, effort, replaced };
}

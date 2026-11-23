// Estado global de la interfaz (Zustand). El backend es la fuente de verdad: este almacén
// refleja la base de datos y los eventos de ejecución en curso.
import { create } from 'zustand';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errorText, type SendResult } from '../lib/ipc';
import { normalizeCatalog } from '../lib/catalog';
import type { VisualSource } from '../lib/visual/types';
import type { ActivityFinish } from '../lib/activity';
import type { WidgetView } from '../lib/widgets/view';
import { confirmBackgroundNavigation } from './backgroundNavigation';
import { restoreNoticeText } from '../lib/backups';
import { approvalNoticeKey, finishedKind, isConversationInView, runNoticeKey, type NativeNotice } from '../lib/nativeNotices';
import type { BackgroundSelection } from '../lib/background';
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
  QueueAction,
  QueueView,
  SendRequest,
  RunView,
  Settings,
  TimelineItem,
} from '../lib/types';
import { getLocale, tr } from '../i18n';
import { displayTitle } from '../lib/format';

/** Vista principal. Ajustes ya no es una vista: se superpone a la actual (`settingsOpen`). */
export type View = 'chat' | 'projects';
/** Secciones de Ajustes en 0.6.0 (de nueve a siete, ordenadas por utilidad). */
export type SettingsSection = 'appearance' | 'conversations' | 'agents' | 'accounts' | 'statistics' | 'updates' | 'data';
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['appearance', 'conversations', 'agents', 'accounts', 'statistics', 'updates', 'data'];
/** Secciones de 0.5.1 que se fusionaron: los enlaces antiguos llevan a su nueva sección. */
const LEGACY_SECTION: Record<string, SettingsSection> = { general: 'conversations', models: 'agents', usage: 'accounts', background: 'appearance' };

export function asSection(v: unknown): SettingsSection {
  if (typeof v !== 'string') return 'appearance';
  if ((SETTINGS_SECTIONS as readonly string[]).includes(v)) return v as SettingsSection;
  return LEGACY_SECTION[v] ?? 'appearance';
}

export type PanelTab = { id: string; title: string } & (
  | { kind: 'file' | 'diff' | 'terminal' | 'details' | 'gitDiff'; payload: Record<string, unknown> }
  | { kind: 'visual'; payload: { source: VisualSource; conversationId: string | null; returnTo: string | null } }
  | { kind: 'widget'; payload: { view: WidgetView; conversationId: string; returnTo: string | null } }
);

export interface ComposerPrefs {
  agent: AgentId;
  model: string;
  effort: string | null;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

function closeConversationWidgets(panel: State['panel']): State['panel'] {
  const active = panel.tabs.find((tab) => tab.id === panel.active);
  const tabs = panel.tabs.filter((tab) => tab.kind !== 'widget');
  if (tabs.length === panel.tabs.length) return panel;
  if (active?.kind !== 'widget') return { ...panel, tabs };
  const previous = active.payload.returnTo;
  return { ...panel, tabs, active: previous === null || previous === 'git' || tabs.some((tab) => tab.id === previous) ? previous : 'files' };
}

type CatalogState = ModelCatalog | { error: string } | 'loading';

interface State {
  ready: boolean;
  bootError: string | null;
  appVersion: string;
  qaMode?: 'native' | 'fixture' | null;
  projects: Project[];
  conversations: Conversation[];
  accounts: Account[];
  settings: Settings;
  savedPulse: number;
  activeProjectId: string | null;
  activeConversationId: string | null;
  view: View;
  /** Ajustes abiertos como diálogo sobre la vista actual, que sigue montada detrás. */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /**
   * Fondo en edición: se pinta ya en la conversación real, detrás de Ajustes, y nunca se guarda
   * hasta pulsar Aplicar (null: se ve el fondo guardado).
   */
  backgroundDraft: BackgroundSelection | null;
  /** Cuándo cambió por última vez el borrador: el fondo de detrás se anima unos segundos para mostrarlo. */
  backgroundChangedAt: number;
  /** «Mirar el fondo» pulsado: el diálogo se aparta y el fondo se anima. */
  settingsPeek: boolean;
  messages: Record<string, Message[]>;
  sessions: Record<string, ProviderSession[]>;
  runs: Record<string, RunView>;
  activityFinish: ActivityFinish | undefined;
  queues: Record<string, QueueView>;
  catalogs: Partial<Record<AgentId, CatalogState>>;
  detection: AgentDetection[] | null;
  prefs: Record<string, ComposerPrefs>;
  chatFind: { conversationId: string; query: string; request: number; messageId?: string } | null;
  focusConversationId: string | null;
  openChatFind: (query?: string, messageId?: string) => void;
  closeChatFind: () => void;
  panel: { open: boolean; tabs: PanelTab[]; active: string | null };
  /** Barra lateral como cajón superpuesto en ventanas estrechas (AUD-002). */
  navDrawer: boolean;
  toasts: Toast[];

  init: () => Promise<void>;
  setView: (v: View | 'settings', section?: SettingsSection | string) => void;
  /** Cierra Ajustes (con la confirmación de un fondo sin aplicar). Devuelve si se cerró. */
  closeSettings: () => Promise<boolean>;
  setBackgroundDraft: (draft: BackgroundSelection | null) => void;
  setSettingsPeek: (peek: boolean) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  setSetting: (key: string, value: unknown, requirePersistence?: boolean) => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  selectConversation: (id: string, focusHeading?: boolean) => Promise<void>;
  addProject: () => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  newConversation: (projectId?: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshCatalog: (agent: AgentId, refresh?: boolean) => Promise<void>;
  refreshDetection: () => Promise<void>;
  setPrefs: (conversationId: string, patch: Partial<ComposerPrefs>, expected?: ComposerPrefs) => void;
  saveDraft: (conversationId: string, draft: string) => void;
  saveDraftAttachments: (conversationId: string, update: (paths: string[]) => string[]) => void;
  refreshQueue: (conversationId: string) => Promise<void>;
  enqueue: (conversationId: string, text: string, attachments: string[], defer: boolean) => Promise<boolean>;
  editQueued: (id: string, request: SendRequest, replaceTarget: boolean, accountId: string | null) => Promise<boolean>;
  updateQueue: (conversationId: string, action: QueueAction) => Promise<boolean>;
  /** Escribe ya los borradores pendientes (antes de cerrar para actualizar). */
  flushDrafts: () => Promise<void>;
  send: (conversationId: string, text: string, attachments: string[]) => Promise<boolean>;
  steer: (runId: string, text: string, attachments: string[]) => Promise<boolean>;
  cancel: (conversationId: string) => Promise<void>;
  respondApproval: (conversationId: string, approvalId: string, decision: Approval['info']['options'][number]) => Promise<void>;
  openTab: (tab: PanelTab) => void;
  openPanel: (view?: 'files' | 'git') => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setAccounts: (a: Account[]) => void;
  setNavDrawer: (open: boolean) => void;
  handleRunEvent: (ev: RunEvent) => void;
}

export type RunEvent =
  | ({ type: 'started'; conversationId: string } & SendResult)
  | { type: 'queueChanged'; conversationId: string }
  | { type: 'runReady'; runId: string; conversationId: string; steerable: boolean }
  | { type: 'historyMessage'; conversationId: string; message: Message }
  | { type: 'queueError'; conversationId: string; message: string }
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
/** Último texto tecleado de cada conversación aún no sincronizado con el estado (ver saveDraft). */
const pendingDrafts = new Map<string, string>();
const catalogReads = new Map<AgentId, symbol>();
const preferenceWrites = new Map<string, Promise<unknown>>();
const draftWrites = new Map<string, Promise<unknown>>();
const queueReads = new Map<string, symbol>();
const draftAttachmentWrites = new Map<string, Promise<void>>();
const pendingSends = new Map<string, { events: RunEvent[]; renamedManually: boolean }>();

/** Borrador vigente de una conversación: el tecleado más reciente o el guardado. */
export function draftOf(conv: Conversation): string {
  return pendingDrafts.get(conv.id) ?? conv.draft;
}

export function catalogModels(c: CatalogState | undefined): ModelInfo[] {
  return c && c !== 'loading' && 'models' in c && Array.isArray(c.models) ? c.models : [];
}

function mergeMessages(previous: Message[], incoming: Message[]): Message[] {
  const unique = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) unique.set(message.id, message);
  return [...unique.values()].sort((a, b) => a.seq - b.seq);
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

// También ordena el IPC de envío, que registra la combinación enviada en SQLite.
function writeInOrder<T>(writes: Map<string, Promise<unknown>>, id: string, write: () => Promise<T>) {
  const pending = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(write).finally(() => {
    if (writes.get(id) === pending) writes.delete(id);
  });
  writes.set(id, pending);
  return pending;
}

function writeDraft(id: string, draft: string) {
  return writeInOrder(draftWrites, id, async () => {
    try {
      await api.setDraft(id, draft);
    } catch {
      throw new Error(tr('No se pudo guardar el borrador. Comprueba el acceso a los datos e inténtalo de nuevo.'));
    }
    if (pendingDrafts.get(id) === draft) pendingDrafts.delete(id);
  });
}

function rememberPrefs(conv: Conversation, prefs: ComposerPrefs, saveModel: boolean): Conversation {
  const saved = saveModel ? { model: prefs.model, effort: prefs.effort } : conv.agentPrefs?.[prefs.agent];
  const previous = conv.lastAgent === prefs.agent;
  return {
    ...conv,
    lastAgent: prefs.agent,
    lastModel: saved?.model ?? (previous ? conv.lastModel : null),
    lastEffort: saved ? saved.effort : previous ? conv.lastEffort : null,
    agentPrefs: saveModel && saved ? { ...conv.agentPrefs, [prefs.agent]: saved } : conv.agentPrefs,
  };
}

/**
 * Velocidad del próximo mensaje: el modo rápido solo se pide si el modelo lo publica. Cuando el
 * modelo ofrece niveles, «estándar» se envía explícitamente para no heredar otro nivel del hilo.
 */
export function speedFor(prefs: ComposerPrefs, catalog: CatalogState | undefined, settings: Settings): string | null {
  const fast = catalogModels(catalog).find((entry) => entry.id === prefs.model)?.fast;
  if (!fast) return null;
  return settings['composer.fast'] === true ? fast.id : 'default';
}

export function canDispatch(prefs: ComposerPrefs, catalog: CatalogState | undefined): boolean {
  const model = catalogModels(catalog).find((entry) => entry.id === prefs.model);
  return !!model && (prefs.effort === null || model.efforts.includes(prefs.effort));
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
  settingsOpen: false,
  settingsSection: 'appearance',
  backgroundDraft: null,
  backgroundChangedAt: 0,
  settingsPeek: false,
  messages: {},
  sessions: {},
  runs: {},
  activityFinish: undefined,
  queues: {},
  catalogs: {},
  detection: null,
  prefs: {},
  chatFind: null,
  focusConversationId: null,
  panel: { open: false, tabs: [], active: null },
  navDrawer: false,
  toasts: [],

  async init() {
    if (initStarted) return;
    initStarted = true;
    try {
      const b = await api.bootstrap();
      if (b.restoreNotice) {
        const notice = restoreNoticeText(b.restoreNotice);
        get().toast(notice.text, notice.tone);
      }
      set({
        projects: b.projects,
        conversations: b.conversations,
        accounts: b.accounts,
        settings: b.settings,
        appVersion: b.appVersion,
        qaMode: b.qaMode,
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
          const history = get().selectConversation(lastConv.id);
          if (view === 'projects') set({ view });
          void history;
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
    const nextSection = section ? asSection(section) : get().settingsSection;
    if (view === 'settings') {
      // Abrir Ajustes no toca la vista: la conversación y su desplazamiento siguen detrás.
      const navigate = () => set({ settingsOpen: true, settingsSection: nextSection, navDrawer: false });
      const leaving = get().settingsOpen && nextSection !== 'appearance' && confirmBackgroundNavigation();
      if (leaving) void leaving.then((accepted) => { if (accepted) navigate(); });
      else navigate();
      return;
    }
    const navigate = () => set({ view, settingsOpen: false, navDrawer: false });
    const leaving = confirmBackgroundNavigation();
    if (leaving) void leaving.then((accepted) => { if (accepted) navigate(); });
    else navigate();
  },

  async closeSettings() {
    if (!get().settingsOpen) return true;
    const leaving = confirmBackgroundNavigation(tr('Cerrar Ajustes'));
    if (leaving && !(await leaving)) return false;
    set({ settingsOpen: false, backgroundDraft: null, settingsPeek: false });
    return true;
  },

  setBackgroundDraft(backgroundDraft) {
    set({ backgroundDraft, backgroundChangedAt: Date.now() });
  },

  setSettingsPeek(settingsPeek) {
    set({ settingsPeek });
  },

  toast(text, tone = 'info') {
    const id = ++toastSeq;
    // Un aviso idéntico sustituye al visible en lugar de apilarse (p. ej. varios envíos a la cola).
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text || t.tone !== tone), { id, text, tone }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6500 : 3200);
  },

  async setSetting(key, value, requirePersistence = false) {
    const remember = () => set((s) => ({ settings: { ...s.settings, [key]: value } }));
    if (!requirePersistence) remember();
    try {
      await api.setSetting(key, value);
      if (requirePersistence) remember();
      if (!key.startsWith('ui.')) set((s) => ({ savedPulse: s.savedPulse + 1 }));
    } catch (e) {
      if (requirePersistence) throw e;
      get().toast(tr('No se pudo guardar el ajuste: {error}', { error: errorText(e) }), 'error');
    }
  },

  async selectProject(id) {
    const leaving = confirmBackgroundNavigation();
    if (leaving && !(await leaving)) return;
    set((s) => ({
      activeProjectId: id, view: 'chat', settingsOpen: false, chatFind: null,
      ...(s.activeProjectId !== id ? { activeConversationId: null, activityFinish: undefined, panel: { ...s.panel, tabs: [], active: null } } : {}),
    }));
    void api.setSetting('ui.lastProjectId', id);
    const conv = get()
      .conversations.filter((c) => c.projectId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (conv) await get().selectConversation(conv.id);
    else set((s) => ({ activeConversationId: null, activityFinish: undefined, panel: closeConversationWidgets(s.panel) }));
  },

  async selectConversation(id, focusHeading) {
    const conv = get().conversations.find((c) => c.id === id);
    if (!conv) return;
    const leaving = confirmBackgroundNavigation();
    if (leaving && !(await leaving)) return;
    set((s) => ({
      activeConversationId: id, activeProjectId: conv.projectId, view: 'chat', settingsOpen: false, navDrawer: false, chatFind: null,
      focusConversationId: focusHeading ? id : null,
      activityFinish: s.activeConversationId === id ? s.activityFinish : undefined,
      prefs: s.prefs[id] ? s.prefs : { ...s.prefs, [id]: resolvePrefs(conv, s) },
      ...(s.activeProjectId !== conv.projectId ? { panel: { ...s.panel, tabs: [], active: null } }
        : s.activeConversationId !== id ? { panel: closeConversationWidgets(s.panel) } : {}),
    }));
    void api.setSetting('ui.lastConversationId', id);
    void api.setSetting('ui.lastProjectId', conv.projectId);
    const snapshot = get().messages[id];
    const queue = get().refreshQueue(id);
    try {
      const { messages, sessions } = await api.listMessages(id);
      set((s) => ({
        messages: {
          ...s.messages,
          [id]: s.messages[id] === snapshot ? messages : mergeMessages(messages, s.messages[id] ?? []),
        },
        sessions: { ...s.sessions, [id]: sessions },
      }));
    } catch (e) {
      get().toast(tr('No se pudo cargar la conversación: {error}', { error: errorText(e) }), 'error');
    }
    await queue;
  },

  async addProject() {
    const path = await openDialog({ directory: true, multiple: false, title: tr('Elige la carpeta del proyecto') });
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
      set((s) => {
        const prefs = { ...s.prefs };
        for (const conv of s.conversations) if (conv.projectId === id) delete prefs[conv.id];
        return {
          projects: s.projects.filter((p) => p.id !== id),
          conversations: s.conversations.filter((c) => c.projectId !== id),
          prefs,
        };
      });
      if (activeProjectId === id) {
        const next = get().projects[0];
        if (next) await get().selectProject(next.id);
        else set((s) => ({ activeProjectId: null, activeConversationId: null, activityFinish: undefined, panel: closeConversationWidgets(s.panel) }));
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
      const pending = pendingSends.get(id);
      if (pending) pending.renamedManually = true;
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: title.trim() } : c)) }));
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
        const prefs = { ...s.prefs };
      delete prefs[id];
      return { conversations: s.conversations.filter((c) => c.id !== id), messages, prefs };
      });
      if (wasActive) {
        const next = get().conversations.find((c) => c.projectId === conv?.projectId);
        if (next) await get().selectConversation(next.id);
        else set((s) => ({ activeConversationId: null, activityFinish: undefined, panel: closeConversationWidgets(s.panel) }));
      }
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  async refreshCatalog(agent, refresh = false) {
    const token = Symbol();
    catalogReads.set(agent, token);
    set((s) => ({ catalogs: { ...s.catalogs, [agent]: 'loading' } }));
    let result: CatalogState;
    try {
      result = normalizeCatalog(await api.agentModels(agent, refresh));
    } catch (e) {
      result = { error: errorText(e) };
    }
    if (catalogReads.get(agent) !== token) return;
    catalogReads.delete(agent);
    set((s) => {
      const catalogs = { ...s.catalogs, [agent]: result };
      if (!catalogModels(result).length) return { catalogs };
      const source = { settings: s.settings, catalogs };
      const prefs = { ...s.prefs };
      for (const conv of s.conversations) {
        const selected = prefs[conv.id];
        // Rellena solo una selección pendiente. Enviar y Encolar validan la elección vigente.
        if (selected?.agent === agent && !selected.model) prefs[conv.id] = resolvePrefs(conv, source, agent);
      }
      return { catalogs, prefs };
    });
  },

  async refreshDetection() {
    try {
      set({ detection: await api.detectAgents() });
    } catch (e) {
      get().toast(errorText(e), 'error');
    }
  },

  setPrefs(conversationId, patch, expected) {
    const state = get();
    const conv = state.conversations.find((c) => c.id === conversationId);
    const cur = state.prefs[conversationId];
    if (!conv || (expected && expected !== cur)) return;
    const next = { ...(cur ?? resolvePrefs(conv, state)), ...patch };
    const saveModel = canDispatch(next, state.catalogs[next.agent]);
    if (!saveModel && !patch.agent) return;
    set((s) => ({
      prefs: { ...s.prefs, [conversationId]: next },
      conversations: s.conversations.map((c) => c.id === conversationId ? rememberPrefs(c, next, saveModel) : c),
    }));
    void writeInOrder(preferenceWrites, conversationId, () => api.setConversationPrefs(
      conversationId, next.agent, saveModel ? next.model : '', saveModel ? next.effort : null,
    )).catch((err) => get().toast(errorText(err), 'error'));
  },

  saveDraft(conversationId, draft) {
    // Rendimiento: el texto tecleado no se copia al estado global en cada pulsación (eso
    // re-renderizaba la barra lateral, el chat y todos los suscriptores de `conversations`).
    // Se guarda en `pendingDrafts` y el estado se sincroniza al pausar la escritura; solo se
    // actualiza al instante cuando el borrador pasa de vacío a no vacío (o al revés), que es lo
    // único que muestra el resto de la interfaz («borrador guardado»).
    pendingDrafts.set(conversationId, draft);
    const syncState = () =>
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === conversationId && c.draft !== draft ? { ...c, draft } : c)) }));
    const current = get().conversations.find((c) => c.id === conversationId)?.draft ?? '';
    if (!current !== !draft) syncState();
    const t = draftTimers.get(conversationId);
    if (t) window.clearTimeout(t);
    draftTimers.set(
      conversationId,
      window.setTimeout(() => {
        draftTimers.delete(conversationId);
        syncState();
        void writeDraft(conversationId, draft).catch((err) => get().toast(errorText(err), 'error'));
      }, 350),
    );
  },

  saveDraftAttachments(conversationId, update) {
    const conv = get().conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    const paths = update(conv.draftAttachments ?? []);
    set((s) => ({ conversations: s.conversations.map((c) => c.id === conversationId ? { ...c, draftAttachments: paths } : c) }));
    const write = (draftAttachmentWrites.get(conversationId) ?? Promise.resolve())
      .then(() => api.setDraftAttachments(conversationId, paths))
      .catch((err) => get().toast(errorText(err), 'error'))
      .finally(() => {
        if (draftAttachmentWrites.get(conversationId) === write) draftAttachmentWrites.delete(conversationId);
      });
    draftAttachmentWrites.set(conversationId, write);
  },

  async refreshQueue(conversationId) {
    const token = Symbol();
    queueReads.set(conversationId, token);
    try {
      const queue = await api.messageQueue(conversationId);
      if (queueReads.get(conversationId) === token) {
        set((s) => ({ queues: { ...s.queues, [conversationId]: queue } }));
      }
    } catch (err) {
      if (queueReads.get(conversationId) === token) get().toast(errorText(err), 'error');
    } finally {
      if (queueReads.get(conversationId) === token) queueReads.delete(conversationId);
    }
  },

  async enqueue(conversationId, text, attachments, defer) {
    const { prefs, settings, catalogs } = get();
    const config = prefs[conversationId];
    if (!config || !canDispatch(config, catalogs[config.agent])) return false;
    const account = settings['accounts.active.' + config.agent];
    try {
      await api.enqueueMessage(crypto.randomUUID(), {
        conversationId, text, attachments, agent: config.agent, model: config.model, effort: config.effort,
      }, typeof account === 'string' ? account : null, defer);
      await get().refreshQueue(conversationId);
      get().toast('Mensaje encolado');
      return true;
    } catch (err) {
      get().toast(errorText(err), 'error');
      return false;
    }
  },

  async editQueued(id, request, replaceTarget, accountId) {
    try {
      await api.editQueuedMessage(id, request, replaceTarget, accountId);
      await get().refreshQueue(request.conversationId);
      get().toast('Encargo actualizado');
      return true;
    } catch (err) {
      get().toast(errorText(err), 'error');
      return false;
    }
  },

  async updateQueue(conversationId, action) {
    try {
      await api.updateMessageQueue(conversationId, action);
      await get().refreshQueue(conversationId);
      return true;
    } catch (err) {
      get().toast(errorText(err), 'error');
      return false;
    }
  },

  async flushDrafts() {
    for (const timer of draftTimers.values()) window.clearTimeout(timer);
    draftTimers.clear();
    if (pendingDrafts.size) {
      set((s) => ({ conversations: s.conversations.map((conv) => {
        const draft = pendingDrafts.get(conv.id);
        return draft === undefined || draft === conv.draft ? conv : { ...conv, draft };
      }) }));
    }
    await Promise.all([
      ...draftAttachmentWrites.values(),
      ...[...preferenceWrites.values()].map((write) => write.catch(() => undefined)),
      ...[...pendingDrafts].map(([id, draft]) => writeDraft(id, draft)),
    ]);
  },

  async send(conversationId, text, attachments) {
    const { prefs: byConversation, catalogs, settings } = get();
    const prefs = byConversation[conversationId];
    if (!prefs || !canDispatch(prefs, catalogs[prefs.agent])) return false;
    // Un envío anterior sin respuesta sigue siendo el dueño del búfer de eventos.
    const owner = !pendingSends.has(conversationId);
    const pending = pendingSends.get(conversationId) ?? { events: [] as RunEvent[], renamedManually: false };
    if (owner) pendingSends.set(conversationId, pending);
    const account = settings['accounts.active.' + prefs.agent];
    try {
      // El backend decide bajo su bloqueo de ciclo de vida: inicia el turno o lo encola.
      const result = await writeInOrder(preferenceWrites, conversationId, () => api.submitMessage(crypto.randomUUID(), {
        conversationId,
        agent: prefs.agent,
        model: prefs.model,
        effort: prefs.effort,
        text,
        attachments,
        speed: speedFor(prefs, catalogs[prefs.agent], settings),
      }, typeof account === 'string' ? account : null));
      if (result.mode === 'queued') {
        set((s) => ({ queues: { ...s.queues, [conversationId]: result.queue } }));
        get().toast(tr('Mensaje añadido a la cola'));
        if (owner) {
          pendingSends.delete(conversationId);
          for (const event of pending.events) get().handleRunEvent(event);
        }
        return true;
      }
      const r = result.started;
      if (get().activityFinish?.conversationId === conversationId) set({ activityFinish: undefined });
      set((s) => ({
        messages: {
          ...s.messages,
          [conversationId]: [
            ...(s.messages[conversationId] ?? []).filter((m) => m.id !== r.userMessage.id && m.id !== r.assistantMessage.id),
            r.userMessage, r.assistantMessage,
          ],
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
            ready: false,
            startedAt: Date.now(),
          },
        },
        conversations: s.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...(s.prefs[conversationId] === prefs ? rememberPrefs(c, prefs, true) : c),
                updatedAt: Date.now(),
                title: pending.renamedManually ? c.title : r.renamedTitle ?? c.title,
              }
            : c,
        ),
      }));
      if (owner) {
        pendingSends.delete(conversationId);
        for (const event of pending.events) get().handleRunEvent(event);
      }
      return true;
    } catch (e) {
      get().toast(errorText(e), 'error');
      return false;
    } finally {
      if (owner) pendingSends.delete(conversationId);
    }
  },

  async steer(runId, text, attachments) {
    try {
      await api.steerRun(runId, text, attachments);
      get().toast(tr('Codex aceptó la intervención'));
      return true;
    } catch (err) {
      get().toast(errorText(err), 'error');
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
      const current = get().runs[conversationId];
      if (current?.runId === run.runId) {
        set((s) => ({ runs: { ...s.runs, [conversationId]: { ...current, stopping: false } } }));
      }
      get().toast(errorText(e), 'error');
    }
  },

  async respondApproval(conversationId, approvalId, decision) {
    try {
      await api.respondApproval(approvalId, decision);
    } catch (e) {
      get().toast(errorText(e), 'error');
      return;
    }
    set((s) => {
      const run = s.runs[conversationId];
      if (!run) return {};
      return { runs: { ...s.runs, [conversationId]: { ...run, approvals: run.approvals.filter((a) => a.approvalId !== approvalId) } } };
    });
  },

  openChatFind(query = '', messageId) {
    const s = get();
    if (!s.activeConversationId) return;
    const chatFind = { conversationId: s.activeConversationId, query, messageId, request: (s.chatFind?.request ?? 0) + 1 };
    const navigate = () => set({ view: 'chat', settingsOpen: false, chatFind });
    const leaving = confirmBackgroundNavigation();
    if (leaving) void leaving.then((accepted) => { if (accepted) navigate(); });
    else navigate();
  },
  closeChatFind() {
    set({ chatFind: null });
  },
  openPanel(view) {
    set((s) => ({ panel: { ...s.panel, open: true, active: view ?? s.panel.active } }));
  },
  openTab(tab) {
    set((s) => {
      const exists = s.panel.tabs.some((t) => t.id === tab.id);
      const limited = s.panel.tabs.filter((t) => tab.kind === 'widget' ? t.kind === 'widget' : t.kind !== 'visual' && t.kind !== 'widget');
      const evict = !exists && tab.kind !== 'visual' && limited.length >= 8 ? limited[0].id : undefined;
      const tabs = exists ? s.panel.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...s.panel.tabs.filter((t) => t.id !== evict), tab];
      return { panel: { open: true, tabs, active: tab.id } };
    });
  },
  closeTab(id) {
    set((s) => {
      const tabs = s.panel.tabs.filter((t) => t.id !== id);
      const closed = s.panel.tabs.find((tab) => tab.id === id);
      const previous = closed?.kind === 'visual' || closed?.kind === 'widget' ? closed.payload.returnTo : undefined;
      const canReturn = previous === null || previous === 'files' || previous === 'git' || tabs.some((tab) => tab.id === previous);
      const active = s.panel.active === id ? canReturn ? previous ?? null : tabs.at(-1)?.id ?? null : s.panel.active;
      return { panel: { open: s.panel.open, tabs, active } };
    });
  },
  setActiveTab(id) {
    set((s) => ({ panel: { ...s.panel, active: id } }));
  },
  closePanel() {
    set((s) => ({ panel: { ...s.panel, open: false } }));
  },
  togglePanel() {
    set((s) => ({ panel: { ...s.panel, open: !s.panel.open } }));
  },
  setAccounts(accounts) {
    set({ accounts });
  },
  setNavDrawer(navDrawer) {
    set({ navDrawer });
  },

  handleRunEvent(ev) {
    if (ev.type === 'queueChanged') {
      void get().refreshQueue(ev.conversationId);
      return;
    }
    if (ev.type === 'queueError') {
      get().toast(ev.message, 'error');
      return;
    }
    if (ev.type === 'historyMessage') {
      const cid = ev.conversationId;
      set((state) => ({ messages: { ...state.messages, [cid]: mergeMessages(state.messages[cid] ?? [], [ev.message]) } }));
      return;
    }
    const state = get();
    if ('conversationId' in ev && !state.runs[ev.conversationId]) {
      const pending = pendingSends.get(ev.conversationId);
      if (pending) {
        pending.events.push(ev);
        return;
      }
      if (ev.type !== 'started') return;
    }
    switch (ev.type) {
      case 'started': {
        const cid = ev.conversationId;
        if (state.runs[cid] || state.messages[cid]?.some((m) => m.id === ev.assistantMessage.id && m.status !== 'running')) return;
        const { agent, model, id } = ev.assistantMessage;
        if (!agent || !model) return;
        set({
          messages: { ...state.messages, [cid]: mergeMessages(state.messages[cid] ?? [], [ev.userMessage, ev.assistantMessage]) },
          activityFinish: state.activityFinish?.conversationId === cid ? undefined : state.activityFinish,
          runs: { ...state.runs, [cid]: {
            runId: ev.runId, conversationId: cid, messageId: id, agent, model,
            items: [], usage: null, approvals: [], ready: false, startedAt: Date.now(),
          } },
          conversations: state.conversations.map((c) => c.id === cid
            ? { ...c, updatedAt: Date.now(), title: ev.renamedTitle && c.title === 'Nueva conversación' ? ev.renamedTitle : c.title }
            : c),
        });
        return;
      }
      case 'runReady': {
        const run = state.runs[ev.conversationId];
        if (run?.runId === ev.runId) {
          set({ runs: { ...state.runs, [ev.conversationId]: { ...run, ready: true, steerable: ev.steerable } } });
        }
        return;
      }
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
        if (!isViewing(state, ev.conversationId)) {
          notifyNativeOutOfView(state, { kind: 'approval', key: approvalNoticeKey(ev.approvalId), conversationId: ev.conversationId, agent: run.agent });
        }
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
      case 'rateLimits': {
        // Última instantánea de cuota que entregó la CLI (Claude Code: rate_limit_event).
        if (ev.agent === 'claude') set((st) => ({ settings: { ...st.settings, 'quota.claude': ev.data } }));
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
        const run = state.runs[ev.conversationId];
        if (!run || run.runId !== ev.runId) return;
        notifyFinished(state, ev.conversationId, ev.status, ev.runId, run.agent);
        const runs = { ...state.runs };
        delete runs[ev.conversationId];
        const list = state.messages[ev.conversationId] ?? [];
        const msg = ev.message;
        set({
          runs,
          activityFinish: state.activeConversationId !== ev.conversationId ? state.activityFinish
            : ev.status === 'done' || ev.status === 'failed'
              ? { conversationId: ev.conversationId, runId: run.runId, agent: run.agent, status: ev.status, endedAt: Date.now() }
              : undefined,
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

/** La conversación está a la vista del usuario: no hace falta ningún aviso. */
function isViewing(state: State, conversationId: string): boolean {
  return isConversationInView(state, conversationId, () => document.hasFocus());
}

/**
 * Aviso del sistema (Windows) para una ejecución o autorización fuera de la vista. El backend
 * compone el texto (sin prompts ni respuestas), respeta el ajuste y no repite la misma clave.
 */
function notifyNativeOutOfView(state: State, notice: Omit<NativeNotice, 'title'>) {
  if (state.settings['notify.native'] === false) return;
  const conv = state.conversations.find((c) => c.id === notice.conversationId);
  if (!conv) return;
  void api.notifyNative({ ...notice, title: displayTitle(conv.title), locale: getLocale() }).catch(() => undefined);
}

/**
 * Avisos al terminar una tarea (Ajustes → Notificaciones): un aviso dentro de la aplicación si la
 * conversación no está a la vista, un aviso del sistema si el ajuste está activo y una petición de
 * atención en la barra de tareas de Windows si la ventana está en segundo plano. Nunca se avisa de
 * una ejecución detenida por el usuario.
 */
function notifyFinished(state: State, conversationId: string, status: string, runId: string, agent: AgentId) {
  const kind = finishedKind(status);
  if (!kind) return;
  const conv = state.conversations.find((c) => c.id === conversationId);
  const visible = isViewing(state, conversationId);
  if (state.settings['notify.taskToast'] !== false && conv && !visible) {
    const failed = kind === 'failed';
    state.toast(failed ? tr('«{title}» terminó con un error.', { title: displayTitle(conv.title) }) : tr('«{title}» ha terminado.', { title: displayTitle(conv.title) }), failed ? 'error' : 'info');
  }
  if (state.settings['notify.taskAttention'] !== false && !document.hasFocus()) {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow, UserAttentionType }) => getCurrentWindow().requestUserAttention(UserAttentionType.Informational))
      .catch(() => undefined);
  }
  if (!visible) notifyNativeOutOfView(state, { kind, key: runNoticeKey(runId, kind), conversationId, agent });
}

/**
 * Preferencias efectivas del compositor para una conversación (agente, modelo y esfuerzo).
 *
 * AUD-004: cada conversación recuerda una combinación independiente por agente
 * (`conv.agentPrefs`), así que alternar Claude ↔ Codex recupera la última elección de cada uno,
 * también tras reiniciar. Orden de preferencia para el modelo: lo último usado con ese agente en
 * la conversación → el predeterminado del usuario para ese agente → el recomendado del catálogo.
 * Una elección guardada puede dejar de estar disponible. Conservamos el valor para que el
 * compositor pueda indicar el problema y el usuario decida si quiere sustituirlo.
 */
export function resolvePrefs(conv: Conversation, s: Pick<State, 'settings' | 'catalogs'>, agentOverride?: AgentId): ComposerPrefs {
  const agent: AgentId = agentOverride ?? conv.lastAgent ?? (s.settings['defaults.agent'] as AgentId) ?? 'codex';
  const models = catalogModels(s.catalogs[agent]);
  const saved = conv.agentPrefs?.[agent] ?? (agent === conv.lastAgent && conv.lastModel ? { model: conv.lastModel, effort: conv.lastEffort } : null);
  if (saved?.model) return { agent, model: saved.model, effort: saved.effort };
  const wanted = (s.settings[`defaults.model.${agent}`] as string | undefined) || '';
  const found = models.find((m) => m.id === wanted);
  const info = found ?? models.find((m) => m.isDefault) ?? models[0];
  if (!info) return { agent, model: '', effort: null };
  const wantedEffort = (s.settings[`defaults.effort.${agent}`] as string | undefined) ?? null;
  const effort = wantedEffort && info.efforts.includes(wantedEffort) ? wantedEffort : info.defaultEffort ?? null;
  return { agent, model: info.id, effort };
}

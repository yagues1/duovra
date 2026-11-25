// Estado de Live Preview por espacio (proyecto o worktree). Nada se mezcla entre espacios: URL,
// servidor, tamaños, elementos, capturas y avisos van siempre bajo su id de espacio.
import { create } from 'zustand';
import { useStore } from './store';
import { spaceOf } from '../lib/worktrees';
import { DEFAULT_VIEWPORT, type Capture, type ElementInfo, type LpSummary, type PreviewRef, type Viewport } from '../lib/livePreview';
import { tr } from '../i18n';

export interface SpaceConfig {
  url: string;
  /** Comando de desarrollo (opcional). Solo se ejecuta al pulsar «Iniciar». */
  command: string;
  viewport: Viewport;
  recent: string[];
}

/** Omit sobre cada variante de la unión (Omit directo la aplanaría). */
export type NewPreviewRef = PreviewRef extends infer R ? R extends PreviewRef ? Omit<R, 'id'> : never : never;

export type Drawer = 'console' | 'network' | 'server' | 'element' | 'captures' | null;

const SETTING = 'ui.livePreview';
const EMPTY: SpaceConfig = { url: '', command: '', viewport: DEFAULT_VIEWPORT, recent: [] };

interface LpState {
  configs: Record<string, SpaceConfig>;
  live: Record<string, LpSummary>;
  /** La vista nativa existe (o se está creando) para el espacio. */
  open: Record<string, boolean>;
  element: Record<string, { node: number; info: ElementInfo } | null>;
  captures: Record<string, Capture[]>;
  drawer: Record<string, Drawer>;
  expanded: boolean;
  /** Dirección que el usuario pidió abrir desde la conversación (se abre al mostrar la vista). */
  pending: Record<string, string | undefined>;
  /** Referencias pendientes de enviar, por conversación. */
  refs: Record<string, PreviewRef[]>;
  config: (space: string) => SpaceConfig;
  setConfig: (space: string, patch: Partial<SpaceConfig>) => void;
  remember: (space: string, url: string) => void;
  setLive: (summary: LpSummary) => void;
  setOpen: (space: string, open: boolean) => void;
  setElement: (space: string, element: { node: number; info: ElementInfo } | null) => void;
  addCapture: (space: string, capture: Capture) => void;
  setDrawer: (space: string, drawer: Drawer) => void;
  setExpanded: (expanded: boolean) => void;
  addRef: (ref: NewPreviewRef) => boolean;
  removeRef: (conversationId: string, id: string) => void;
  takeRefs: (conversationId: string) => PreviewRef[];
  requestOpen: (space: string, url: string) => void;
  consumePending: (space: string) => string | undefined;
}

let saveTimer = 0;
function persist(configs: Record<string, SpaceConfig>) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void useStore.getState().setSetting(SETTING, configs), 400);
}

function loaded(): Record<string, SpaceConfig> {
  const raw = useStore.getState().settings[SETTING];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, SpaceConfig> = {};
  for (const [space, value] of Object.entries(raw as Record<string, Partial<SpaceConfig>>)) {
    out[space] = {
      url: typeof value.url === 'string' ? value.url : '',
      command: typeof value.command === 'string' ? value.command : '',
      viewport: { ...DEFAULT_VIEWPORT, ...(value.viewport ?? {}) },
      recent: Array.isArray(value.recent) ? value.recent.filter((u): u is string => typeof u === 'string').slice(0, 8) : [],
    };
  }
  return out;
}

let nextRef = 0;

export const useLivePreview = create<LpState>((set, get) => ({
  configs: {},
  live: {},
  open: {},
  element: {},
  captures: {},
  drawer: {},
  expanded: false,
  pending: {},
  refs: {},
  config(space) {
    const configs = Object.keys(get().configs).length ? get().configs : loaded();
    return configs[space] ?? EMPTY;
  },
  setConfig(space, patch) {
    const configs = { ...(Object.keys(get().configs).length ? get().configs : loaded()) };
    configs[space] = { ...(configs[space] ?? EMPTY), ...patch };
    set({ configs });
    persist(configs);
  },
  remember(space, url) {
    const current = get().config(space);
    get().setConfig(space, { url, recent: [url, ...current.recent.filter((u) => u !== url)].slice(0, 8) });
  },
  setLive(summary) {
    set((s) => ({ live: { ...s.live, [summary.space]: summary } }));
  },
  setOpen(space, open) {
    set((s) => ({ open: { ...s.open, [space]: open } }));
  },
  setElement(space, element) {
    set((s) => ({ element: { ...s.element, [space]: element } }));
  },
  addCapture(space, capture) {
    set((s) => ({ captures: { ...s.captures, [space]: [capture, ...(s.captures[space] ?? []).filter((c) => c.path !== capture.path)].slice(0, 6) } }));
  },
  setDrawer(space, drawer) {
    set((s) => ({ drawer: { ...s.drawer, [space]: drawer } }));
  },
  setExpanded(expanded) {
    set({ expanded });
  },
  addRef(ref) {
    const app = useStore.getState();
    const conv = app.conversations.find((c) => c.id === app.activeConversationId);
    if (!conv) {
      app.toast(tr('Abre una conversación de este espacio para adjuntar el contexto.'), 'error');
      return false;
    }
    if (spaceOf(conv) !== ref.space) {
      app.toast(tr('La conversación activa pertenece a otro espacio: no se mezcla el contexto entre worktrees.'), 'error');
      return false;
    }
    const full = { ...ref, id: `lp-${++nextRef}` } as PreviewRef;
    set((s) => ({ refs: { ...s.refs, [conv.id]: [...(s.refs[conv.id] ?? []), full].slice(-8) } }));
    return true;
  },
  removeRef(conversationId, id) {
    set((s) => ({ refs: { ...s.refs, [conversationId]: (s.refs[conversationId] ?? []).filter((r) => r.id !== id) } }));
  },
  requestOpen(space, url) {
    set((s) => ({ pending: { ...s.pending, [space]: url } }));
  },
  consumePending(space) {
    const url = get().pending[space];
    if (url) set((s) => ({ pending: { ...s.pending, [space]: undefined } }));
    return url;
  },
  takeRefs(conversationId) {
    const refs = get().refs[conversationId] ?? [];
    if (refs.length) set((s) => ({ refs: { ...s.refs, [conversationId]: [] } }));
    return refs;
  },
}));

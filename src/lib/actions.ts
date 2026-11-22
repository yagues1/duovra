import { resolvePrefs, useStore } from '../state/store';
import { NAV_COMPACT } from '../hooks/useLayout';
import type { AgentId } from './types';

type State = ReturnType<typeof useStore.getState>;
interface Shortcut { key: string; shift?: boolean; label: string; chatOnly?: boolean }
interface Action {
  id: string;
  label: string;
  slash?: string;
  shortcut?: Shortcut;
  available?: (state: State) => boolean;
  run: (state: State) => void;
  hidden?: boolean;
}

const workspace = (view?: 'files' | 'git') => (state: State) => {
  state.setView('chat');
  state.openPanel(view);
};

const hasProject = (state: State) => !!state.activeProjectId;
const hasChat = (state: State) => !!state.activeConversationId;

export function changeAgent(agent: AgentId, conversationId: string) {
  const state = useStore.getState();
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (conversation) state.setPrefs(conversationId, resolvePrefs(conversation, state, agent));
}

const canSwitchTo = (agent: AgentId) => (state: State) => {
  const id = state.activeConversationId;
  return !!id && !state.runs[id] && state.prefs[id]?.agent !== agent;
};

// Registro local compartido por paleta, teclado y comandos del compositor.
export const actions: readonly Action[] = [
  { id: 'new', label: 'Nueva conversación', shortcut: { key: 'n', label: 'Ctrl+N' }, available: hasProject, run: (s) => { void s.newConversation(); } },
  { id: 'workbench-open', label: 'Abrir Workbench', slash: 'workbench', available: (s) => hasProject(s) && (!s.panel.open || s.view !== 'chat'), run: workspace() },
  { id: 'workbench-close', label: 'Cerrar Workbench', available: (s) => s.view === 'chat' && s.panel.open, run: (s) => s.closePanel() },
  { id: 'files', label: 'Mostrar archivos', slash: 'archivos', available: hasProject, run: workspace('files') },
  { id: 'git', label: 'Mostrar cambios Git', slash: 'git', available: hasProject, run: workspace('git') },
  { id: 'find', label: 'Buscar en la conversación', slash: 'buscar', shortcut: { key: 'f', label: 'Ctrl+F', chatOnly: true }, available: hasChat, run: (s) => {
    if (s.view === 'chat' && s.chatFind) document.querySelector<HTMLInputElement>('.conversation-search input')?.focus({ preventScroll: true });
    else s.openChatFind();
  } },
  { id: 'settings', label: 'Abrir Ajustes', shortcut: { key: ',', label: 'Ctrl+,' }, run: (s) => s.setView('settings') },
  { id: 'statistics', label: 'Abrir estadísticas', run: (s) => s.setView('settings', 'statistics') },
  { id: 'claude', label: 'Cambiar a Claude Code', available: canSwitchTo('claude'), run: (s) => changeAgent('claude', s.activeConversationId!) },
  { id: 'codex', label: 'Cambiar a Codex', available: canSwitchTo('codex'), run: (s) => changeAgent('codex', s.activeConversationId!) },
  { id: 'nav', label: 'Alternar barra lateral', hidden: true, shortcut: { key: 'b', label: 'Ctrl+B' }, run: (s) => {
    if (window.innerWidth < NAV_COMPACT) s.setNavDrawer(!s.navDrawer);
    else void s.setSetting('ui.sidebarCollapsed', s.settings['ui.sidebarCollapsed'] !== true);
  } },
];

export const paletteShortcut: Shortcut = { key: 'p', shift: true, label: 'Ctrl+Shift+P' };
export function usesShortcut(event: KeyboardEvent, shortcut: Shortcut) {
  return event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey === !!shortcut.shift
    && event.key.toLowerCase() === shortcut.key
    && (!shortcut.chatOnly || event.target instanceof Element && !!event.target.closest('.chat-stage'));
}

export function actionAvailable(action: Action, state: State) {
  return state.ready && (action.available?.(state) ?? true);
}

export function runAction(id: string) {
  const state = useStore.getState();
  const action = actions.find((entry) => entry.id === id);
  if (action && actionAvailable(action, state)) action.run(state);
}

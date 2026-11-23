import { Search, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { actionAvailable, actions, paletteShortcut, runAction } from '../../lib/actions';
import { api, type ConversationMatch, errorText } from '../../lib/ipc';
import { fuzzy } from '../../lib/fuzzy';
import { useStore } from '../../state/store';
import { tr } from '../../i18n';

interface Choice {
  id: string;
  label: string;
  detail?: string;
  keyHint?: string;
  disabled?: boolean;
  run: () => void;
}
type Scope = 'all' | 'chat' | 'project';

export function CommandPalette({ close }: { close: () => void }) {
  const state = useStore(useShallow((s) => ({
    projects: s.projects, conversations: s.conversations, projectId: s.activeProjectId,
    conversationId: s.activeConversationId, open: s.panel.open, view: s.view, catalogs: s.catalogs,
    prefs: s.activeConversationId ? s.prefs[s.activeConversationId] : undefined,
    running: s.activeConversationId ? !!s.runs[s.activeConversationId] : false,
  })));
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const clean = query.trim();
  const [global, setGlobal] = useState<{ query: string; matches: ConversationMatch[]; error?: string }>();
  const [highlighted, setHighlighted] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const projectNames = useMemo(() => new Map(state.projects.map((item) => [item.id, item.name])), [state.projects]);

  useEffect(() => {
    if (scope === 'project' || clean.length < 2) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api.searchConversations(clean).then(
        (matches) => { if (alive) setGlobal({ query: clean, matches: matches ?? [] }); },
        (error) => { if (alive) setGlobal({ query: clean, matches: [], error: errorText(error) }); },
      );
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
  }, [scope, clean]);

  const globalMatches = global?.query === clean ? global : undefined;
  const choices = useMemo(() => {
    const items: Choice[] = [];
    const current = useStore.getState();
    if (scope === 'all') {
      items.push(...actions.filter((action) => !action.hidden).map((action) => ({
        id: action.id, label: action.label, keyHint: action.shortcut?.label,
        disabled: !actionAvailable(action, current), run: () => runAction(action.id),
      })));
      items.push(
        { id: 'by-chat', label: tr('Cambiar de conversación'), disabled: !state.conversations.length, run: () => setScope('chat') },
        { id: 'by-project', label: tr('Cambiar de proyecto'), disabled: !state.projects.length, run: () => setScope('project') },
      );
    }
    if (scope === 'chat' || clean && scope === 'all') {
      items.push(...state.conversations.map((item) => ({
        id: 'chat:' + item.id, label: item.title, detail: projectNames.get(item.projectId),
        run: () => { void useStore.getState().selectConversation(item.id); },
      })));
    }
    if (scope === 'project' || clean && scope === 'all') {
      items.push(...state.projects.map((item) => ({
        id: 'project:' + item.id, label: item.name, detail: item.path,
        run: () => { void useStore.getState().selectProject(item.id); },
      })));
    }

    const local = items.flatMap((item) => {
      const match = fuzzy(clean, item.label);
      return match ? [{ item, score: match.score }] : [];
    }).sort((a, b) => b.score - a.score).slice(0, 30).map(({ item }) => item);
    const messages = globalMatches?.matches.map((item): Choice => ({
      id: 'message:' + item.messageId,
      label: item.title,
      detail: tr('En mensajes') + ' · ' + item.project + ' · ' + item.snippet,
      run: () => {
        const store = useStore.getState();
        void store.selectConversation(item.conversationId).then(() => {
          if (useStore.getState().activeConversationId === item.conversationId) store.openChatFind(clean, item.messageId);
        });
      },
    })) ?? [];
    return [...local, ...messages];
  }, [scope, state, projectNames, globalMatches, clean]);
  const enabled = choices.filter((item) => !item.disabled);
  const active = enabled.find((item) => item.id === highlighted) ?? enabled[0];

  useLayoutEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    const focus = document.activeElement;
    modal.showModal();
    input.current?.focus({ preventScroll: true });
    return () => {
      modal.close();
      if (focus instanceof HTMLElement && focus.isConnected && !modal.contains(focus)) {
        focus.focus({ preventScroll: true });
      } else document.getElementById('workspace-main')?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (active) document.getElementById(id + '-' + active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active?.id, id]);

  const select = (choice: Choice | undefined) => {
    if (!choice || choice.disabled) return;
    if (choice.id.startsWith('by-')) {
      choice.run();
      setQuery('');
      setHighlighted(undefined);
      return;
    }
    dialog.current?.close();
    close();
    // El destino puede asumir el foco al montar su panel o conversación.
    requestAnimationFrame(choice.run);
  };

  return <dialog ref={dialog} className="command-palette surface-popup" aria-label={tr('Paleta de comandos')}
    onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.currentTarget === event.target) close(); }}>
    <div className="palette-content">
      <div className="palette-input">
        <Search size={17} aria-hidden />
        <input ref={input} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={id} aria-activedescendant={active && id + '-' + active.id}
          aria-label={scope === 'chat' ? tr('Buscar conversaciones') : scope === 'project' ? tr('Buscar proyectos') : tr('Buscar comandos y conversaciones')}
          placeholder={scope === 'chat' ? tr('Buscar conversaciones…') : scope === 'project' ? tr('Buscar proyectos…') : tr('Buscar comandos, proyectos y conversaciones…')}
          value={query} onChange={(event) => { setQuery(event.target.value); setHighlighted(undefined); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); select(active); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!enabled.length) return;
              const index = enabled.findIndex((item) => item.id === active?.id);
              setHighlighted(enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length].id);
            }
            if (event.key === 'Backspace' && !query && scope !== 'all') setScope('all');
          }} />
        <button className="btn-icon" type="button" aria-label={tr('Cerrar paleta')} onClick={close}><X size={16} aria-hidden /></button>
      </div>
      <div id={id} role="listbox" aria-label={tr('Resultados de la paleta')} className="palette-results">
        {choices.map((item) => <div key={item.id} id={id + '-' + item.id} role="option"
          aria-selected={item.id === active?.id} aria-disabled={item.disabled || undefined} className="productivity-option"
          onMouseDown={(event) => event.preventDefault()} onClick={() => select(item)}>
          <div className="productivity-option-text"><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div>
          {item.keyHint && <kbd>{item.keyHint}</kbd>}
        </div>)}
      </div>
      {!choices.length && <p className="productivity-note" role="status">
        {clean.length >= 2 && !globalMatches && scope !== 'project' ? tr('Buscando en mensajes…') : tr('Sin resultados')}
      </p>}
      {globalMatches?.error && <p className="productivity-note" role="status">{tr('Búsqueda de mensajes:')} {globalMatches.error}</p>}
      <footer className="palette-footer"><span>{tr('↑ ↓ Navegar · Intro Ejecutar')}</span><kbd>{paletteShortcut.label}</kbd></footer>
    </div>
  </dialog>;
}

import { FileCode2, Terminal } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { actionAvailable, actions, runAction } from '../../lib/actions';
import { fuzzy } from '../../lib/fuzzy';
import { api, errorText, type WorkspaceListing } from '../../lib/ipc';
import { useStore } from '../../state/store';
import { tr } from '../../i18n';

export interface SuggestionToken { mode: 'command' | 'file'; start: number; end: number; query: string }

export function localEntry(text: string) {
  return /^\/[\p{L}-]*$/u.test(text.trimEnd());
}

export function suggestionToken(text: string, caret: number): SuggestionToken | null {
  if (localEntry(text) && caret === text.length) return { mode: 'command', start: 0, end: caret, query: text.slice(1) };
  const match = /(?:^|\s)@([^\r\n@"<>]{0,120})$/.exec(text.slice(0, caret));
  if (!match || /[\w/\\.-]/.test(text[caret] ?? '')) return null;
  return { mode: 'file', start: caret - match[1].length - 1, end: caret, query: match[1] };
}

export function useComposerSuggestions({ text, projectId, field, update, suspended }: {
  text: string; projectId: string; field: RefObject<HTMLTextAreaElement | null>; update: (value: string) => void; suspended: boolean;
}) {
  const id = useId();
  const panelOpen = useStore((s) => s.panel.open);
  const [caret, setCaret] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [chosen, setChosen] = useState(0);
  const [cache, setCache] = useState<{ listing?: WorkspaceListing; at: number; error?: string }>();
  const token = caret >= 0 && !suspended && focused ? suggestionToken(text, caret) : null;
  const mode = token && dismissed !== text ? token.mode : null;
  const query = useDeferredValue(token?.query.trim() ?? '');

  useEffect(() => {
    if (mode !== 'file' || cache && Date.now() - cache.at < 30_000) return;
    let alive = true;
    void api.workspaceCatalog(projectId).then(
      (listing) => { if (alive) setCache({ listing, at: Date.now() }); },
      (error) => { if (alive) setCache({ error: errorText(error), at: Date.now() }); },
    );
    return () => { alive = false; };
  }, [mode, projectId, cache]);

  const options = useMemo(() => {
    if (mode === 'command') {
      const state = useStore.getState();
      return actions.filter((item) => item.slash?.startsWith(query.toLowerCase())).map((item) => ({
        id: item.id, label: '/' + item.slash, detail: item.label, disabled: !actionAvailable(item, state),
      }));
    }
    if (mode !== 'file') return [];
    const files = cache?.listing?.entries ?? [];
    return (query ? files.flatMap((file) => {
      const name = fuzzy(query, file.name);
      const path = fuzzy(query, file.path);
      return name || path ? [{ file, score: Math.max((name?.score ?? -1) + (name ? 25 : 0), path?.score ?? -1) }] : [];
    }).sort((a, b) => b.score - a.score).slice(0, 24).map(({ file }) => file) : files.slice(0, 24)).map((file) => ({
      id: file.path, label: file.name, detail: file.path, disabled: false,
    }));
  }, [mode, query, cache, panelOpen]);
  const enabled = options.filter((option) => !option.disabled);
  const option = enabled[chosen % Math.max(1, enabled.length)];
  const optionIndex = option ? options.indexOf(option) : -1;

  useEffect(() => {
    if (optionIndex >= 0) document.getElementById(id + '-' + optionIndex)?.scrollIntoView({ block: 'nearest' });
  }, [id, optionIndex, option?.id]);

  const pick = (item: typeof option) => {
    if (!item || item.disabled || !token || !mode || query !== token.query.trim()) return;
    if (mode === 'command') {
      update('');
      setDismissed(undefined);
      runAction(item.id);
      return;
    }
    const insertion = '@' + JSON.stringify(item.id) + ' ';
    update(text.slice(0, token.start) + insertion + text.slice(token.end).replace(/^ /, ''));
    setCaret(-1);
    requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(token.start + insertion.length, token.start + insertion.length);
    });
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mode || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(text);
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (enabled.length) setChosen((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length);
      return true;
    }
    const pendingFile = mode === 'file' && (!cache || query !== token?.query.trim());
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && (mode === 'command' || option || pendingFile)) {
      event.preventDefault();
      if (!pendingFile) pick(option);
      return true;
    }
    return false;
  };

  const selectCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart === element.selectionEnd ? element.selectionStart : -1);
  };
  const onTextChange = (element: HTMLTextAreaElement) => {
    setChosen(0);
    setDismissed(undefined);
    selectCaret(element);
  };
  const popup = mode && <div className="composer-suggestions surface-popup">
    <header>{mode === 'file' ? tr('Archivos del proyecto') : tr('Acciones de Duovra')}</header>
    <div id={id} role="listbox" aria-label={mode === 'file' ? tr('Sugerencias de archivos') : tr('Comandos locales')} className="suggestion-list">
      {options.map((item, index) => <div key={item.id} id={id + '-' + index} role="option" aria-selected={index === optionIndex}
        aria-disabled={item.disabled || undefined} className="productivity-option" title={item.detail}
        onMouseDown={(event) => event.preventDefault()} onClick={() => pick(item)}>
        {mode === 'file' ? <FileCode2 size={14} aria-hidden /> : <Terminal size={14} aria-hidden />}
        <div className="productivity-option-text"><strong>{item.label}</strong><small>{item.detail}</small></div>
      </div>)}
    </div>
    {!options.length && <p className="productivity-note" role="status">
      {mode === 'command' ? tr('Sin acciones disponibles') : cache?.error ?? (cache?.listing ? tr('Sin archivos coincidentes') : tr('Buscando archivos…'))}
    </p>}
    {mode === 'file' && options.length > 0 && <footer>{tr('Se envía la ruta relativa. El agente lee el archivo si lo necesita.')}
      {cache?.listing?.limited && ' ' + tr('La lista del proyecto está limitada.')}
    </footer>}
  </div>;

  return {
    popup, onKey, onTextChange, selectCaret,
    onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    controls: mode ? id : undefined,
    activeDescendant: mode && optionIndex >= 0 ? id + '-' + optionIndex : undefined,
  };
}

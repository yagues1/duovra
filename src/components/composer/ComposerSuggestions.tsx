import { FileCode2, Terminal } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { fuzzy } from '../../lib/fuzzy';
import { slashEntries, slashToken, type CommandContext, type CommandSpec, type SlashEntry, type UnavailableReason } from '../../lib/commands';
import { AGENT_NAME } from '../../lib/format';
import { api, errorText, type WorkspaceListing } from '../../lib/ipc';
import { useStore } from '../../state/store';
import { tr } from '../../i18n';

export interface SuggestionToken { mode: 'command' | 'file'; start: number; end: number; query: string }

export function suggestionToken(text: string, caret: number): SuggestionToken | null {
  const slash = slashToken(text, caret);
  if (slash) return { mode: 'command', start: 0, end: slash.end, query: slash.query };
  const match = /(?:^|\s)@([^\r\n@"<>]{0,120})$/.exec(text.slice(0, caret));
  if (!match || /[\w/\\.-]/.test(text[caret] ?? '')) return null;
  return { mode: 'file', start: caret - match[1].length - 1, end: caret, query: match[1] };
}

/** Menú «/» (fase 5): registro de comandos, contexto actual y qué hacer con el elegido. */
export interface SlashMenu {
  registry: CommandSpec[];
  ctx: CommandContext;
  /** Comando elegido y el resto del borrador (sin «/consulta»). Nunca se ejecuta nada del proveedor aquí. */
  onPick: (cmd: CommandSpec, rest: string) => void;
  help: boolean;
  setHelp: (help: boolean) => void;
  /** El informe de capacidades aún no ha llegado: Enter no envía «/…» como texto mientras tanto. */
  loading: boolean;
}

const REASON: Record<UnavailableReason, () => string> = {
  notIntegrated: () => tr('No disponible desde Duovra'),
  running: () => tr('No disponible mientras el agente trabaja'),
  idle: () => tr('Solo durante una ejecución'),
  capability: () => tr('El proveedor no lo admite en esta instalación'),
  context: () => tr('No aplica a esta conversación'),
  terminal: () => tr('Solo en la terminal interactiva'),
  duovra: () => tr('Lo gestiona el comando de Duovra'),
};

export function useComposerSuggestions({ text, projectId, field, update, suspended, slash }: {
  text: string; projectId: string; field: RefObject<HTMLTextAreaElement | null>; update: (value: string) => void; suspended: boolean;
  slash: SlashMenu;
}) {
  const id = useId();
  const panelOpen = useStore((s) => s.panel.open);
  const [caret, setCaret] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [chosen, setChosen] = useState(0);
  const [cache, setCache] = useState<{ listing?: WorkspaceListing; at: number; error?: string }>();
  const rawToken = caret >= 0 && !suspended && focused ? suggestionToken(text, caret) : null;
  // Ayuda (`/help`): el menú lista todos los comandos, también los no disponibles con su motivo.
  const token = rawToken ?? (slash.help && focused && !suspended ? { mode: 'command' as const, start: 0, end: 0, query: '' } : null);
  const mode = token && dismissed !== text ? token.mode : null;
  const query = useDeferredValue(token?.query.trim() ?? '');
  useEffect(() => {
    if (slash.help && (!focused || (!rawToken && text.trim()))) slash.setHelp(false);
  }, [slash.help, focused, !!rawToken, text]);

  useEffect(() => {
    if (mode !== 'file' || cache && Date.now() - cache.at < 30_000) return;
    let alive = true;
    void api.workspaceCatalog(projectId).then(
      (listing) => { if (alive) setCache({ listing, at: Date.now() }); },
      (error) => { if (alive) setCache({ error: errorText(error), at: Date.now() }); },
    );
    return () => { alive = false; };
  }, [mode, projectId, cache]);

  // El menú «/» usa la consulta inmediata (lista pequeña): Enter nunca llega antes que el filtro.
  const commandQuery = mode === 'command' ? token?.query.trim() ?? '' : '';
  const entries: SlashEntry[] = useMemo(
    () => (mode === 'command' ? slashEntries(slash.registry, commandQuery, slash.ctx, slash.help) : []),
    [mode, commandQuery, slash.registry, slash.ctx, slash.help],
  );
  const providerCount = useMemo(
    () => (mode === 'command' && !commandQuery && !slash.help ? slashEntries(slash.registry, '', slash.ctx, true)
      .filter((e) => e.group === 'provider' && e.available).length : 0),
    [mode, commandQuery, slash.registry, slash.ctx, slash.help],
  );
  const options = useMemo(() => {
    if (mode === 'command') {
      return entries.map((e) => ({ id: e.cmd.id, label: e.cmd.name, detail: e.available ? e.cmd.description ?? '' : REASON[e.reason ?? 'notIntegrated'](), disabled: !e.available }));
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
  }, [mode, query, cache, panelOpen, entries]);
  const enabled = options.filter((option) => !option.disabled);
  const option = enabled[chosen % Math.max(1, enabled.length)];
  const optionIndex = option ? options.indexOf(option) : -1;

  useEffect(() => {
    if (optionIndex >= 0) document.getElementById(id + '-' + optionIndex)?.scrollIntoView({ block: 'nearest' });
  }, [id, optionIndex, option?.id]);

  const pick = (item: typeof option) => {
    if (!item || item.disabled || !token || !mode || (mode === 'file' && query !== token.query.trim())) return;
    if (mode === 'command') {
      const entry = entries.find((e) => e.cmd.id === item.id);
      if (!entry) return;
      // Elegir solo selecciona: el compositor decide si abre una interfaz o prepara el comando para enviarlo.
      const rest = text.slice(token.end).replace(/^ /, '');
      setDismissed(undefined);
      setCaret(-1);
      slash.onPick(entry.cmd, rest);
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
    // Sin coincidencias, Enter envía el texto tal cual (un mensaje puede empezar por «/»), salvo mientras se
    // comprueban los comandos o si el texto nombra un comando que ahora no está disponible.
    const blockedCommand = mode === 'command' && !option && (slash.loading || entries.some((e) => !e.available));
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && (option || pendingFile || blockedCommand)) {
      event.preventDefault();
      if (!pendingFile && !blockedCommand) pick(option);
      return true;
    }
    if (event.key === 'Tab' && !event.shiftKey && option) {
      event.preventDefault();
      pick(option);
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
  const groupLabel = (g: SlashEntry['group']) => (g === 'duovra' ? 'Duovra' : AGENT_NAME[slash.ctx.agent]);
  const badge = (e: SlashEntry) => {
    if (!e.available) return null;
    if (e.cmd.support === 'custom') return tr('Personalizado');
    if (e.cmd.support === 'unknown') return tr('Sin verificar');
    return e.cmd.consumesCredits ? tr('Usa cuota') : null;
  };
  const popup = mode && <div className="composer-suggestions surface-popup" data-mode={mode}>
    <header>{mode === 'file' ? tr('Archivos del proyecto') : slash.help ? tr('Comandos · ayuda') : tr('Comandos')}</header>
    <div id={id} role="listbox" aria-label={mode === 'file' ? tr('Sugerencias de archivos') : tr('Comandos')} className="suggestion-list">
      {options.map((item, index) => {
        const entry = mode === 'command' ? entries[index] : undefined;
        const first = entry && (index === 0 || entries[index - 1].group !== entry.group);
        const tag = entry && badge(entry);
        return <div key={item.id} role="presentation">
          {first && <div className="suggestion-group" role="presentation">{groupLabel(entry.group)}</div>}
          <div id={id + '-' + index} role="option" aria-selected={index === optionIndex}
            aria-disabled={item.disabled || undefined} className="productivity-option" title={item.detail}
            onMouseDown={(event) => event.preventDefault()} onClick={() => pick(item)}>
            {mode === 'file' ? <FileCode2 size={14} aria-hidden /> : <Terminal size={14} aria-hidden />}
            <div className="productivity-option-text"><strong>{item.label}</strong><small>{item.detail}</small></div>
            {tag && <span className="suggestion-tag">{tag}</span>}
          </div>
        </div>;
      })}
    </div>
    {!options.length && <p className="productivity-note" role="status">
      {mode === 'command' ? slash.loading ? tr('Comprobando los comandos disponibles…') : tr('Sin comandos coincidentes. Enter envía el texto tal cual.') : cache?.error ?? (cache?.listing ? tr('Sin archivos coincidentes') : tr('Buscando archivos…'))}
    </p>}
    {mode === 'command' && providerCount > 0 && <footer>{tr('Escribe para buscar entre {n} comandos de {agent}.', { n: providerCount, agent: AGENT_NAME[slash.ctx.agent] })}</footer>}
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

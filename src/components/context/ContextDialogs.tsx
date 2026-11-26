/**
 * Gestor de memoria compartida (1.0.11). Se carga bajo demanda (React.lazy) desde Ajustes → Contexto y
 * memoria o al fijar un mensaje. Diálogo modal nativo: no añade barras laterales ni interfiere con
 * Workbench. La memoria es siempre de una sola conversación.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Info, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import { useContextStore, type ContextDialog } from '../../state/context';
import { useStore } from '../../state/store';
import { api, type MemoryHistory } from '../../lib/ipc';
import { CATEGORIES, MAX_MEMORY_CHARS, categoryLabel, isInstruction, type Memory, type MemoryCategory, type MemoryDraft } from '../../lib/context';
import { AGENT_NAME, displayTitle, fmtRelative } from '../../lib/format';
import { Segmented, Select, Switch } from '../ui/Controls';
import { confirmDialog } from '../ui/Dialog';
import { tr, useTr } from '../../i18n';

export default function ContextDialogs() {
  useTr();
  const dialog = useContextStore((s) => s.dialog);
  const close = useContextStore((s) => s.close);
  if (!dialog) return null;
  return <Modal key={dialog.conversationId} dialog={dialog} close={close} />;
}

function Modal({ dialog, close }: { dialog: ContextDialog; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const title = useStore((s) => s.conversations.find((c) => c.id === dialog.conversationId)?.title);
  useLayoutEffect(() => {
    const el = ref.current!;
    const trigger = document.activeElement;
    el.showModal();
    return () => {
      el.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className="surface-popup ctx-dialog m-auto p-0" aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <header className="ctx-dialog-head">
        <div className="min-w-0">
          <h2 id={titleId}>{tr('Memoria compartida')}</h2>
          {title && <p className="ctx-dialog-sub truncate">{displayTitle(title)}</p>}
        </div>
        <button type="button" className="btn-icon" aria-label={tr('Cerrar')} onClick={close}><X size={15} /></button>
      </header>
      <MemoryManager conversationId={dialog.conversationId} initial={dialog.edit} />
    </dialog>
  );
}

const GROUPS: Array<{ id: string; label: () => string; test: (m: Memory) => boolean }> = [
  { id: 'instructions', label: () => tr('Instrucciones'), test: (m) => isInstruction(m) },
  { id: 'pinned', label: () => tr('Fijados'), test: (m) => m.priority > 0 },
  { id: 'goal', label: () => tr('Objetivo actual'), test: (m) => m.category === 'goal' },
  { id: 'decision', label: () => tr('Decisiones'), test: (m) => m.category === 'decision' },
  { id: 'constraint', label: () => tr('Restricciones'), test: (m) => m.category === 'constraint' },
  { id: 'status', label: () => tr('Estado del trabajo'), test: (m) => m.category === 'status' || m.category === 'task' },
  { id: 'other', label: () => tr('Otros'), test: () => true },
];

function MemoryManager({ conversationId, initial }: { conversationId: string; initial?: MemoryDraft }) {
  const memories = useContextStore((s) => s.memories[conversationId]);
  const load = useContextStore((s) => s.loadMemories);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<MemoryDraft | null>(initial ?? null);

  useEffect(() => { void load(conversationId); }, [conversationId, load]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (memories ?? []).filter((m) => m.archived === archived)
      .filter((m) => !q || m.content.toLowerCase().includes(q) || categoryLabel(m.category).toLowerCase().includes(q));
    const used = new Set<string>();
    return GROUPS.map((g) => {
      const items = list.filter((m) => !used.has(m.id) && g.test(m));
      items.forEach((m) => used.add(m.id));
      return { ...g, items };
    }).filter((g) => g.items.length);
  }, [memories, query, archived]);

  if (editing) {
    return <div className="ctx-dialog-body"><MemoryEditor conversationId={conversationId} draft={editing} done={() => setEditing(null)} /></div>;
  }
  return (
    <div className="ctx-dialog-body">
      <div className="mem-toolbar">
        <label className="mem-search">
          <Search size={13} aria-hidden />
          <input className="input" value={query} placeholder={tr('Buscar')} aria-label={tr('Buscar en la memoria')}
            onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented id="mem-archived" value={archived ? 'archived' : 'active'} label={tr('Recuerdos')}
          options={[{ value: 'active', label: tr('Activos') }, { value: 'archived', label: tr('Archivados') }]}
          onChange={(v) => setArchived(v === 'archived')} />
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ content: '', category: 'note', priority: 0, origin: 'manual', author: 'user' })}>
          <Plus size={14} aria-hidden />{tr('Nuevo')}
        </button>
      </div>
      {!memories ? (
        <p className="ctx-muted">{tr('Cargando…')}</p>
      ) : !groups.length ? (
        <div className="mem-empty">
          <p>{query ? tr('Ningún recuerdo coincide con la búsqueda.') : archived ? tr('No hay recuerdos archivados.') : tr('Esta conversación todavía no tiene memoria compartida.')}</p>
          {!query && !archived && <p className="ctx-muted">{tr('Fija un mensaje desde su menú contextual (clic derecho) o crea un recuerdo.')}</p>}
        </div>
      ) : (
        <div className="mem-list">
          {groups.map((g) => (
            <section key={g.id} aria-label={g.label()}>
              <h3 className="mem-group">{g.label()}</h3>
              {g.items.map((m) => (
                <MemoryCard key={m.id} m={m} onEdit={() => setEditing({ id: m.id, content: m.content, category: m.category, priority: m.priority, author: m.author })} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function authorLabel(m: Pick<Memory, 'author' | 'sourceAgent'>) {
  return m.author === 'user' ? tr('Tú') : m.sourceAgent ? AGENT_NAME[m.sourceAgent] : tr('Agente');
}

function MemoryCard({ m, onEdit }: { m: Memory; onEdit: () => void }) {
  const archive = useContextStore((s) => s.archiveMemory);
  const remove = useContextStore((s) => s.deleteMemory);
  const save = useContextStore((s) => s.saveMemory);
  const [details, setDetails] = useState<MemoryHistory | null | 'loading'>(null);
  const toggleDetails = async () => {
    if (details) return setDetails(null);
    setDetails('loading');
    setDetails(await api.memoryHistory(m.id).catch(() => null));
  };
  return (
    <article className="mem-card" data-author={m.author} data-pinned={m.priority > 0 || undefined}>
      <div className="mem-card-main">
        <div className="min-w-0 flex-1">
          <p className="mem-content selectable">{m.content}</p>
          <div className="mem-meta">
            <span className="mem-cat">{categoryLabel(m.category)}</span>
            <span data-author={m.author}>{authorLabel(m)}</span>
          </div>
        </div>
        <div className="mem-actions">
          {!m.archived && (
            <button type="button" className="btn-icon" aria-label={m.priority ? tr('Quitar prioridad') : tr('Fijar como prioritario')} data-tip={m.priority ? tr('Quitar prioridad') : tr('Fijar como prioritario')}
              onClick={() => void save(m.conversationId, { id: m.id, content: m.content, category: m.category, priority: m.priority ? 0 : 1 })}>
              {m.priority ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          )}
          {!m.archived && <button type="button" className="btn-icon" aria-label={tr('Editar')} data-tip={tr('Editar')} onClick={onEdit}><Pencil size={14} /></button>}
          <button type="button" className="btn-icon" aria-label={tr('Origen')} data-tip={tr('Origen')} aria-expanded={!!details} onClick={() => void toggleDetails()}><Info size={14} /></button>
          <button type="button" className="btn-icon" aria-label={m.archived ? tr('Restaurar') : tr('Archivar')} data-tip={m.archived ? tr('Restaurar') : tr('Archivar')}
            onClick={() => void archive(m, !m.archived)}>{m.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
          <button type="button" className="btn-icon" aria-label={tr('Eliminar')} data-tip={tr('Eliminar')} onClick={async () => {
            if (await confirmDialog({ title: tr('¿Eliminar este recuerdo?'), body: tr('Los agentes que ya lo recibieron serán avisados de que deja de aplicarse. El mensaje de origen no cambia.'), confirmLabel: tr('Eliminar'), danger: true })) void remove(m);
          }}><Trash2 size={14} /></button>
        </div>
      </div>
      {details === 'loading' && <p className="ctx-muted">{tr('Cargando…')}</p>}
      {details && details !== 'loading' && (
        <div className="mem-history">
          <p className="ctx-muted">
            {m.origin === 'message' ? tr('Fijado desde un mensaje') : m.origin === 'summary' ? tr('Propuesta aprobada') : tr('Escrito a mano')} · {fmtRelative(m.updatedAt)}
          </p>
          {details.sources.map((s) => (
            <blockquote key={s.id} className="selectable">
              <span className="mem-meta">{s.role === 'user' ? tr('Tú') : `${s.agent ? AGENT_NAME[s.agent] : ''}${s.model ? ` · ${s.model}` : ''}`} · {fmtRelative(s.createdAt)}</span>
              {s.excerpt}
            </blockquote>
          ))}
          {details.revisions.length > 1 && (
            <details>
              <summary>{tr('Versiones anteriores ({n})', { n: details.revisions.length - 1 })}</summary>
              <ol>
                {details.revisions.slice(1).map((r) => (
                  <li key={r.revision}>{fmtRelative(r.createdAt)}<p className="selectable">{r.content}</p></li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </article>
  );
}

function MemoryEditor({ conversationId, draft, done }: { conversationId: string; draft: MemoryDraft; done: () => void }) {
  const save = useContextStore((s) => s.saveMemory);
  const [content, setContent] = useState(draft.content.slice(0, MAX_MEMORY_CHARS));
  const [category, setCategory] = useState<MemoryCategory>(draft.category);
  const [pinned, setPinned] = useState(draft.priority > 0);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const agentAuthored = draft.author === 'agent';
  const options = CATEGORIES.filter((c) => !(agentAuthored && c === 'instruction')).map((c) => ({ value: c, label: categoryLabel(c) }));
  const submit = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    const saved = await save(conversationId, { ...draft, content, category, priority: pinned ? 1 : 0 });
    setBusy(false);
    if (saved) done();
  };
  return (
    <form className="mem-editor" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {draft.sourceMessages?.length ? (
        <p className="ctx-note">
          {agentAuthored
            ? tr('Se guardará como afirmación del agente, no como instrucción tuya. No le da permisos ni sustituye tus mensajes.')
            : tr('Se guardará como indicación tuya. El mensaje original no cambia.')}
        </p>
      ) : null}
      <label htmlFor={fieldId} className="ctx-label">{tr('Contenido')}</label>
      <textarea id={fieldId} className="input mem-textarea selectable" value={content} maxLength={MAX_MEMORY_CHARS} autoFocus
        onChange={(e) => setContent(e.target.value)} />
      <div className="mem-editor-row">
        <Select value={category} onChange={(v) => setCategory(v as MemoryCategory)} options={options} label={tr('Categoría')} align="start" />
        <Switch checked={pinned} onChange={setPinned} label={tr('Prioritario')} />
        <span className="ctx-muted">{tr('Prioritario')}</span>
        <span className="ctx-muted mem-count">{content.length} / {MAX_MEMORY_CHARS}</span>
      </div>
      <div className="ctx-dialog-foot">
        <button type="button" className="btn" onClick={done}>{tr('Cancelar')}</button>
        <button type="submit" className="btn btn-primary" disabled={!content.trim() || busy}>{draft.id ? tr('Guardar cambios') : tr('Guardar recuerdo')}</button>
      </div>
    </form>
  );
}

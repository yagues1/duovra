import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, TriangleAlert } from 'lucide-react';
import { api, errorText, type ExportFormat, type ExternalSession, type ImportTarget } from '../../lib/ipc';
import type { AgentId, Conversation, Message, Project } from '../../lib/types';
import { useSessionDialog, type Purpose } from './SessionDialogHost';
import { useStore } from '../../state/store';
import { AGENT_NAME, basename, displayTitle, fmtRelative } from '../../lib/format';
import { tr, useTr } from '../../i18n';
import { Shell, openWorktreeDialog } from '../worktrees/WorktreeDialogs';
import { forkFlow, setArchived, upsertConversation } from './sessionActions';

/**
 * Diálogos compactos del Session Manager (1.0.11, fase 3). Sin paneles permanentes: se abren desde
 * los menús contextuales de mensajes, conversaciones y proyectos, y se cargan bajo demanda.
 */
export default function SessionDialogs() {
  useTr();
  const req = useSessionDialog((s) => s.req);
  if (!req) return null;
  const close = () => useSessionDialog.setState({ req: null });
  return createPortal(
    req.kind === 'fork' ? <ForkDialog purpose={req.purpose} message={req.message} close={close} />
      : req.kind === 'export' ? <ExportDialog conversation={req.conversation} close={close} />
      : req.kind === 'import' ? <ImportDialog project={req.project} close={close} />
      : <ArchivedDialog project={req.project} close={close} />,
    document.body,
  );
}

// ---------- Bifurcar, editar y regenerar ----------

/** La respuesta original modificó archivos o ejecutó comandos: repetirla puede volver a hacerlo. */
function touchedFiles(messages: Message[], message: Message): boolean {
  const answer = message.role === 'assistant' ? message
    : messages.find((m) => m.seq > message.seq && m.role === 'assistant');
  return !!answer?.items?.some((i) => (i.kind === 'file_change' || i.kind === 'command') && i.status !== 'declined');
}

function ForkDialog({ purpose, message, close }: { purpose: Purpose; message: Message; close: () => void }) {
  const conv = useStore((s) => s.conversations.find((c) => c.id === message.conversationId));
  const projects = useStore((s) => s.projects);
  const worktrees = useStore((s) => s.worktrees);
  const gitProjects = useStore((s) => s.gitProjects);
  const history = useStore((s) => s.messages[message.conversationId] ?? []);
  const [text, setText] = useState(message.content);
  const [mode, setMode] = useState<'same' | 'new' | 'other'>('same');
  const project = projects.find((p) => p.id === conv?.projectId);
  // Otros espacios del proyecto: el directorio principal (si se trabaja en un worktree) y los worktrees activos.
  const others = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [];
    if (conv?.worktreeId && project) list.push({ id: 'main', label: tr('Directorio principal') });
    for (const w of worktrees) {
      if (w.projectId === conv?.projectId && !w.retired && w.exists && w.id !== conv?.worktreeId) list.push({ id: w.id, label: w.branch && w.branch !== w.label ? `${w.label} · ${w.branch}` : w.label });
    }
    return list;
  }, [conv, project, worktrees]);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const git = !!project && gitProjects.includes(project.id);
  const risky = purpose === 'regenerate' && touchedFiles(history, message);
  if (!conv || !project) return null;

  const title = purpose === 'fork' ? tr('Bifurcar desde aquí') : purpose === 'edit' ? tr('Editar mensaje') : tr('Regenerar respuesta');
  const lead = purpose === 'fork'
    ? tr('Se crea una conversación nueva con los mensajes hasta aquí, sus adjuntos y la memoria de ese momento. La original no cambia.')
    : purpose === 'edit'
      ? tr('Se crea una conversación nueva justo antes de este mensaje con el texto editado como borrador. No se envía nada hasta que elijas el agente y lo envíes.')
      : tr('Se crea una conversación nueva antes de esta respuesta con el mismo encargo como borrador. La respuesta original se conserva; elige el agente en el compositor y envíalo.');
  const confirm = purpose === 'fork' ? tr('Bifurcar') : tr('Preparar borrador');

  const submit = async (space?: string) => {
    if (busy) return;
    if (purpose === 'edit' && !text.trim()) return;
    if (mode === 'new' && !space) {
      close();
      openWorktreeDialog({
        kind: 'create', project,
        onCreated: (worktree) => void forkFlow({ conversationId: conv.id, messageId: message.id, purpose, space: worktree.id, text: purpose === 'edit' ? text : undefined }),
      });
      return;
    }
    setBusy(true);
    const ok = await forkFlow({
      conversationId: conv.id, messageId: message.id, purpose,
      space: space ?? (mode === 'other' ? other : 'same'), text: purpose === 'edit' ? text : undefined,
    });
    setBusy(false);
    if (ok) close();
  };

  return (
    <Shell title={title} close={close} wide={purpose === 'edit'}
      footer={<>
        <button type="button" className="btn" onClick={close}>{tr('Cancelar')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || (purpose === 'edit' && !text.trim()) || (mode === 'other' && !other)}
          data-autofocus={purpose !== 'edit' || undefined} onClick={() => void submit()}>
          {mode === 'new' ? tr('Crear worktree…') : confirm}
        </button>
      </>}>
      <form className="wt-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="wt-option">{lead}</p>
        {purpose === 'edit' && (
          <label className="wt-field">
            <span>{tr('Mensaje')}</span>
            <textarea data-autofocus className="input session-edit" rows={6} value={text} onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} />
          </label>
        )}
        {(git || others.length > 0) && (
          <fieldset className="wt-field">
            <legend>{tr('Directorio de trabajo')}</legend>
            <div className="session-spaces" role="radiogroup" aria-label={tr('Directorio de trabajo')}>
              <label><input type="radio" name={`${fieldId}-space`} checked={mode === 'same'} onChange={() => setMode('same')} /> {tr('Continuar en el mismo directorio')}</label>
              {git && <label><input type="radio" name={`${fieldId}-space`} checked={mode === 'new'} onChange={() => setMode('new')} /> {tr('Crear un worktree nuevo')}</label>}
              {others.length > 0 && (
                <label className="session-space-other">
                  <input type="radio" name={`${fieldId}-space`} checked={mode === 'other'} onChange={() => setMode('other')} />
                  {tr('Usar un worktree existente')}
                  <select className="input" aria-label={tr('Worktree existente')} value={other} disabled={mode !== 'other'} onChange={(event) => setOther(event.target.value)}>
                    {others.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          </fieldset>
        )}
        {risky && (
          <p className="wt-note" data-tone="warn"><TriangleAlert size={13} aria-hidden />
            {tr('La respuesta original modificó archivos o ejecutó comandos. Una nueva respuesta puede volver a hacerlo: un worktree independiente lo aísla.')}</p>
        )}
        <p className="wt-note"><Info size={13} aria-hidden />{tr('Bifurcar no restaura archivos: el directorio queda como está ahora.')}</p>
      </form>
    </Shell>
  );
}

// ---------- Exportar ----------

const FORMATS: Array<{ id: ExportFormat; label: () => string; hint: () => string }> = [
  { id: 'markdown', label: () => 'Markdown', hint: () => tr('Texto legible con encabezados por mensaje.') },
  { id: 'json', label: () => 'JSON', hint: () => tr('Formato versionado de Duovra, apto para recuperarlo más adelante.') },
  { id: 'html', label: () => 'HTML', hint: () => tr('Página autónoma para leer o compartir.') },
  { id: 'memory', label: () => tr('Memoria resumida'), hint: () => tr('Los recuerdos actuales por categoría, sin usar ningún modelo.') },
];

function ExportDialog({ conversation, close }: { conversation: Conversation; close: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [attachments, setAttachments] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const fieldId = useId();
  const submit = async () => {
    setBusy(true);
    try {
      const saved = await api.exportConversation(conversation.id, { format, includeAttachments: attachments && format !== 'memory' });
      if (saved) {
        close();
        toast(tr('Conversación exportada en «{file}».', { file: saved.split(/[\\/]/).pop() }));
      }
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={tr('Exportar conversación')} close={close}
      footer={<>
        <button type="button" className="btn" onClick={close}>{tr('Cancelar')}</button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={busy} onClick={() => void submit()}>{busy ? tr('Exportando…') : tr('Exportar…')}</button>
      </>}>
      <div className="wt-form">
        <fieldset className="wt-field">
          <legend>{tr('Formato')}</legend>
          <div className="session-formats" role="radiogroup" aria-label={tr('Formato')}>
            {FORMATS.map((f) => (
              <label key={f.id}>
                <input type="radio" name={`${fieldId}-format`} checked={format === f.id} onChange={() => setFormat(f.id)} />
                <span><strong>{f.label()}</strong><small>{f.hint()}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="wt-check" data-disabled={format === 'memory' || undefined}>
          <input type="checkbox" checked={attachments && format !== 'memory'} disabled={format === 'memory'} onChange={(event) => setAttachments(event.target.checked)} />
          <span>{tr('Incluir adjuntos (se copian en una carpeta junto al archivo)')}</span>
        </label>
        <p className="wt-note"><Info size={13} aria-hidden />{tr('No se exportan credenciales, cuentas ni las sesiones internas de los agentes.')}</p>
      </div>
    </Shell>
  );
}

// ---------- Importar sesiones externas ----------

function ImportDialog({ project, close }: { project: Project; close: () => void }) {
  const accounts = useStore((s) => s.accounts);
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const [agent, setAgent] = useState<AgentId>('claude');
  const accountsOf = accounts.filter((a) => a.agent === agent);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ExternalSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ id: string; messages: Array<{ role: string; text: string }> | null } | null>(null);
  const [native, setNative] = useState(true);
  const [importing, setImporting] = useState(false);
  const fieldId = useId();

  // Al cambiar de proveedor se propone su cuenta activa.
  useEffect(() => {
    const active = settings[`accounts.active.${agent}`];
    setAccountId(typeof active === 'string' && accounts.some((a) => a.id === active && a.agent === agent) ? active : null);
  }, [agent, accounts, settings]);

  const target: ImportTarget = useMemo(() => ({ agent, accountId }), [agent, accountId]);

  const load = async (more: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.importList(target, search, more ? cursor : null);
      setItems((prev) => (more ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorText(err));
      if (!more) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  // Listado bajo demanda: solo con el diálogo abierto y al cambiar proveedor, cuenta o búsqueda.
  useEffect(() => {
    setSelected(new Set());
    setPreview(null);
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, search]);

  const togglePreview = async (id: string) => {
    if (preview?.id === id) { setPreview(null); return; }
    setPreview({ id, messages: null });
    try {
      const result = await api.importPreview(target, id);
      setPreview((p) => (p?.id === id ? { id, messages: result.messages } : p));
    } catch (err) {
      setPreview((p) => (p?.id === id ? { id, messages: [{ role: 'error', text: errorText(err) }] } : p));
    }
  };

  const submit = async () => {
    if (!selected.size || importing) return;
    setImporting(true);
    try {
      const result = await api.importSessions(target, project.id, null, [...selected], native);
      for (const conv of result.created) upsertConversation({ ...conv, started: true });
      if (result.created.length) {
        close();
        toast(result.created.length === 1 ? tr('1 conversación importada.') : tr('{n} conversaciones importadas.', { n: result.created.length }));
        await useStore.getState().selectConversation(result.created[0].id);
      }
      if (result.failed.length) toast(result.failed.map((f) => errorText(f.error)).join(' '), 'error');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setImporting(false);
    }
  };

  const samePath = (a: string | null) => !!a && a.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() === project.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

  return (
    <Shell title={tr('Importar sesiones en {project}', { project: project.name })} close={close} wide
      footer={<>
        <button type="button" className="btn" onClick={close}>{tr('Cancelar')}</button>
        <button type="button" className="btn btn-primary" disabled={!selected.size || importing} onClick={() => void submit()}>
          {importing ? tr('Importando…') : selected.size ? tr('Importar ({n})', { n: selected.size }) : tr('Importar')}
        </button>
      </>}>
      <div className="wt-form">
        <div className="wt-row session-import-bar">
          <div className="wt-segment" role="radiogroup" aria-label={tr('Proveedor')}>
            {(['claude', 'codex'] as AgentId[]).map((a) => (
              <label key={a}><input type="radio" name={`${fieldId}-agent`} checked={agent === a} onChange={() => setAgent(a)} /> {AGENT_NAME[a]}</label>
            ))}
          </div>
          {accountsOf.length > 0 && (
            <select className="input" aria-label={tr('Cuenta')} value={accountId ?? ''} onChange={(event) => setAccountId(event.target.value || null)}>
              <option value="">{tr('Cuenta predeterminada')}</option>
              {accountsOf.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          )}
        </div>
        <form className="wt-row" role="search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}>
          <input data-autofocus className="input" type="search" placeholder={tr('Buscar por título, texto o carpeta')} aria-label={tr('Buscar sesiones')}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="submit" className="btn">{tr('Buscar')}</button>
        </form>
        {error && <ul className="wt-problems" role="status"><li data-tone="error"><TriangleAlert size={13} aria-hidden /> {error}</li></ul>}
        <ul className="wt-import session-import-list" aria-busy={loading || undefined}>
          {items.map((item) => {
            const imported = !!item.conversationId;
            const open = preview?.id === item.sessionId;
            return (
              <li key={item.sessionId}>
                <label data-disabled={imported || undefined}>
                  <input type="checkbox" disabled={imported} checked={selected.has(item.sessionId)}
                    onChange={(event) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (event.target.checked) next.add(item.sessionId); else next.delete(item.sessionId);
                      return next;
                    })} />
                  <span className="wt-import-text">
                    <strong className="truncate">{item.title || tr('Sin título')}</strong>
                    <span className="wt-path-text">
                      {[item.cwd ? (samePath(item.cwd) ? tr('este proyecto') : basename(item.cwd)) : null, item.updatedAt ? fmtRelative(item.updatedAt) : null].filter(Boolean).join(' · ')}
                      {imported && <> · <span className="wt-flag">{tr('ya está en Duovra')}</span></>}
                    </span>
                  </span>
                </label>
                <button type="button" className="session-preview-btn" aria-expanded={open} onClick={() => void togglePreview(item.sessionId)}>
                  {open ? tr('Ocultar') : tr('Vista previa')}
                </button>
                {open && preview && (
                  <div className="session-preview" role="region" aria-label={tr('Vista previa')}>
                    {preview.messages === null ? <p className="wt-meta">{tr('Leyendo…')}</p>
                      : preview.messages.map((m, i) => (
                        <p key={i} data-role={m.role}><strong>{m.role === 'user' ? tr('Tú') : m.role === 'error' ? tr('Error') : AGENT_NAME[agent]}</strong> {m.text}</p>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
          {!loading && !items.length && !error && <li className="wt-meta">{search ? tr('Ninguna sesión coincide con la búsqueda.') : tr('No se encontraron sesiones en esta cuenta.')}</li>}
          {loading && <li className="wt-meta" role="status">{tr('Cargando sesiones…')}</li>}
        </ul>
        {cursor && !loading && <button type="button" className="btn session-more" onClick={() => void load(true)}>{tr('Cargar más')}</button>}
        <fieldset className="wt-field">
          <legend>{tr('Al continuar la conversación')}</legend>
          <div className="session-spaces" role="radiogroup" aria-label={tr('Al continuar la conversación')}>
            <label><input type="radio" name={`${fieldId}-cont`} checked={native} onChange={() => setNative(true)} /> {tr('Bifurcar la sesión nativa (recomendado)')}</label>
            <label><input type="radio" name={`${fieldId}-cont`} checked={!native} onChange={() => setNative(false)} /> {tr('Reconstruir el contexto en Duovra')}</label>
          </div>
        </fieldset>
        <p className="wt-note"><Info size={13} aria-hidden />{tr('La sesión original no se modifica. Bifurcarla evita conflictos aunque siga abierta en otra aplicación; si no es posible, Duovra reconstruye el contexto y lo indica.')}</p>
      </div>
    </Shell>
  );
}

// ---------- Archivadas ----------

function ArchivedDialog({ project, close }: { project: Project; close: () => void }) {
  const archived = useStore((s) => s.conversations.filter((c) => c.projectId === project.id && c.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)));
  const select = useStore((s) => s.selectConversation);
  return (
    <Shell title={tr('Conversaciones archivadas')} close={close}
      footer={<button type="button" className="btn" data-autofocus onClick={close}>{tr('Cerrar')}</button>}>
      {archived.length === 0 ? <p className="wt-meta">{tr('No hay conversaciones archivadas en este proyecto.')}</p> : (
        <ul className="wt-import session-archived">
          {archived.map((c) => (
            <li key={c.id}>
              <span className="wt-import-text">
                <strong className="truncate">{displayTitle(c.title)}</strong>
                <span className="wt-path-text">{tr('Archivada {when}', { when: fmtRelative(c.archivedAt ?? c.updatedAt) })}</span>
              </span>
              <button type="button" className="btn" onClick={() => { close(); void select(c.id); }}>{tr('Abrir')}</button>
              <button type="button" className="btn" onClick={() => void setArchived(c, false)}>{tr('Desarchivar')}</button>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

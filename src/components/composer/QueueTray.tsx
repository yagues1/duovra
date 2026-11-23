import { ArrowDown, ArrowUp, ChevronDown, ListOrdered, Pencil, Trash2 } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errorText } from '../../lib/ipc';
import { AGENT_NAME, effortLabel } from '../../lib/format';
import type { AgentId, QueueAction, QueueEntry, QueueView, SendRequest } from '../../lib/types';
import { catalogModels, useStore } from '../../state/store';
import { Mascot } from '../mascot/Mascot';
import { confirmDialog } from '../ui/Dialog';
import { tr } from '../../i18n';
import { trBackend } from '../../i18n/backend';

const pauseText = (reason: string) => ({
  manual: tr('Cola pausada.'),
  restored: tr('Cola recuperada. Reanuda cuando quieras continuar.'),
  restart: tr('Duovra se cerró durante una ejecución. Revisa el historial antes de continuar.'),
  failed: tr('Una ejecución falló. Revisa el historial antes de continuar.'),
  cancelled: tr('Se detuvo la ejecución. Revisa el historial antes de continuar.'),
  interrupted: tr('La ejecución se interrumpió. Revisa el historial antes de continuar.'),
  configuration: tr('Un encargo necesita que revises su configuración.'),
  steer: tr('Hay una intervención sin confirmar. Revisa el historial antes de continuar.'),
  storage: tr('No se pudo guardar el resultado. Reinicia Duovra para revisar la ejecución.'),
} as Record<string, string>)[reason];

export function QueueTray({ conversationId, queue, active, focusComposer }: {
  conversationId: string;
  queue: QueueView | undefined;
  active: boolean;
  focusComposer: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const head = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const focusedRow = useRef<string | null>(null);
  const update = useStore((s) => s.updateQueue);
  const openFind = useStore((s) => s.openChatFind);
  const announce = useStore((s) => s.toast);
  const region = useId();

  const entries = queue?.entries ?? [];
  const pending = entries.filter((row) => row.state !== 'running');
  const first = pending[0]?.id;
  const pause = queue?.pauseReason ?? null;

  const focusRow = (id?: string, action?: string) => {
    requestAnimationFrame(() => {
      const row = id ? list.current?.querySelector<HTMLElement>('[data-queue-id="' + CSS.escape(id) + '"]') : null;
      const button = action && row?.querySelector<HTMLButtonElement>('[data-action="' + action + '"]:enabled');
      if (button) button.focus({ preventScroll: true });
      else if (row) row.focus({ preventScroll: true });
      else if (head.current) head.current.focus({ preventScroll: true });
      else focusComposer();
    });
  };

  useLayoutEffect(() => {
    const id = focusedRow.current;
    if (id && document.activeElement === document.body && !entries.some((entry) => entry.id === id)) {
      focusedRow.current = null;
      focusRow(entries[0]?.id);
    }
  });

  if (!pending.length && !pause && !expanded) return null;
  if (!entries.length && !pause) return null;

  const change = async (action: QueueAction, feedback?: string) => {
    if (busy.current) return false;
    busy.current = true;
    setWorking(true);
    try {
      const ok = await update(conversationId, action);
      if (ok && feedback) announce(feedback);
      return ok;
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };

  const remove = async (id: string, index: number) => {
    if (await change({ type: 'remove', id }, 'Encargo retirado')) {
      focusRow(entries[index + 1]?.id ?? entries[index - 1]?.id);
    }
  };

  const move = async (id: string, index: number, by: -1 | 1) => {
    const next = pending[index + by];
    if (!next || next.state !== 'pending') return;
    const before = by < 0 ? next.id : pending[index + 2]?.id ?? null;
    if (await change({ type: 'move', id, before }, tr('Encargo movido a la posición {n}', { n: index + by + 1 }))) {
      focusRow(id, by < 0 ? 'up' : 'down');
    }
  };

  const clear = async () => {
    if (await confirmDialog({ title: tr('¿Vaciar la cola?'), body: tr('Se retirarán todos los encargos pendientes de esta conversación.'), confirmLabel: tr('Vaciar cola'), danger: true })
      && await change({ type: 'clear' }, tr('Cola vaciada'))) focusRow();
  };

  const resume = async () => {
    if (pause && !['manual', 'restored', 'configuration'].includes(pause)) {
      if (!await confirmDialog({
        title: tr('¿Reanudar la cola?'),
        body: tr('Confirma que ya revisaste el resultado de la ejecución anterior. Los encargos pendientes podrán empezar.'),
        confirmLabel: tr('Reanudar cola'),
      })) return;
    }
    if (await change({ type: 'resume' }, tr('Cola reanudada')) && !entries.length) focusRow();
  };

  const next = pending[0];
  const more = Math.max(0, pending.length - 1);
  const attention = next && (next.state === 'blocked' || next.state === 'review');
  return (
    <section className="execution-queue" aria-label={tr('Cola de mensajes')} data-expanded={expanded || undefined}>
      <button ref={head} type="button" className="queue-next" aria-expanded={expanded} aria-controls={region}
        aria-label={next ? tr('Cola: siguiente «{text}»', { text: firstLine(next) }) + (more ? tr(', {n} más pendientes', { n: more }) : '') + (pause ? tr(', pausada') : '') : tr('Cola de mensajes')}
        onClick={() => setExpanded(!expanded)}>
        <ListOrdered size={14} aria-hidden className="queue-next-icon" />
        {next ? <>
          <span className="queue-next-label">{attention ? tr('Revisar') : tr('Siguiente')}</span>
          <span aria-hidden className="queue-next-agent"><Mascot agent={next.input.request.agent} state="idle" size={16} animated={false} /></span>
          <span className="queue-next-text" title={next.input.request.text}>{firstLine(next)}</span>
        </> : <span className="queue-next-text">{tr('Cola de mensajes')}</span>}
        {more > 0 && <span className="queue-more">{more === 1 ? tr('+1 pendiente') : tr('+{n} pendientes', { n: more })}</span>}
        {pause && <span className="queue-paused">{tr('Pausada')}</span>}
        <ChevronDown size={13} className="queue-chevron" aria-hidden />
      </button>
      <div id={region} hidden={!expanded} className="execution-queue-body">
        {pause && (
          <div className="queue-explanation">
            <span>{pauseText(pause) ?? tr('Cola pausada.')}</span>
            {queue?.reviewMessageId && <button type="button" className="notice-link" onClick={() => openFind('', queue.reviewMessageId ?? undefined)}>{tr('Ver ejecución')}</button>}
          </div>
        )}
        <ol ref={list} className="queue-entries" aria-label="Encargos" onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusedRow.current = null;
        }}>
          {entries.map((row, index) => {
            const { request, target, attachments } = row.input;
            const pos = pending.findIndex((entry) => entry.id === row.id);
            const up = row.state === 'pending' && pending[pos - 1]?.state === 'pending';
            const down = row.state === 'pending' && pending[pos + 1]?.state === 'pending';
            const status = row.state === 'running' ? active ? tr('En ejecución') : tr('Pendiente de guardar')
              : row.state === 'review' ? tr('Por revisar')
              : row.state === 'blocked' ? tr('Configuración pendiente')
              : row.id === first ? tr('Siguiente') : tr('Pendiente');
            return (
              <li key={row.id} data-queue-id={row.id} className="queue-entry" tabIndex={-1}
                onFocus={() => { focusedRow.current = row.id; }}>
                <div className="queue-entry-header">
                  <span className="queue-position" aria-hidden>{pos < 0 ? '•' : pos + 1}</span>
                  <span aria-hidden><Mascot agent={request.agent} state="idle" size={20} animated={false} /></span>
                  <span className="queue-entry-agent">{AGENT_NAME[request.agent]}</span>
                  <span className="queue-entry-config" title={target.label}>{request.model}
                    {(request.effort ?? row.input.effectiveEffort) && ' · ' + effortLabel((request.effort ?? row.input.effectiveEffort)!)}
                    {request.speed && request.speed !== 'default' && ' · ' + tr('rápido')}</span>
                  <span className="queue-entry-status" data-state={row.state}>{status}</span>
                  {row.state !== 'running' && <div className="queue-actions">
                    <button type="button" className="btn-icon" disabled={!up || working} data-action="up" aria-label={tr('Subir encargo {n}', { n: pos + 1 })}
                      onClick={() => void move(row.id, pos, -1)}><ArrowUp size={14} aria-hidden /></button>
                    <button type="button" className="btn-icon" disabled={!down || working} data-action="down" aria-label={tr('Bajar encargo {n}', { n: pos + 1 })}
                      onClick={() => void move(row.id, pos, 1)}><ArrowDown size={14} aria-hidden /></button>
                    <button type="button" className="btn-icon" data-action="edit" disabled={working} aria-label={tr('Editar encargo {n}', { n: pos + 1 })}
                      onClick={() => setEditing(row.id)}><Pencil size={14} aria-hidden /></button>
                    <button type="button" className="btn-icon" data-action="remove" disabled={working} aria-label={tr('Retirar encargo {n}', { n: pos + 1 })}
                      onClick={() => void remove(row.id, index)}><Trash2 size={14} aria-hidden /></button>
                  </div>}
                </div>
                {editing === row.id && row.state !== 'running' ? <QueueEditor entry={row} onClose={() => { setEditing(null); focusRow(row.id, 'edit'); }} /> :
                  <details className="queue-details">
                    <summary>{firstLine(row)}</summary>
                    <p className="queue-full-text">{request.text}</p>
                    <p>{tr('Cuenta')} · {target.label}</p>
                    {attachments.length > 0 && <ul>{attachments.map((item, i) => <li key={item.path + i}>{item.path}</li>)}</ul>}
                  </details>}
                {row.detail && <p className="queue-problem">{trBackend(row.detail)}</p>}
                {row.state === 'review' && <div className="queue-recovery">
                  {request.agent === 'codex' && <button type="button" className="notice-link" disabled={working} onClick={async () => {
                    if (busy.current) return;
                    busy.current = true;
                    setWorking(true);
                    try {
                      const result = await api.reconcileQueuedMessage(conversationId, row.id);
                      await useStore.getState().refreshQueue(conversationId);
                      announce(result);
                    } catch (err) {
                      announce(errorText(err), 'error');
                    } finally {
                      busy.current = false;
                      setWorking(false);
                    }
                  }}>{tr('Consultar a Codex')}</button>}
                  <button type="button" className="notice-link" disabled={working} onClick={async () => {
                    if (await confirmDialog({
                      title: tr('¿Preparar un reintento?'),
                      body: tr('El intento anterior puede haber modificado archivos. Al reanudar, este encargo se ejecutará de nuevo.'),
                      confirmLabel: tr('Preparar reintento'), danger: true,
                    })) {
                      if (await change({ type: 'retry', id: row.id }, tr('Reintento preparado'))) focusRow(row.id, 'edit');
                    }
                  }}>{tr('Preparar reintento')}</button>
                </div>}
              </li>
            );
          })}
        </ol>
        <div className="queue-footer">
          {pause ? <button type="button" className="btn" disabled={working || pause === 'storage' || pending.some((row) => row.state === 'blocked' || row.state === 'review')}
            onClick={() => void resume()}>{tr('Reanudar cola')}</button>
            : <button type="button" className="btn" disabled={working} onClick={() => void change({ type: 'pause' }, tr('Cola pausada'))}>{tr('Pausar cola')}</button>}
          {!!pending.length && <button type="button" className="btn" disabled={working} onClick={() => void clear()}>{tr('Vaciar cola')}</button>}
        </div>
      </div>
    </section>
  );
}

/** Primera línea del encargo (o una descripción si solo lleva adjuntos). */
function firstLine(entry: QueueEntry) {
  return entry.input.request.text.trim().split('\n')[0] || tr('Encargo con adjuntos');
}

function QueueEditor({ entry, onClose }: { entry: QueueEntry; onClose: () => void }) {
  const [request, setRequest] = useState(entry.input.request);
  const [accountId, setAccountId] = useState(entry.input.target.accountId);
  const [replace, setReplace] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const edit = useStore((s) => s.editQueued);
  const catalogs = useStore((s) => s.catalogs);
  const accounts = useStore((s) => s.accounts);
  const models = catalogModels(catalogs[request.agent]);
  const efforts = models.find((model) => model.id === request.model)?.efforts ?? [];
  const id = useId();
  useLayoutEffect(() => { input.current?.focus(); }, []);

  const patch = (fields: Partial<SendRequest>) => setRequest((value) => ({ ...value, ...fields }));
  return (
    <form className="queue-editor" aria-label="Editar encargo" onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (!savingRef.current) onClose();
      }
    }} onSubmit={async (event) => {
      event.preventDefault();
      if (savingRef.current || (!request.text.trim() && !request.attachments.length) || !request.model) return;
      setSaving(true);
      savingRef.current = true;
      try {
        if (await edit(entry.id, request, replace, accountId)) onClose();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    }}>
      <label htmlFor={id}>{tr('Mensaje en cola')}</label>
      <textarea id={id} ref={input} className="input" rows={3} value={request.text} onChange={(event) => patch({ text: event.target.value })} />
      {!!request.attachments.length && <ul className="queue-edit-files">
        {request.attachments.map((path) => <li key={path}>
          <span title={path}>{path}</span>
          <button type="button" className="btn-icon" aria-label={tr('Quitar adjunto {path}', { path })} onClick={() =>
            patch({ attachments: request.attachments.filter((item) => item !== path) })}><Trash2 size={13} aria-hidden /></button>
        </li>)}
      </ul>}
      <div className="queue-editor-options">
        <button type="button" className="notice-link" onClick={async () => {
          const picked = await openDialog({ multiple: true, title: tr('Adjuntar al encargo') });
          if (picked) patch({ attachments: [...new Set([...request.attachments, ...(Array.isArray(picked) ? picked : [picked])])] });
        }}>{tr('Añadir adjuntos')}</button>
        <label><input type="checkbox" checked={replace} onChange={(event) => {
          setReplace(event.target.checked);
          if (!event.target.checked) {
            const { agent, model, effort, speed } = entry.input.request;
            patch({ agent, model, effort, speed });
            setAccountId(entry.input.target.accountId);
          }
        }} /> {tr('Revisar agente, modelo y cuenta')}</label>
      </div>
      {replace && <div className="queue-editor-config">
        <label>{tr('Agente')}<select value={request.agent} onChange={(event) => {
          const agent = event.target.value as AgentId;
          setAccountId(null);
          patch({ agent, model: '', effort: null, speed: null });
        }}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
        <label>{tr('Modelo')}<select required value={request.model} onChange={(event) => {
          const fast = models.find((model) => model.id === event.target.value)?.fast;
          patch({ model: event.target.value, effort: null, speed: fast ? 'default' : null });
        }}>
          <option value="">{tr('Selecciona un modelo')}</option>
          {request.model && !models.some((model) => model.id === request.model) && <option value={request.model}>{request.model}</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></label>
        <label>{tr('Esfuerzo')}<select value={request.effort ?? ''} onChange={(event) => patch({ effort: event.target.value || null })}>
          <option value="">{tr('Predeterminado')}</option>
          {request.effort && !efforts.includes(request.effort) && <option value={request.effort}>{effortLabel(request.effort)}</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
        </select></label>
        <label>{tr('Cuenta')}<select value={accountId ?? ''} onChange={(event) => setAccountId(event.target.value || null)}>
          <option value="">{tr('Cuenta predeterminada')}</option>
          {accountId && !accounts.some((a) => a.id === accountId) && <option value={accountId}>{entry.input.target.label} · {tr('no disponible')}</option>}
          {accounts.filter((a) => a.agent === request.agent).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select></label>
      </div>}
      <div className="queue-footer">
        <button type="button" className="btn" disabled={saving} onClick={onClose}>{tr('Cancelar edición')}</button>
        <button type="submit" className="btn btn-primary" disabled={saving || (!request.text.trim() && !request.attachments.length)}>{tr('Guardar encargo')}</button>
      </div>
    </form>
  );
}

import { AnimatePresence, motion } from 'motion/react';
import { Check, CircleAlert, Copy, FileText, Image as ImageIcon, Layers, ShieldAlert, Square, Files } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { Approval, FileChange, Message, RunView, TimelineItem } from '../../lib/types';
import { AGENT_NAME, basename, displayCommand, effortLabel, fmtDuration, fmtTime, fmtTokens, relativeTo } from '../../lib/format';
import { diffStats, parseUnified, TURN_DIFF_PATH } from '../../lib/diff';
import { restingPose, turnPhase, TURN_LABEL } from '../../lib/activity';
import { useStore } from '../../state/store';
import { Mascot } from '../mascot/Mascot';
import { Markdown, openFileTab } from './Markdown';
import { changeLines, openDiffTab } from './TimelineItems';
import { TurnActivity } from './TurnActivity';
import { layoutTurn } from '../../lib/turnActivity';
import { findId } from '../../lib/conversationFind';
import { SPRING } from '../../lib/motion';
import { visualFile } from '../../lib/visual/types';
import { tr, useTr } from '../../i18n';

/**
 * Entrada de un mensaje nuevo: sube 8 px y aparece. Solo los mensajes recién creados se animan: al
 * abrir una conversación o cambiar de vista, el historial aparece sin reproducir la entrada.
 */
function useEnter(createdAt: number) {
  const [fresh] = useState(() => Date.now() - createdAt < 8000);
  return fresh
    ? ({ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', bounce: 0, duration: 0.5 } } as const)
    : ({ initial: false } as const);
}

// ---------- Usuario ----------

export const UserBubble = memo(function UserBubble({ m, root }: { m: Message; root: string }) {
  useTr();
  const note = m.contextNote;
  const enter = useEnter(m.createdAt);
  return (
    <motion.div className="msg-user" {...enter}>
      <div className="bubble selectable">
        <div className="bubble-byline"><strong>{tr('Tú')}</strong> <time dateTime={new Date(m.createdAt).toISOString()}>{fmtTime(m.createdAt)}</time></div>
        <div className="whitespace-pre-wrap" data-find-id={m.id}>{m.content}</div>
        {m.attachments && m.attachments.length > 0 && (
          <div className="bubble-files">
            {m.attachments.map((a, i) => a.projectReference || (visualFile(a.path) === 'svg' && relativeTo(a.path, root) !== a.path) ? (
              <button key={i} className="bubble-file" type="button" data-tip={a.path}
                aria-label={tr('Abrir {name} en Workbench', { name: a.name })} onClick={() => openFileTab(a.path, undefined, !!visualFile(a.path))}>
                <FileText size={12} aria-hidden /> <span className="truncate">{a.name}</span>
              </button>
            ) : (
              <span key={i} className="bubble-file" data-tip={a.path}>
                {a.image ? <ImageIcon size={12} /> : <FileText size={12} />} <span className="truncate">{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="msg-user-meta">
        {note?.mode === 'shared' && (
          <span className="context-note" tabIndex={0} data-tip={tr('El agente recibió estos intercambios porque su sesión no los había visto')}>
            <Layers size={11} />
            {note.messages === 1 ? tr('Contexto compartido: {n} mensaje', { n: note.messages }) : tr('Contexto compartido: {n} mensajes', { n: note.messages })}
            {note.agents && note.agents.length > 0 && ' ' + tr('de {agents}', { agents: note.agents.map((a) => AGENT_NAME[a]).join(tr(' y ')) })}
            {note.omitted ? ' ' + tr('({n} omitidos)', { n: note.omitted }) : ''}
          </span>
        )}
        {note?.steer && <span className="context-note">
          {note.steer === 'accepted' ? tr('Intervención aceptada por Codex') : tr('Intervención sin confirmar')}
        </span>}
        {m.agent && <span className="msg-user-to" data-agent={m.agent}>{tr('Para {agent}', { agent: AGENT_NAME[m.agent] })}</span>}
      </div>
    </motion.div>
  );
});

// ---------- Agente ----------

export function collectChanges(items: TimelineItem[]): FileChange[] {
  const byPath = new Map<string, FileChange[]>();
  for (const it of items) {
    if (it.kind !== 'file_change' || it.status === 'declined' || it.status === 'failed' || it.status === 'running') continue;
    for (const ch of it.changes ?? []) {
      const list = byPath.get(ch.path) ?? [];
      list.push(ch);
      byPath.set(ch.path, list);
    }
  }
  return [...byPath.entries()].map(([path, list]) =>
    list.length === 1
      ? list[0]
      : { path, kind: list[0].kind, diff: list.map((c) => c.diff ?? '').join('\n'), oldText: list[0].oldText, newText: list[list.length - 1].newText },
  );
}

export function ChangesSummary({ items }: { items: TimelineItem[] }) {
  const root = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const changes = useMemo(() => collectChanges(items), [items]);
  const diffItem = items.slice().reverse().find((i) => i.kind === 'diff' && i.diff);
  const turnDiff = diffItem?.diff;
  if (!changes.length && !turnDiff) return null;
  const stats = changes.map((c) => ({ c, s: diffStats(changeLines(c)) }));
  const total = turnDiff ? diffStats(parseUnified(turnDiff)) : stats.reduce((a, x) => ({ added: a.added + x.s.added, removed: a.removed + x.s.removed }), { added: 0, removed: 0 });
  return (
    <div className="changes">
      <div className="changes-head">
        <Files size={13} className="changes-ic" />
        <span className="changes-title">
          {changes.length ? (changes.length === 1 ? tr('1 archivo modificado') : tr('{n} archivos modificados', { n: changes.length })) : tr('Cambios del turno')}
        </span>
        <span className="add">+{total.added}</span>
        <span className="del">−{total.removed}</span>
        {turnDiff && (
          <button
            className="changes-all"
            onClick={() => useStore.getState().openTab({ id: `turndiff:${turnDiff.length}`, kind: 'diff', title: tr('Diff del turno'), payload: { change: { path: TURN_DIFF_PATH, kind: 'update', diff: turnDiff } } })}
          >
            {tr('Ver diff completo')}
          </button>
        )}
      </div>
      <div className="changes-list">
        {stats.map(({ c, s }) => (
          <button key={c.path} className="file-line" onClick={() => openDiffTab(c)}>
            <FileText size={12} className="faint" />
            <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" data-tip={c.path}>
              {relativeTo(c.path, root)}
            </span>
            <span className="add">+{s.added}</span>
            <span className="del">−{s.removed}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const approvalLabel = (o: string) => ({ accept: tr('Aprobar'), acceptForSession: tr('Aprobar en esta sesión'), decline: tr('Rechazar'), cancel: tr('Cancelar') } as Record<string, string>)[o];

function ApprovalCard({ a, conversationId }: { a: Approval; conversationId: string }) {
  const respond = useStore((s) => s.respondApproval);
  const [busy, setBusy] = useState(false);
  const info = a.info;
  const title =
    info.kind === 'command'
      ? tr('quiere ejecutar un comando')
      : info.kind === 'file_change'
        ? tr('quiere modificar archivos')
        : info.kind === 'permissions'
          ? tr('pide permisos adicionales')
          : tr('quiere usar {tool}', { tool: info.tool ?? tr('una herramienta') });
  const reason = typeof info.reason === 'string' ? info.reason : info.reason ? JSON.stringify(info.reason) : null;
  return (
    <motion.div
      className="approval"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={SPRING.enter}
      role="region"
      aria-label={tr('Solicitud de permiso de {agent}', { agent: AGENT_NAME[info.agent] })}
    >
      <div className="approval-head" role="status">
        <ShieldAlert size={15} aria-hidden />
        <span>
          {AGENT_NAME[info.agent]} {title}
        </span>
      </div>
      {info.command && <pre className="approval-cmd selectable">{displayCommand(info.command)}</pre>}
      {info.changes && info.changes.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {info.changes.map((c, i) => (
            <button key={i} className="file-line" onClick={() => openDiffTab(c)}>
              <FileText size={12} className="faint" />
              <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]">{c.path}</span>
            </button>
          ))}
        </div>
      )}
      {!info.command && !info.changes?.length && info.input != null && (
        <pre className="approval-cmd selectable">{JSON.stringify(info.input, null, 2)}</pre>
      )}
      {info.permissions != null && <pre className="approval-cmd selectable">{JSON.stringify(info.permissions, null, 2)}</pre>}
      {reason && <p className="approval-why">{reason}</p>}
      {info.cwd && <p className="approval-cwd">{info.cwd}</p>}
      <div className="approval-btns">
        {info.options.map((o) => (
          <button
            key={o}
            disabled={busy}
            className={o === 'accept' ? 'btn approval-primary' : o === 'decline' ? 'btn btn-danger' : 'btn'}
            onClick={() => {
              setBusy(true);
              void respond(conversationId, a.approvalId, o).finally(() => setBusy(false));
            }}
          >
            {approvalLabel(o) ?? o}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums">{fmtDuration(Math.max(0, now - since)).replace(/\.\d s$/, ' s')}</span>;
}

function UsageLine({ m }: { m: Message }) {
  const u = m.usage;
  if (!u) return null;
  const parts: string[] = [];
  if (u.outputTokens != null) parts.push(tr('{n} salida', { n: fmtTokens(u.outputTokens) }));
  if (u.costUsd != null) parts.push(tr('≈ {cost} USD (estimación de la CLI)', { cost: u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2) }));
  return (
    <span className="turn-usage">
      {u.inputTokens != null && <span tabIndex={0} data-tip={tr('Tokens de entrada informados por la CLI para este turno. Pueden incluir lecturas de caché y varias solicitudes al modelo.')}>
        {tr('{n} entrada del turno', { n: fmtTokens(u.inputTokens) })}
      </span>}
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </span>
  );
}

/**
 * Copiar la respuesta: acción discreta bajo el texto, a la izquierda. La confirmación solo aparece si
 * el portapapeles aceptó el texto; si falla, se informa con un aviso y el icono no cambia.
 */
function AnswerCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(timer);
  }, [done]);
  const label = done ? tr('Respuesta copiada') : tr('Copiar respuesta');
  return (
    <>
      <button type="button" className="answer-copy" data-done={done || undefined} aria-label={label} data-tip={label}
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => setDone(true),
            () => useStore.getState().toast(tr('No se pudo copiar al portapapeles'), 'error'),
          );
        }}>
        <Copy size={14} strokeWidth={1.8} aria-hidden className="answer-copy-ic" data-icon="copy" />
        <Check size={14} strokeWidth={2.2} aria-hidden className="answer-copy-ic" data-icon="check" />
      </button>
      <span className="sr-only" role="status">{done ? tr('Respuesta copiada') : ''}</span>
    </>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ m, run }: { m: Message; run?: RunView }) {
  useTr();
  const live = !!run;
  const items = run ? run.items : (m.items ?? []);
  const turn = useMemo(() => {
    const layout = layoutTurn(items, live);
    // Algunas CLIs repiten el error como texto de respuesta: se muestra solo en el aviso de error.
    if (m.status === 'failed' && m.error && layout.answer?.text?.trim() === m.error.trim()) {
      return { ...layout, answer: null, segments: layout.segments.filter((segment) => segment.kind !== 'answer') };
    }
    return layout;
  }, [items, live, m.status, m.error]);
  const agent = m.agent ?? 'codex';
  const requested = (m.usage as { requestedModel?: string } | null)?.requestedModel;
  const model = run?.resolvedModel ?? m.model;
  const showModel = run
    ? model && model !== m.model ? `${m.model} → ${model}` : m.model
    : requested ? `${requested} → ${m.model}` : m.model;
  const status = live ? 'running' : m.status;
  // Solo la respuesta final, con su texto original. Las conversaciones sin elementos (anteriores a la
  // actividad estructurada) solo guardan el texto del mensaje, que es su respuesta.
  const copyText = live ? null : turn.answer?.text?.trim() ? turn.answer.text! : !items.length && m.content?.trim() && m.content.trim() !== m.error?.trim() ? m.content : null;
  const enter = useEnter(m.createdAt);
  const phase = run ? turnPhase(run) : null;
  return (
    <motion.article id={'turn-' + m.id} tabIndex={-1} aria-label={tr('Turno de {agent}', { agent: AGENT_NAME[agent] })}
      className="turn" data-agent={agent} data-status={status} {...enter}>
      <div className="turn-gutter" aria-hidden>
        <Mascot agent={agent} state={restingPose(m)} size={30} animated={false} />
        <span className="turn-spine" />
      </div>
      <header className="turn-head">
        <span className="turn-name">{AGENT_NAME[agent]}</span>
        {showModel && (
          <span className="turn-chip" data-tip={tr('Modelo exacto usado en este mensaje')}>
            {showModel}
            {m.effort && <span className="turn-chip-effort"> · {effortLabel(m.effort).toLowerCase()}</span>}
          </span>
        )}
        <span className="turn-time">
          {live && run ? (
            <span className="live-text" data-phase={phase}>
              {phase ? TURN_LABEL[phase] : null} · <Elapsed since={run.startedAt} />
            </span>
          ) : (
            <>
              {fmtTime(m.createdAt)}
              {m.completedAt ? ` · ${fmtDuration(m.completedAt - m.createdAt)}` : ''}
            </>
          )}
        </span>
      </header>

      <div className="turn-body">
        {live && !turn.segments.length && (
          <TurnActivity items={[]} run={run} messageId={m.id} />
        )}
        {turn.segments.map((segment, index) => segment.kind === 'group' ? (
          <TurnActivity key={segment.key} items={segment.items} messageId={m.id} turnLive={live}
            run={live && index === turn.segments.length - 1 ? run : undefined} />
        ) : (
          // Notas de progreso y respuesta comparten componente: si un texto que se estaba escribiendo
          // pasa a ser nota porque llega otra operación, conserva su nodo y no parpadea.
          <div key={segment.key} data-find-id={findId(m.id, segment.item.id)} className="turn-prose" data-role={segment.kind}>
            <Markdown text={segment.item.text ?? ''} streaming={live && segment.item.status === 'running'} />
          </div>
        ))}

        {!live && !turn.segments.some((segment) => segment.kind !== 'group') && m.content && m.content.trim() !== m.error?.trim() && (
          <div className="turn-prose" data-find-id={findId(m.id, '')} data-role="answer"><Markdown text={m.content} /></div>
        )}

        <AnimatePresence>
          {run?.approvals.map((a) => (
            <ApprovalCard key={a.approvalId} a={a} conversationId={m.conversationId} />
          ))}
        </AnimatePresence>

        {!live && <ChangesSummary items={items} />}

        {status === 'failed' && (
          <div className="turn-error selectable" role="alert">
            <CircleAlert size={15} className="mt-px shrink-0" />
            <div className="min-w-0">
              <div className="turn-error-title">{tr('La ejecución falló')}</div>
              <div className="whitespace-pre-wrap" data-find-id={findId(m.id, 'error')}>{m.error ?? tr('El agente terminó con un error.')}</div>
            </div>
          </div>
        )}
        {(status === 'interrupted' || status === 'cancelled') && (
          <div className="turn-stopped" data-find-id={findId(m.id, 'error')}>
            <Square size={10} fill="currentColor" />
            {status === 'cancelled' ? tr('Detenida por el usuario.') : m.error ?? tr('La ejecución se interrumpió.')}
          </div>
        )}

        {!live && (copyText || m.usage) && (
          <footer className="turn-foot">
            {copyText && <AnswerCopy text={copyText} />}
            {m.usage && <UsageLine m={m} />}
          </footer>
        )}
      </div>
    </motion.article>
  );
});


export function fileNameOf(p: string) {
  return basename(p);
}

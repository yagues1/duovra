import { AnimatePresence, motion } from 'motion/react';
import { CircleAlert, FileText, Image as ImageIcon, Layers, ShieldAlert, Square, Files } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { Approval, FileChange, Message, RunView, TimelineItem } from '../../lib/types';
import { AGENT_NAME, basename, displayCommand, effortLabel, fmtDuration, fmtTime, fmtTokens, relativeTo } from '../../lib/format';
import { diffStats, parseUnified } from '../../lib/diff';
import { restingPose, turnPhase, TURN_LABEL } from '../../lib/activity';
import { useStore } from '../../state/store';
import { Mascot } from '../mascot/Mascot';
import { CopyButton, Markdown, openFileTab } from './Markdown';
import { changeLines, openDiffTab } from './TimelineItems';
import { TurnActivity } from './TurnActivity';
import { layoutTurn } from '../../lib/turnActivity';
import { findId } from '../../lib/conversationFind';
import { SPRING } from '../../lib/motion';
import { visualFile } from '../../lib/visual/types';

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

export const UserBubble = memo(function UserBubble({ m }: { m: Message }) {
  const note = m.contextNote;
  const enter = useEnter(m.createdAt);
  const root = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  return (
    <motion.div className="msg-user" {...enter}>
      <div className="bubble selectable">
        <div className="bubble-byline"><strong>Tú</strong> <time dateTime={new Date(m.createdAt).toISOString()}>{fmtTime(m.createdAt)}</time></div>
        <div className="whitespace-pre-wrap" data-find-id={m.id}>{m.content}</div>
        {m.attachments && m.attachments.length > 0 && (
          <div className="bubble-files">
            {m.attachments.map((a, i) => a.projectReference || (visualFile(a.path) === 'svg' && relativeTo(a.path, root) !== a.path) ? (
              <button key={i} className="bubble-file" type="button" data-tip={a.path}
                aria-label={`Abrir ${a.name} en Workbench`} onClick={() => openFileTab(a.path, undefined, !!visualFile(a.path))}>
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
          <span className="context-note" tabIndex={0} data-tip="El agente recibió estos intercambios porque su sesión no los había visto">
            <Layers size={11} />
            Contexto compartido: {note.messages} {note.messages === 1 ? 'mensaje' : 'mensajes'}
            {note.agents && note.agents.length > 0 && ` de ${note.agents.map((a) => AGENT_NAME[a]).join(' y ')}`}
            {note.omitted ? ` (${note.omitted} omitidos)` : ''}
          </span>
        )}
        {note?.steer && <span className="context-note">
          {note.steer === 'accepted' ? 'Intervención aceptada por Codex' : 'Intervención sin confirmar'}
        </span>}
        {m.agent && <span className="msg-user-to" data-agent={m.agent}>Para {AGENT_NAME[m.agent]}</span>}
      </div>
    </motion.div>
  );
});

// ---------- Agente ----------

function collectChanges(items: TimelineItem[]): FileChange[] {
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
          {changes.length ? `${changes.length} ${changes.length === 1 ? 'archivo modificado' : 'archivos modificados'}` : 'Cambios del turno'}
        </span>
        <span className="add">+{total.added}</span>
        <span className="del">−{total.removed}</span>
        {turnDiff && (
          <button
            className="changes-all"
            onClick={() => useStore.getState().openTab({ id: `turndiff:${turnDiff.length}`, kind: 'diff', title: 'Diff del turno', payload: { change: { path: 'Diff completo del turno', kind: 'update', diff: turnDiff } } })}
          >
            Ver diff completo
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

const APPROVAL_LABEL: Record<string, string> = {
  accept: 'Aprobar',
  acceptForSession: 'Aprobar en esta sesión',
  decline: 'Rechazar',
  cancel: 'Cancelar',
};

function ApprovalCard({ a, conversationId }: { a: Approval; conversationId: string }) {
  const respond = useStore((s) => s.respondApproval);
  const [busy, setBusy] = useState(false);
  const info = a.info;
  const title =
    info.kind === 'command'
      ? 'quiere ejecutar un comando'
      : info.kind === 'file_change'
        ? 'quiere modificar archivos'
        : info.kind === 'permissions'
          ? 'pide permisos adicionales'
          : `quiere usar ${info.tool ?? 'una herramienta'}`;
  const reason = typeof info.reason === 'string' ? info.reason : info.reason ? JSON.stringify(info.reason) : null;
  return (
    <motion.div
      className="approval"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={SPRING.enter}
      role="region"
      aria-label={`Solicitud de permiso de ${AGENT_NAME[info.agent]}`}
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
            {APPROVAL_LABEL[o] ?? o}
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
  if (u.outputTokens != null) parts.push(`${fmtTokens(u.outputTokens)} salida`);
  if (u.costUsd != null) parts.push(`≈ ${u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2)} USD (estimación de la CLI)`);
  return (
    <span className="turn-usage">
      {u.inputTokens != null && <span tabIndex={0} data-tip="Tokens de entrada informados por la CLI para este turno. Pueden incluir lecturas de caché y varias solicitudes al modelo.">
        {fmtTokens(u.inputTokens)} entrada del turno
      </span>}
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </span>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ m, run }: { m: Message; run?: RunView }) {
  const live = !!run;
  const items = run ? run.items : (m.items ?? []);
  const turn = useMemo(() => {
    const layout = layoutTurn(items, live);
    // Algunas CLIs repiten el error como texto de respuesta: se muestra solo en el aviso de error.
    if (m.status === 'failed' && m.error && layout.answer?.text?.trim() === m.error.trim()) return { ...layout, answer: null };
    return layout;
  }, [items, live, m.status, m.error]);
  const agent = m.agent ?? 'codex';
  const requested = (m.usage as { requestedModel?: string } | null)?.requestedModel;
  const model = run?.resolvedModel ?? m.model;
  const showModel = run
    ? model && model !== m.model ? `${m.model} → ${model}` : m.model
    : requested ? `${requested} → ${m.model}` : m.model;
  const status = live ? 'running' : m.status;
  const enter = useEnter(m.createdAt);
  const phase = run ? turnPhase(run) : null;
  return (
    <motion.article id={'turn-' + m.id} tabIndex={-1} aria-label={`Turno de ${AGENT_NAME[agent]}`}
      className="turn" data-agent={agent} data-status={status} {...enter}>
      <div className="turn-gutter" aria-hidden>
        <Mascot agent={agent} state={restingPose(m)} size={30} animated={false} />
        <span className="turn-spine" />
      </div>
      <header className="turn-head">
        <span className="turn-name">{AGENT_NAME[agent]}</span>
        {showModel && (
          <span className="turn-chip" data-tip="Modelo exacto usado en este mensaje">
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
        {!live && m.content && (
          <span className="turn-acts">
            <CopyButton text={m.content} label="Copiar respuesta" />
          </span>
        )}
      </header>

      <div className="turn-body">
        <TurnActivity items={turn.activity} run={run} messageId={m.id} />

        {turn.answer && (
          <div data-find-id={findId(m.id, turn.answer.id)} className="turn-prose" data-role="answer">
            <Markdown text={turn.answer.text ?? ''} streaming={live && turn.answer.status === 'running'} />
          </div>
        )}

        {!live && !turn.answer && m.content && m.content.trim() !== m.error?.trim() && (
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
              <div className="turn-error-title">La ejecución falló</div>
              <div className="whitespace-pre-wrap" data-find-id={findId(m.id, 'error')}>{m.error ?? 'El agente terminó con un error.'}</div>
            </div>
          </div>
        )}
        {(status === 'interrupted' || status === 'cancelled') && (
          <div className="turn-stopped" data-find-id={findId(m.id, 'error')}>
            <Square size={10} fill="currentColor" />
            {status === 'cancelled' ? 'Detenida por el usuario.' : m.error ?? 'La ejecución se interrumpió.'}
          </div>
        )}

        {!live && m.usage && (
          <footer className="turn-foot">
            <UsageLine m={m} />
          </footer>
        )}
      </div>
    </motion.article>
  );
});


export function fileNameOf(p: string) {
  return basename(p);
}

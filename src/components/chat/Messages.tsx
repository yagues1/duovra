import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, CircleAlert, FileText, Image as ImageIcon, Layers, ShieldQuestion, Square } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { Approval, FileChange, Message, RunView, TimelineItem } from '../../lib/types';
import { AGENT_NAME, basename, displayCommand, effortLabel, fmtDuration, fmtTime, fmtTokens, relativeTo } from '../../lib/format';
import { diffStats, parseUnified } from '../../lib/diff';
import { useStore } from '../../state/store';
import { AgentGlyph } from '../ui/AgentGlyph';
import { CopyButton, Markdown } from './Markdown';
import { TimelineEntry, changeLines, openDiffTab } from './TimelineItems';
import { SPRING } from '../../lib/motion';

// ---------- Usuario ----------

export const UserBubble = memo(function UserBubble({ m }: { m: Message }) {
  const note = m.contextNote;
  return (
    <motion.div
      className="flex flex-col items-end gap-1.5"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <div className="bubble-user selectable">
        <div className="whitespace-pre-wrap">{m.content}</div>
        {m.attachments && m.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.attachments.map((a) => (
              <span key={a.path} className="chip" data-tip={a.path}>
                {a.image ? <ImageIcon size={12} /> : <FileText size={12} />} {a.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 pr-1 text-[11.5px] faint">
        {note?.mode === 'shared' && (
          <span className="context-note" tabIndex={0} data-tip="El agente recibió estos intercambios porque su sesión no los había visto">
            <Layers size={11} />
            Contexto compartido: {note.messages} {note.messages === 1 ? 'mensaje' : 'mensajes'}
            {note.agents && note.agents.length > 0 && ` de ${note.agents.map((a) => AGENT_NAME[a]).join(' y ')}`}
            {note.omitted ? ` (${note.omitted} omitidos)` : ''}
          </span>
        )}
        {m.agent && <span>Para {AGENT_NAME[m.agent]}</span>}
        <span>{fmtTime(m.createdAt)}</span>
      </div>
    </motion.div>
  );
});

// ---------- Agente ----------

type Group = { kind: 'text'; item: TimelineItem } | { kind: 'activity'; items: TimelineItem[]; key: string };

function groupItems(items: TimelineItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    if (it.kind === 'diff') continue;
    if (it.kind === 'text') {
      if ((it.text ?? '').length || it.status === 'running') out.push({ kind: 'text', item: it });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'activity') last.items.push(it);
    else out.push({ kind: 'activity', items: [it], key: it.id });
  }
  return out;
}

function ActivityGroup({ items, live }: { items: TimelineItem[]; live: boolean }) {
  const running = items.some((i) => i.status === 'running');
  const [open, setOpen] = useState(live);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  const commands = items.filter((i) => i.kind === 'command').length;
  const files = new Set(items.flatMap((i) => (i.changes ?? []).map((c) => c.path))).size;
  const actions = items.filter((i) => i.kind !== 'reasoning' && i.kind !== 'notice').length;
  const thought = items.some((i) => i.kind === 'reasoning');
  const parts = [
    actions ? `${actions} ${actions === 1 ? 'acción' : 'acciones'}` : thought ? 'Razonamiento' : 'Avisos',
    commands ? `${commands} ${commands === 1 ? 'comando' : 'comandos'}` : null,
    files ? `${files} ${files === 1 ? 'archivo' : 'archivos'}` : null,
  ].filter(Boolean);
  const show = open || running;
  return (
    <div className="activity">
      <button className="activity-head" onClick={() => setOpen((o) => !o)} aria-expanded={show}>
        <motion.span animate={{ rotate: show ? 90 : 0 }} transition={{ duration: 0.16 }} className="grid place-items-center">
          <ChevronRight size={13} />
        </motion.span>
        <span>{parts.join(', ')}</span>
      </button>
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className="overflow-hidden"
          >
            <div className="timeline">
              {items.map((it) => (
                <TimelineEntry key={it.id} item={it} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function collectChanges(items: TimelineItem[]): FileChange[] {
  const byPath = new Map<string, FileChange[]>();
  for (const it of items) {
    if (it.kind !== 'file_change' || it.status === 'declined' || it.status === 'failed') continue;
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

function ChangesSummary({ items }: { items: TimelineItem[] }) {
  const root = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.path);
  const changes = useMemo(() => collectChanges(items), [items]);
  const turnDiff = items.find((i) => i.kind === 'diff')?.diff;
  if (!changes.length) return null;
  const stats = changes.map((c) => ({ c, s: diffStats(changeLines(c)) }));
  const total = turnDiff ? diffStats(parseUnified(turnDiff)) : stats.reduce((a, x) => ({ added: a.added + x.s.added, removed: a.removed + x.s.removed }), { added: 0, removed: 0 });
  return (
    <div className="changes-card">
      <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3 text-[13px]">
        <span style={{ color: 'var(--text-strong)' }} className="font-medium">
          {changes.length} {changes.length === 1 ? 'archivo modificado' : 'archivos modificados'}
        </span>
        <span style={{ color: 'var(--success)' }}>+{total.added}</span>
        <span style={{ color: 'var(--danger)' }}>−{total.removed}</span>
        {turnDiff && (
          <button
            className="btn ml-auto h-7 px-3 text-[12px]"
            onClick={() => useStore.getState().openTab({ id: `turndiff:${turnDiff.length}`, kind: 'diff', title: 'Diff del turno', payload: { change: { path: 'Diff completo del turno', kind: 'update', diff: turnDiff } } })}
          >
            Ver diff completo
          </button>
        )}
      </div>
      <div className="px-1.5 pb-1.5">
        {stats.map(({ c, s }) => (
          <button key={c.path} className="file-line" onClick={() => openDiffTab(c)}>
            <FileText size={12} className="faint" />
            <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" data-tip={c.path}>
              {relativeTo(c.path, root)}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--success)' }}>+{s.added}</span>
            <span className="text-[11.5px]" style={{ color: 'var(--danger)' }}>−{s.removed}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const APPROVAL_LABEL: Record<string, string> = {
  accept: 'Permitir',
  acceptForSession: 'Permitir en esta sesión',
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
      className="approval-card"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={SPRING.enter}
      role="alertdialog"
      aria-label="Solicitud de permiso"
    >
      <div className="flex items-center gap-2 text-[13.5px]">
        <ShieldQuestion size={15} style={{ color: 'var(--warning)' }} />
        <span style={{ color: 'var(--text-strong)' }} className="font-medium">
          {AGENT_NAME[info.agent]} {title}
        </span>
      </div>
      {info.command && <pre className="tl-pre selectable mt-2.5">{displayCommand(info.command)}</pre>}
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
        <pre className="tl-pre selectable mt-2.5">{JSON.stringify(info.input, null, 2).slice(0, 2400)}</pre>
      )}
      {reason && <p className="mb-0 mt-2 text-[12.5px] muted">{reason}</p>}
      {info.cwd && <p className="mb-0 mt-1 font-mono text-[11.5px] faint">{info.cwd}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {info.options.map((o) => (
          <button
            key={o}
            disabled={busy}
            className={o === 'accept' ? 'btn btn-primary' : o === 'decline' ? 'btn btn-danger' : 'btn'}
            onClick={() => {
              setBusy(true);
              void respond(conversationId, a.approvalId, o);
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

function WorkingIndicator({ run }: { run: RunView }) {
  const waiting = run.approvals.length > 0;
  const current = [...run.items].reverse().find((i) => i.status === 'running' && i.kind !== 'text');
  const label = run.stopping
    ? 'Deteniendo…'
    : waiting
      ? 'Esperando tu permiso'
      : current?.kind === 'command'
        ? 'Ejecutando un comando'
        : current?.kind === 'reasoning'
          ? 'Razonando'
          : current?.kind === 'file_change'
            ? 'Editando archivos'
            : 'Trabajando';
  return (
    <div className="working" aria-live="polite">
      <span className="working-orb" style={{ ['--c' as string]: `var(--agent-${run.agent})` }} aria-hidden />
      <span className={waiting ? '' : 'shimmer-text'} style={waiting ? { color: 'var(--warning)' } : undefined}>
        {label}
      </span>
      <span className="faint">
        <Elapsed since={run.startedAt} />
      </span>
    </div>
  );
}

function UsageLine({ m }: { m: Message }) {
  const u = m.usage;
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens != null) parts.push(`${fmtTokens(u.inputTokens)} entrada`);
  if (u.outputTokens != null) parts.push(`${fmtTokens(u.outputTokens)} salida`);
  if (u.costUsd != null) parts.push(`≈ ${u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2)} USD (estimación de la CLI)`);
  if (m.completedAt) parts.push(fmtDuration(m.completedAt - m.createdAt));
  return (
    <span className="flex flex-wrap gap-x-3">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </span>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ m, run }: { m: Message; run?: RunView }) {
  const live = !!run;
  const items = run ? run.items : (m.items ?? []);
  const groups = useMemo(() => {
    const g = groupItems(items);
    // Algunas CLIs repiten el error como texto de respuesta: se muestra solo en el aviso de error.
    return m.status === 'failed' && m.error ? g.filter((x) => !(x.kind === 'text' && x.item.text?.trim() === m.error?.trim())) : g;
  }, [items, m.status, m.error]);
  const agent = m.agent ?? 'codex';
  const requested = (m.usage as { requestedModel?: string } | null)?.requestedModel;
  const model = run?.resolvedModel ?? m.model;
  const showModel = run
    ? model && model !== m.model ? `${m.model} → ${model}` : m.model
    : requested ? `${requested} → ${m.model}` : m.model;
  const status = live ? 'running' : m.status;
  return (
    <motion.article
      className="agent-msg"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      aria-busy={live}
    >
      <header className="mb-2.5 flex items-center gap-2.5">
        <AgentGlyph agent={agent} size={26} active={live} />
        <span className="text-[13.5px] font-medium" style={{ color: 'var(--text-strong)' }}>
          {AGENT_NAME[agent]}
        </span>
        <span className="model-chip" data-tip="Modelo exacto usado en este mensaje">
          {showModel}
          {m.effort && <span className="faint"> {effortLabel(m.effort).toLowerCase()}</span>}
        </span>
        <span className="ml-auto text-[11.5px] faint">{fmtTime(m.createdAt)}</span>
      </header>

      <div className="flex flex-col gap-3 pl-[36px]">
        {groups.map((g, i) =>
          g.kind === 'text' ? (
            <div key={g.item.id} className={g.item.status === 'running' ? 'streaming' : undefined}>
              <Markdown text={g.item.text ?? ''} />
            </div>
          ) : (
            <ActivityGroup key={g.key} items={g.items} live={live && i === groups.length - 1} />
          ),
        )}

        <AnimatePresence>
          {run?.approvals.map((a) => (
            <ApprovalCard key={a.approvalId} a={a} conversationId={m.conversationId} />
          ))}
        </AnimatePresence>

        {run && <WorkingIndicator run={run} />}

        {!live && <ChangesSummary items={items} />}

        {status === 'failed' && (
          <div className="error-box selectable" role="alert">
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 whitespace-pre-wrap">{m.error ?? 'La ejecución falló.'}</div>
          </div>
        )}
        {status === 'interrupted' && (
          <div className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--warning)' }}>
            <Square size={11} fill="currentColor" />
            {m.error ?? 'Detenido por el usuario.'}
          </div>
        )}

        {!live && (
          <footer className="msg-footer">
            <UsageLine m={m} />
            {m.content && <CopyButton text={m.content} label="Copiar respuesta" />}
          </footer>
        )}
      </div>
    </motion.article>
  );
});

export function fileNameOf(p: string) {
  return basename(p);
}

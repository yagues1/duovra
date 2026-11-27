import { Activity, CircleStop, ListChecks } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { activityLabel, deriveActivity } from '../../lib/activity';
import { centerRows, isActive, subagentSummary, taskProgress, type CenterRow, type CenterStatus, type QueueOverview } from '../../lib/activityCenter';
import { AGENT_NAME, displayTitle } from '../../lib/format';
import type { RunInsights } from '../../lib/insights';
import { api } from '../../lib/ipc';
import { invoke, listen } from '../../lib/tauriTransport';
import { useActivityCenter } from '../../state/activityCenter';
import { useStore } from '../../state/store';
import { useLayout } from '../../hooks/useLayout';
import { Popover } from '../ui/Popover';
import { Mascot } from '../mascot/Mascot';
import { tr, useTr } from '../../i18n';

const statusLabel = (s: CenterStatus) => ({
  working: tr('Trabajando'), approval: tr('Esperando aprobación'), answer: tr('Esperando respuesta'), stopping: tr('Interrumpiendo'),
  queued: tr('En cola'), done: tr('Completado'), error: tr('Error'), cancelled: tr('Detenido'),
})[s];

/** Ejecuciones activas (y esperas) de todos los proyectos: alimenta el número del acceso lateral. */
export function useActiveCount(): number {
  return useStore((s) => {
    const ids = new Set(Object.keys(s.runs));
    for (const [id, n] of Object.entries(s.pendingInteractions)) if (n > 0) ids.add(id);
    return ids.size;
  });
}

/**
 * Acceso discreto en la barra lateral: un icono con el número de ejecuciones activas cuando las hay.
 * Abre el Activity Center como superficie flotante (no es un panel permanente).
 */
export function ActivityButton({ rail }: { rail?: boolean }) {
  const tr = useTr();
  const ref = useRef<HTMLButtonElement>(null);
  const centerOpen = useActivityCenter((s) => s.open);
  const layout = useLayout();
  const drawer = useStore((s) => s.navDrawer);
  const owner = rail ? layout.rail && !(layout.compactNav && drawer) : !layout.rail || (layout.compactNav && drawer);
  const open = centerOpen && owner;
  const setOpen = useActivityCenter((s) => s.setOpen);
  const count = useActiveCount();
  const label = count ? tr('Actividad · {n} en curso', { n: count }) : tr('Actividad');
  return (
    <>
      <button ref={ref} type="button" data-activity-center className={rail ? 'rail-btn' : 'side-link'} data-tip-side={rail ? 'right' : undefined}
        data-tip={rail ? label : undefined} aria-label={label} aria-expanded={open} aria-haspopup="dialog" data-active={open || undefined}
        onClick={() => setOpen(!open)}>
        <Activity size={rail ? 17 : 16} strokeWidth={1.6} aria-hidden />
        {!rail && <span className="flex-1 truncate">{tr('Actividad')}</span>}
        {count > 0 && <span className="activity-count" aria-hidden>{count}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} placement="top-start" role="dialog" width={372}
        ariaLabel={tr('Activity Center')} className="activity-center">
        {open && <ActivityCenterBody close={() => setOpen(false)} />}
      </Popover>
    </>
  );
}

function ActivityCenterBody({ close }: { close: () => void }) {
  const tr = useTr();
  const { runs, pending } = useStore(useShallow((s) => ({ runs: s.runs, pending: s.pendingInteractions })));
  const recent = useActivityCenter((s) => s.recent);
  const clearRecent = useActivityCenter((s) => s.clearRecent);
  const [queues, setQueues] = useState<QueueOverview[]>([]);
  // Cola de todas las conversaciones: se lee al abrir y cuando cambia (sin sondeo).
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const read = () => void invoke<QueueOverview[]>('queue_overview').then((q) => { if (alive) setQueues(q); }, () => undefined);
    read();
    const off = listen<{ type?: string }>('run-event', ({ payload }) => {
      if (payload?.type !== 'queueChanged' && payload?.type !== 'finished' && payload?.type !== 'started') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(read, 250);
    });
    return () => { alive = false; window.clearTimeout(timer); void off.then((u) => u(), () => undefined); };
  }, []);
  const rows = useMemo(() => centerRows(runs, pending, queues, recent), [runs, pending, queues, recent]);
  const insights = useRunInsights(rows.map((r) => r.run?.messageId).filter((id): id is string => !!id));
  const active = rows.filter((r) => isActive(r.status) || r.status === 'queued');
  const finished = rows.filter((r) => !isActive(r.status) && r.status !== 'queued');
  return (
    <div className="ac-body" data-popover-focus tabIndex={-1}>
      <header className="ac-head">
        <strong>{tr('Actividad')}</strong>
        <span role="status">{active.length ? tr('{n} en curso', { n: active.length }) : tr('Sin ejecuciones activas')}</span>
      </header>
      {!rows.length && <p className="ac-empty">{tr('Cuando un agente trabaje en cualquier proyecto, lo verás aquí.')}</p>}
      {active.length > 0 && <ul className="ac-list">{active.map((r) => <Row key={r.conversationId} row={r} insights={r.run ? insights[r.run.messageId] : undefined} close={close} />)}</ul>}
      {finished.length > 0 && (
        <section className="ac-recent" aria-label={tr('Terminadas en esta sesión')}>
          <div className="ac-sub">
            <span>{tr('Terminadas en esta sesión')}</span>
            <button type="button" className="notice-link" onClick={clearRecent}>{tr('Limpiar')}</button>
          </div>
          <ul className="ac-list">{finished.map((r) => <Row key={r.conversationId} row={r} close={close} />)}</ul>
        </section>
      )}
    </div>
  );
}

/** Insights de las ejecuciones visibles: lectura inicial y relectura agrupada al cambiar (100 ms). */
function useRunInsights(ids: string[]) {
  const key = ids.join(',');
  const [data, setData] = useState<Record<string, RunInsights | null>>({});
  useEffect(() => {
    if (!ids.length) return;
    let alive = true;
    const dirty = new Set<string>();
    let timer: number | undefined;
    const read = (list: string[]) => {
      for (const id of list) void api.runInsights(id).then((v) => { if (alive) setData((d) => ({ ...d, [id]: v })); }, () => undefined);
    };
    read(ids);
    const off = listen<string>('agent-insights', ({ payload }) => {
      if (!ids.includes(payload)) return;
      dirty.add(payload);
      if (timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; const list = [...dirty]; dirty.clear(); read(list); }, 100);
    });
    return () => { alive = false; window.clearTimeout(timer); void off.then((u) => u(), () => undefined); };
  }, [key]);
  return data;
}

const Row = memo(function Row({ row, insights, close }: { row: CenterRow; insights?: RunInsights | null; close: () => void }) {
  const tr = useTr();
  const conv = useStore((s) => s.conversations.find((c) => c.id === row.conversationId));
  const project = useStore((s) => s.projects.find((p) => p.id === conv?.projectId));
  const worktree = useStore((s) => (conv?.worktreeId ? s.worktrees.find((w) => w.id === conv.worktreeId) : undefined));
  const cancel = useStore((s) => s.cancel);
  const live = !!row.run;
  const progress = live ? taskProgress(insights?.details.plans) : null;
  const workers = subagentSummary(insights, live);
  const now = row.run ? activityLabel(row.run, deriveActivity(row.run, undefined, Date.now())).label : null;
  const agent = row.agent ?? conv?.lastAgent ?? null;
  const open = () => {
    close();
    void useStore.getState().selectConversation(row.conversationId);
  };
  if (!conv) return null;
  const where = [project?.name, worktree?.label].filter(Boolean).join(' · ');
  return (
    <li className="ac-row" data-status={row.status}>
      <button type="button" className="ac-main" onClick={open} aria-label={tr('Ir a «{title}»', { title: displayTitle(conv.title) })}>
        <span className="ac-ic" aria-hidden>{agent ? <Mascot agent={agent} state={row.status === 'error' ? 'error' : 'idle'} size={20} animated={false} /> : <ListChecks size={14} />}</span>
        <span className="ac-text">
          <span className="ac-line">
            <strong>{displayTitle(conv.title)}</strong>
            <span className="ac-status" data-status={row.status}><i aria-hidden />{statusLabel(row.status)}{row.status === 'queued' && row.queuePaused ? ` · ${tr('en pausa')}` : ''}</span>
          </span>
          <span className="ac-meta">{[where, agent && AGENT_NAME[agent], row.model].filter(Boolean).join(' · ')}</span>
          {live && <span className="ac-now">{progress?.running ?? now}</span>}
          {live && (progress
            ? <span className="ac-progress" role="progressbar" aria-label={tr('Tareas completadas')} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}
                aria-valuetext={tr('{done} de {total} tareas completadas', { done: progress.done, total: progress.total })}>
                <span className="ac-track"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></span>
                <small>{progress.done}/{progress.total}</small>
              </span>
            : <span className="ac-progress" data-indeterminate aria-hidden><span className="ac-track"><span /></span></span>)}
          {(workers.total > 0 || row.queued > 0) && (
            <span className="ac-meta">
              {[workers.running ? tr('{n} subagentes activos', { n: workers.running }) : workers.total ? tr('{n} subagentes', { n: workers.total }) : '',
                row.queued && row.status !== 'queued' ? tr('{n} en cola', { n: row.queued }) : row.status === 'queued' ? tr('{n} mensajes', { n: row.queued }) : '',
              ].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
      </button>
      {row.run && !row.run.stopping && (
        <button type="button" className="btn-icon ac-stop" aria-label={tr('Detener la ejecución de «{title}»', { title: displayTitle(conv.title) })}
          data-tip={tr('Detener')} onClick={() => void cancel(row.conversationId)}>
          <CircleStop size={15} aria-hidden />
        </button>
      )}
    </li>
  );
});

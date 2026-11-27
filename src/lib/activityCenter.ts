/**
 * Activity Center (1.0.11, fase 6): estado de las ejecuciones de todos los proyectos a partir de datos
 * que Duovra ya tiene (ejecuciones, aprobaciones, planes y preguntas pendientes, cola e insights).
 * Nada se estima: el progreso solo existe cuando el proveedor comunicó la lista completa de tareas.
 */
import type { InsightStatus, PlanSnapshot, RunInsights, SubagentInsight } from './insights';
import type { AgentId, RunView } from './types';

export type CenterStatus = 'working' | 'approval' | 'answer' | 'stopping' | 'queued' | 'done' | 'error' | 'cancelled';

/** Prioridad de orden: lo que espera al usuario primero. */
const ORDER: Record<CenterStatus, number> = { approval: 0, answer: 1, stopping: 2, working: 3, queued: 4, error: 5, cancelled: 6, done: 7 };

export interface CenterRow {
  conversationId: string;
  status: CenterStatus;
  agent: AgentId | null;
  model: string | null;
  run: RunView | null;
  pending: number;
  queued: number;
  queuePaused: boolean;
  endedAt?: number;
}

export interface RecentRun {
  conversationId: string;
  messageId: string;
  agent: AgentId;
  model: string;
  status: string;
  endedAt: number;
}

export interface QueueOverview { conversationId: string; pending: number; pauseReason: string | null }

export function centerRows(
  runs: Record<string, RunView>, pendingInteractions: Record<string, number>, queues: QueueOverview[], recent: RecentRun[],
): CenterRow[] {
  const rows = new Map<string, CenterRow>();
  const queueOf = new Map(queues.map((q) => [q.conversationId, q]));
  for (const run of Object.values(runs)) {
    const pending = pendingInteractions[run.conversationId] ?? 0;
    const q = queueOf.get(run.conversationId);
    const status: CenterStatus = run.stopping ? 'stopping' : run.approvals.length ? 'approval' : pending ? 'answer' : 'working';
    rows.set(run.conversationId, {
      conversationId: run.conversationId, status, agent: run.agent, model: run.resolvedModel ?? run.model, run,
      pending, queued: q?.pending ?? 0, queuePaused: !!q?.pauseReason,
    });
  }
  // Planes o preguntas que esperan aunque la ejecución ya no exista (fase 4).
  for (const [conversationId, n] of Object.entries(pendingInteractions)) {
    if (n > 0 && !rows.has(conversationId)) {
      const q = queueOf.get(conversationId);
      rows.set(conversationId, { conversationId, status: 'answer', agent: null, model: null, run: null, pending: n, queued: q?.pending ?? 0, queuePaused: !!q?.pauseReason });
    }
  }
  for (const q of queues) {
    if (q.pending > 0 && !rows.has(q.conversationId)) {
      rows.set(q.conversationId, { conversationId: q.conversationId, status: 'queued', agent: null, model: null, run: null, pending: 0, queued: q.pending, queuePaused: !!q.pauseReason });
    }
  }
  for (const r of recent) {
    if (rows.has(r.conversationId)) continue;
    const status: CenterStatus = r.status === 'done' ? 'done' : r.status === 'failed' ? 'error' : 'cancelled';
    rows.set(r.conversationId, { conversationId: r.conversationId, status, agent: r.agent, model: r.model, run: null, pending: 0, queued: 0, queuePaused: false, endedAt: r.endedAt });
  }
  return [...rows.values()].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/** Ejecuciones que cuentan en el indicador de la barra lateral. */
export const isActive = (s: CenterStatus) => s === 'working' || s === 'approval' || s === 'answer' || s === 'stopping';

/** Fuentes que comunican la lista completa en cada actualización: solo con ellas se conoce el total. */
export function isCompleteList(source: string): boolean {
  return source.includes('TodoWrite') || source.includes('turn/plan/updated');
}

export interface TaskProgress { done: number; total: number; running: string | null; source: string }

/**
 * Progreso de tareas completadas sobre el total comunicado (nunca tiempo ni esfuerzo restante). `null`
 * si ninguna fuente comunica la lista completa: la interfaz muestra entonces actividad indeterminada.
 */
export function taskProgress(plans: readonly PlanSnapshot[] | undefined): TaskProgress | null {
  const latest = [...(plans ?? [])].reverse().find((p) => isCompleteList(p.source));
  if (!latest) return null;
  const tasks = latest.tasks.filter((t) => t.status !== 'removed');
  if (!tasks.length) return null;
  const running = tasks.find((t) => t.status === 'running');
  return {
    done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length,
    running: running ? running.activeForm || running.title || null : null, source: latest.source,
  };
}

/** Estado final de un subagente tal como se conoce. Sin cierre comunicado tras terminar el turno: desconocido. */
export type WorkerOutcome = 'running' | 'completed' | 'cancelled' | 'failed' | 'unknown' | 'pending' | 'blocked';
export function workerOutcome(status: InsightStatus | undefined, live: boolean): WorkerOutcome {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'blocked') return live ? status : 'unknown';
  if (status === 'running') return live ? 'running' : 'unknown';
  return live ? 'running' : 'unknown';
}

export function subagentSummary(insights: RunInsights | null | undefined, live: boolean) {
  const workers = Object.values(insights?.details.subagents ?? {}) as SubagentInsight[];
  const outcomes = workers.map((w) => workerOutcome(w.status, live));
  return { total: workers.length, running: outcomes.filter((o) => o === 'running').length };
}

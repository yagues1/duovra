import { ArrowUpRight, ChevronRight, CircleAlert, GitFork, ListChecks, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { AGENT_NAME, effortLabel, fmtDuration } from '../../lib/format';
import { groupBy, insightCost, insightNumber, type InsightStatus, type PlanSnapshot, type RunInsights } from '../../lib/insights';
import { api, errorText } from '../../lib/ipc';
import { listen } from '../../lib/tauriTransport';
import type { Message, MessageStatus, TimelineItem } from '../../lib/types';
import { useStore } from '../../state/store';
import { layoutTurn, operationKind, pinned, summarizeActivity, summaryBreakdown } from '../../lib/turnActivity';
import { Mascot } from '../mascot/Mascot';
import { TimelineEntry } from '../chat/TimelineItems';
import { ChangesSummary } from '../chat/Messages';

const EMPTY: Message[] = [];
const NO_ITEMS: TimelineItem[] = [];
const TURN_STATUS: Record<MessageStatus, string> = {
  running: 'En curso', done: 'Completado', failed: 'Fallido', cancelled: 'Cancelado', interrupted: 'Interrumpido',
};
const STATUS: Record<InsightStatus, string> = {
  pending: 'Pendiente', running: 'En progreso', completed: 'Completada', blocked: 'Bloqueada',
  failed: 'Fallida', cancelled: 'Cancelada', interrupted: 'Interrumpida', removed: 'Eliminada',
};

/**
 * Workbench · Actividad: qué ha hecho el agente en un turno. Todo lo que se ve corresponde al mismo
 * turno y proveedor (el último por defecto): estado, autorizaciones y errores, resumen, cambios,
 * plan, subagentes y operaciones. Identificadores, consumo y contexto quedan en «Detalles».
 */
export function ActivityPanel() {
  const conversationId = useStore((s) => s.activeConversationId);
  if (!conversationId) return <p className="workspace-note">Selecciona una conversación.</p>;
  return <TurnActivityPanel key={conversationId} conversationId={conversationId} />;
}

function goToTurn(id: string) {
  useStore.getState().closeChatFind();
  useStore.getState().closePanel();
  requestAnimationFrame(() => {
    const element = document.getElementById(`turn-${id}`);
    element?.scrollIntoView({ block: 'start', behavior: 'instant' });
    element?.focus({ preventScroll: true });
  });
}

function useInsights(turn: Message) {
  const [state, setState] = useState<{ data: RunInsights | null; error?: string }>();
  useEffect(() => {
    let active = true;
    let token = 0;
    let timer: number | undefined;
    const read = () => {
      const request = ++token;
      void api.runInsights(turn.id).then(
        (data) => { if (active && request === token) setState({ data }); },
        (error) => { if (active && request === token) setState({ data: null, error: errorText(error) }); },
      );
    };
    read();
    const dispose = listen<string>('agent-insights', ({ payload }) => {
      if (payload !== turn.id || !active || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; read(); }, 100);
    }).then((unlisten) => { if (active) read(); return unlisten; }, () => undefined);
    return () => { active = false; window.clearTimeout(timer); void dispose.then((unlisten) => unlisten?.()); };
  }, [turn.id, turn.status]);
  return state;
}

function TurnActivityPanel({ conversationId }: { conversationId: string }) {
  const messages = useStore((s) => s.messages[conversationId] ?? EMPTY);
  const turns = useMemo(() => messages.filter((m) => m.role === 'assistant' && m.agent).reverse(), [messages]);
  const [selected, setSelected] = useState('');
  const selectId = useId();
  const turn = turns.find((m) => m.id === selected) ?? turns[0];
  if (!turn) {
    return <div className="activity-panel"><p className="ap-empty">Cuando un agente trabaje en esta conversación, aquí verás qué ha hecho, qué archivos ha cambiado y qué queda pendiente.</p></div>;
  }
  return (
    <div className="activity-panel">
      <div className="ap-turn-select">
        <label htmlFor={selectId} className="sr-only">Turno</label>
        <select id={selectId} className="insight-select" value={selected && turns.some((m) => m.id === selected) ? selected : ''}
          onChange={(e) => setSelected(e.target.value)}>
          <option value="">Último turno · {AGENT_NAME[turns[0].agent!]}</option>
          {turns.map((m) => <option key={m.id} value={m.id}>
            #{m.seq} · {AGENT_NAME[m.agent!]} · {new Date(m.createdAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}
          </option>)}
        </select>
        <button type="button" className="btn-icon" aria-label="Ir al turno en la conversación" data-tip="Ir al turno"
          onClick={() => goToTurn(turn.id)}><ArrowUpRight size={15} aria-hidden /></button>
      </div>
      <TurnSummary key={turn.id} turn={turn} messages={messages} />
    </div>
  );
}

function TurnSummary({ turn, messages }: { turn: Message; messages: Message[] }) {
  // La ejecución en curso solo se usa si es exactamente este turno (nunca la de otro mensaje).
  const run = useStore((s) => {
    const live = s.runs[turn.conversationId];
    return live?.messageId === turn.id ? live : undefined;
  });
  const items = run?.items ?? turn.items ?? NO_ITEMS;
  const insights = useInsights(turn);
  // La respuesta final no es una nota de trabajo: el resumen cuenta solo la actividad.
  const summary = useMemo(() => summarizeActivity(layoutTurn(items, !!run).activity), [items, run]);
  const operations = useMemo(() => items.filter((item) => operationKind(item) !== null), [items]);
  const problems = operations.filter(pinned);
  const status: MessageStatus = run ? 'running' : turn.status;
  const agent = turn.agent!;
  const fast = (turn.usage as { fast?: boolean } | null)?.fast || insights?.data?.details.requestedSpeed && insights.data.details.requestedSpeed !== 'default';
  const duration = turn.completedAt ? turn.completedAt - turn.createdAt : null;
  const plans = groupBy(insights?.data?.details.plans ?? [], (p) => p.source);
  const workers = Object.entries(insights?.data?.details.subagents ?? {});
  const breakdown = summaryBreakdown(summary);
  return (
    <>
      <header className="ap-head" data-agent={agent}>
        <Mascot agent={agent} state={status === 'failed' ? 'error' : status === 'running' ? 'thinking' : 'idle'} size={34} animated={false} />
        <div className="min-w-0 flex-1">
          <div className="ap-title">
            <strong>{AGENT_NAME[agent]}</strong>
            <span className="ap-status" data-status={status} role="status">{TURN_STATUS[status]}</span>
          </div>
          <p className="ap-sub">
            {turn.model}{turn.effort ? ` · ${effortLabel(turn.effort).toLowerCase()}` : ''}{fast ? ' · rápido' : ''}
            {duration ? ` · ${fmtDuration(duration)}` : ''}
          </p>
        </div>
      </header>

      {!!run?.approvals.length && (
        <div className="ap-callout" data-tone="warn" role="status">
          <ShieldAlert size={15} aria-hidden />
          <span>{AGENT_NAME[agent]} espera tu autorización para continuar.</span>
          <button type="button" className="notice-link" onClick={() => goToTurn(turn.id)}>Responder</button>
        </div>
      )}
      {status === 'failed' && (
        <div className="ap-callout" data-tone="error" role="status">
          <CircleAlert size={15} aria-hidden />
          <span className="selectable">{turn.error ?? 'La ejecución terminó con un error.'}</span>
        </div>
      )}

      <section className="ap-section" aria-label="Resumen del turno">
        <div className="ap-stats">
          <Stat value={summary.operations} label={summary.operations === 1 ? 'operación' : 'operaciones'} />
          <Stat value={summary.files} label={summary.files === 1 ? 'archivo cambiado' : 'archivos cambiados'} />
          <Stat value={summary.failed + summary.declined} label="incidencias" tone={summary.failed + summary.declined ? 'error' : undefined} />
        </div>
        {breakdown.length > 0 && <p className="ap-note">{breakdown.join(' · ')}</p>}
      </section>

      {problems.length > 0 && (
        <section className="ap-section" aria-label="Errores y rechazos">
          <h3><CircleAlert size={14} aria-hidden /> Errores y rechazos</h3>
          <div className="ap-list">{problems.map((item) => <TimelineEntry key={item.id} item={item} />)}</div>
        </section>
      )}

      <ChangesSummary items={items} />

      {plans.size > 0 && (
        <section className="ap-section">
          <h3><ListChecks size={14} aria-hidden /> Plan y tareas</h3>
          {[...plans].map(([source, snapshots]) => <PlanBlock key={source} source={source} snapshots={snapshots} live={status === 'running'} />)}
        </section>
      )}

      {workers.length > 0 && (
        <section className="ap-section">
          <h3><GitFork size={14} aria-hidden /> Subagentes</h3>
          <Workers workers={workers} live={status === 'running'} />
        </section>
      )}

      {operations.length > 0 && (
        <details className="ap-fold" open={operations.length <= 6 || undefined}>
          <summary><ChevronRight size={13} aria-hidden /> Operaciones <span className="ap-count">{operations.length}</span></summary>
          <div className="ap-list">{operations.map((item) => <TimelineEntry key={item.id} item={item} live={status === 'running'} />)}</div>
        </details>
      )}
      {!operations.length && status !== 'running' && <p className="ap-note">Este turno no registró operaciones: el agente solo respondió.</p>}

      <details className="ap-fold ap-details">
        <summary><ChevronRight size={13} aria-hidden /> Detalles</summary>
        {!insights ? <p role="status" className="insight-note">Cargando información del turno…</p>
          : insights.error ? <p role="status" className="insight-note">{insights.error}</p>
          : <ContextDetails data={insights.data} turn={turn} messages={messages} />}
        <button type="button" className="btn ap-stats-link" onClick={() => {
          const store = useStore.getState();
          store.closePanel();
          store.setView('settings', 'statistics');
        }}><ArrowUpRight size={13} aria-hidden /> Estadísticas de uso</button>
      </details>
    </>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'error' }) {
  return <div className="ap-stat" data-tone={tone}><strong>{value}</strong><span>{label}</span></div>;
}

function PlanBlock({ source, snapshots, live }: { source: string; snapshots: PlanSnapshot[]; live: boolean }) {
  const plan = snapshots.at(-1)!;
  const completed = plan.tasks.filter((t) => t.status === 'completed').length;
  const unfinished = plan.tasks.some((t) => t.status === 'pending' || t.status === 'running' || t.status === 'blocked');
  return (
    <div className="insight-plan">
      <div className="insight-caption"><span>{source}</span><span role="status">{completed} de {plan.tasks.length} completadas</span></div>
      {!live && unfinished && <p className="insight-note">Último estado del plan comunicado por el agente.</p>}
      <PlanRows plan={plan} />
      {snapshots.length > 1 && <details className="insight-disclosure">
        <summary><ChevronRight size={13} aria-hidden /><span>Revisiones anteriores ({snapshots.length - 1})</span></summary>
        <div className="insight-detail">
          {snapshots.slice(0, -1).map((older, i) => <details key={i} className="insight-disclosure">
            <summary><ChevronRight size={13} aria-hidden /><span>Revisión {i + 1}</span></summary>
            <PlanRows plan={older} />
          </details>)}
        </div>
      </details>}
    </div>
  );
}

function StateLabel({ status, worker = false }: { status?: InsightStatus | null; worker?: boolean }) {
  const labels = worker ? { ...STATUS, completed: 'Finalizado', blocked: 'Bloqueado', failed: 'Fallido', cancelled: 'Detenido', interrupted: 'Interrumpido', removed: 'Eliminado' } : STATUS;
  return <span className="insight-status" data-status={status ?? undefined}>{status ? labels[status] : 'Sin estado'}</span>;
}

function PlanRows({ plan }: { plan: PlanSnapshot }) {
  return (
    <>
      {plan.receivedAt != null && <p className="insight-note">Actualización recibida el{' '}
        <time dateTime={new Date(plan.receivedAt).toISOString()}>
          {new Date(plan.receivedAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'medium' })}
        </time>
      </p>}
      {plan.explanation && <p className="insight-note selectable">{plan.explanation}</p>}
      {plan.tasks.length === 0 ? <p className="insight-note">El proveedor dejó la lista vacía.</p> :
        <ol className="insight-list">
          {plan.tasks.map((task, i) => (
            <li key={task.id ?? i}>
              <details className="insight-disclosure">
                <summary>
                  <ChevronRight size={13} aria-hidden />
                  <span>{task.title || (task.id ? `Tarea #${task.id}` : 'Tarea sin nombre')}</span>
                  <StateLabel status={task.status} />
                </summary>
                <div className="insight-detail selectable">
                  {task.id && <p>ID {task.id}</p>}
                  {task.description && <p>{task.description}</p>}
                  {task.activeForm && <p>{task.activeForm}</p>}
                  {!!task.blockedBy?.length && <p>Depende de {task.blockedBy.map((id) => `#${id}`).join(', ')}</p>}
                  {!!task.blocks?.length && <p>Bloquea {task.blocks.map((id) => `#${id}`).join(', ')}</p>}
                  {!task.id && !task.description && !task.activeForm && !task.blockedBy?.length && !task.blocks?.length &&
                    <p>El proveedor solo comunicó el nombre y el estado.</p>}
                </div>
              </details>
            </li>
          ))}
        </ol>}
    </>
  );
}

function Workers({ workers, live }: { workers: [string, NonNullable<RunInsights['details']['subagents']>[string]][]; live: boolean }) {
  return (
    <ul className="insight-list">
            {workers.map(([key, worker]) => (
              <li key={key} className="insight-worker">
                <div className="insight-caption">
                  <strong>{worker.role || 'Subagente'}</strong>
                  {worker.status === 'running' && !live ? <span className="insight-status">Sin cierre</span>
                    : <StateLabel status={worker.status} worker />}
                </div>
                {worker.description && <p className="insight-note selectable">{worker.description}</p>}
                {worker.result && <p className="insight-note insight-result insight-result-preview selectable">{worker.result}</p>}
                <TechnicalDetails label="Detalles del subagente">
                  {worker.progress && <p>{worker.progress}</p>}
                  {worker.result && <p className="insight-result">{worker.result}</p>}
                  <Facts rows={[
                    ['Identificador', worker.id], ['Agente', worker.agentId], ['Ejecución del subagente', worker.runId],
                    ['Elemento del proveedor', worker.itemId],
                    ['Identificador del agente padre', worker.parentId], ['Modelo', worker.model],
                    ['Esfuerzo', worker.effort && effortLabel(worker.effort)], ['Herramientas observadas', worker.tools?.join(', ')],
                    ['Última herramienta', worker.lastTool], ['Llamadas de herramienta', worker.toolCalls],
                    ['Tokens comunicados', worker.totalTokens == null ? null : insightNumber(worker.totalTokens)],
                    ['Duración comunicada', fmtDuration(worker.durationMs)],
                    ['Finalización', worker.endedAt && new Date(worker.endedAt).toLocaleString('es')],
                  ].filter(([, value]) => value !== null && value !== undefined && value !== '') as Fact[]} />
                </TechnicalDetails>
              </li>
            ))}
          </ul>
  );
}

type Fact = [string, ReactNode];
function Facts({ rows }: { rows: Fact[] }) {
  return <dl className="insight-facts">{rows.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value ?? 'No disponible'}</dd></div>
  ))}</dl>;
}

function TechnicalDetails({ label, children }: { label: string; children: ReactNode }) {
  return <details className="insight-disclosure">
    <summary><ChevronRight size={13} aria-hidden /><span>{label}</span></summary>
    <div className="insight-detail selectable">{children}</div>
  </details>;
}

function ContextDetails({ data, turn, messages }: { data: RunInsights | null; turn: Message; messages: Message[] }) {
  const details = data?.details;
  const u = data?.legacy ? turn.usage : data?.metrics;
  const measured = data?.metrics;
  const source = details?.userMessageId ? messages.find((m) => m.id === details.userMessageId)
    : messages.find((m) => m.seq === turn.seq - 1 && m.role === 'user');
  const note = source?.contextNote;
  const continuity = details?.continuity === 'resumed' ? 'Sesión reanudada' : details?.continuity === 'new' ? 'Sesión nueva'
    : details?.continuity === 'resumeRequested' ? 'Reanudación solicitada' : undefined;
  const turnModel = details?.lastRequestModel ?? details?.reroutedTo;
  const requestedModel = details?.requestedModel ?? turn.model;
  return (
    <>
      <section className="insight-section">
        <h3>Sesión del proveedor</h3>
        <Facts rows={[
          [turnModel ? 'Modelo comunicado en el turno' : details?.sessionModel ? 'Modelo de la sesión' : 'Modelo solicitado',
            turnModel ?? details?.sessionModel ?? requestedModel],
          ['Esfuerzo solicitado', effortLabel(details?.requestedEffort ?? turn.effort) ?? undefined],
          ['Continuidad', continuity], ['Ventana informada', insightNumber(u?.contextWindow)],
          ['Entrada de la última solicitud', insightNumber(details?.lastInputTokens ?? measured?.contextTokens)],
        ]} />
        {details?.reroutedTo && <p className="insight-note">El proveedor redirigió de {details.reroutedFrom} a {details.reroutedTo}.</p>}
        {details?.compacted && <p className="insight-note">El proveedor comunicó una compactación en este turno.</p>}
        <TechnicalDetails label="Detalles de la sesión">
          <Facts rows={[
            ['Modelo solicitado', requestedModel], ['Modelo de la sesión', details?.sessionModel],
            ['Modelo comunicado en el turno', turnModel], ['Máximo de salida informado', insightNumber(measured?.maxOutputTokens)],
            ['Cuenta seleccionada', details?.accountLabel ?? details?.accountId ?? (details?.accountSource === 'cli' ? 'Perfil de la CLI' : undefined)],
            ['Sesión', details?.sessionId ?? measured?.sessionId], ['Turno del proveedor', details?.providerTurnId],
          ]} />
        </TechnicalDetails>
      </section>
      <section className="insight-section">
        <h3>Consumo del turno</h3>
        {data?.legacy && <p className="insight-note">Registro histórico con cobertura anterior a esta versión.</p>}
        {(measured?.partial || (measured?.accountingVersion && ['interrupted', 'cancelled', 'failed'].includes(turn.status))) &&
          <p className="insight-note">Medición parcial del turno.</p>}
        <Facts rows={[
          ['Entrada total', insightNumber(u?.inputTokens)],
          ['Salida', insightNumber(u?.outputTokens)], ['Total del turno', insightNumber(measured?.totalTokens)],
        ]} />
        <TechnicalDetails label="Desglose de consumo">
          <Facts rows={[
            ['Entrada fresca', insightNumber(measured?.freshInputTokens)], ['Lectura de caché', insightNumber(u?.cachedInputTokens)],
            ['Creación de caché', insightNumber(measured?.cacheWriteInputTokens)],
            [u?.costKind === 'reported' ? 'Coste reportado' : 'Coste estimado por la CLI', insightCost(u?.costUsd)],
            ...(turn.agent === 'codex' ? [['Acumulado del hilo de Codex', insightNumber(measured?.threadTotal?.totalTokens)] as Fact] : []),
          ]} />
          {turn.agent === 'claude' && <p>Los tokens del turno corresponden al agente principal. El coste estimado puede incluir delegaciones.</p>}
        </TechnicalDetails>
      </section>
      <section className="insight-section">
        <h3>Historial compartido</h3>
        <Facts rows={[
          ['Mensajes en Duovra al iniciar', insightNumber(details?.historyMessages)],
          ['Estado del bloque compartido', note?.mode === 'none' ? 'Sin historial compartido' : details?.contextSent
            ? 'Enviado al proveedor' : note ? 'Preparado por Duovra' : undefined],
        ]} />
        <TechnicalDetails label="Desglose del historial compartido">
          <Facts rows={[
            ['Mensajes incluidos', insightNumber(note?.mode === 'none' ? 0 : note?.messages)],
            ['Mensajes omitidos del intercambio', insightNumber(note?.mode === 'none' ? 0 : note?.omitted)],
            ['Caracteres del bloque compartido', insightNumber(note?.mode === 'none' ? 0 : note?.sharedChars)],
            ['Respuestas incluidas de', note?.agents?.length ? note.agents.map((agent) => AGENT_NAME[agent]).join(', ') : undefined],
          ]} />
          <p>El bloque compartido se mide en caracteres de texto preparado por Duovra. La sesión del proveedor mantiene su propio historial.</p>
        </TechnicalDetails>
      </section>
    </>
  );
}

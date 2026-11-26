import { ArrowUpRight, ChevronRight, CircleAlert, GitFork, ListChecks, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AGENT_NAME, effortLabel, fmtDuration } from '../../lib/format';
import { groupBy, insightCost, insightNumber, type InsightStatus, type PlanSnapshot, type RunInsights } from '../../lib/insights';
import { api, errorText } from '../../lib/ipc';
import { listen } from '../../lib/tauriTransport';
import type { Message, MessageStatus, TimelineItem } from '../../lib/types';
import { activeRoot, useStore } from '../../state/store';
import { layoutTurn, operationKind, pinned, summarizeActivity } from '../../lib/turnActivity';
import { diffStats } from '../../lib/diff';
import { Mascot } from '../mascot/Mascot';
import { changeLines, openDiffTab, TimelineEntry } from '../chat/TimelineItems';
import { collectChanges } from '../chat/Messages';
import { ChangeRows } from './DiffParts';
import { fmt, tr } from '../../i18n';

const EMPTY: Message[] = [];
const NO_ITEMS: TimelineItem[] = [];
const turnStatus = (s: MessageStatus) => ({ running: tr('En curso'), done: tr('Completado'), failed: tr('Fallido'), cancelled: tr('Cancelado'), interrupted: tr('Interrumpido') })[s];
const statusLabels = (): Record<InsightStatus, string> => ({
  pending: tr('Pendiente'), running: tr('En progreso'), completed: tr('Completada'), blocked: tr('Bloqueada'),
  failed: tr('Fallida'), cancelled: tr('Cancelada'), interrupted: tr('Interrumpida'), removed: tr('Eliminada'),
});

/**
 * Workbench · Actividad: qué ha hecho el agente en un turno. Todo lo que se ve corresponde al mismo
 * turno y proveedor (el último por defecto): estado, autorizaciones y errores, resumen, cambios,
 * plan, subagentes y operaciones. Identificadores, consumo y contexto quedan en «Detalles».
 */
export function ActivityPanel() {
  const conversationId = useStore((s) => s.activeConversationId);
  if (!conversationId) return <p className="workspace-note">{tr('Selecciona una conversación.')}</p>;
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
    const dispose = listen<string>('agent-insights', ({ payload }) => {
      if (payload !== turn.id || !active || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; read(); }, 100);
    });
    // Una sola lectura inicial, después de conectar el listener para no perder actualizaciones.
    void dispose.then(
      () => { if (active && token === 0 && timer === undefined) read(); },
      () => { if (active) read(); },
    );
    return () => { active = false; window.clearTimeout(timer); void dispose.then((unlisten) => unlisten(), () => undefined); };
  }, [turn.id, turn.status]);
  return state;
}

/** Solo la conversación activa: su turno más reciente, sin selector de otros turnos ni sesiones. */
function TurnActivityPanel({ conversationId }: { conversationId: string }) {
  const messages = useStore((s) => s.messages[conversationId] ?? EMPTY);
  const turn = useMemo(() => messages.findLast((m) => m.role === 'assistant' && !!m.agent), [messages]);
  if (!turn) {
    return <div className="activity-panel"><p className="ap-empty">{tr('Cuando un agente trabaje en esta conversación, aquí verás qué ha hecho, qué archivos ha cambiado y qué queda pendiente.')}</p></div>;
  }
  return (
    <div className="activity-panel" data-agent={turn.agent}>
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
  const root = useStore(activeRoot);
  const changes = useMemo(() => collectChanges(items), [items]);
  const totals = useMemo(() => changes.reduce((sum, c) => {
    const s = diffStats(changeLines(c));
    return { added: sum.added + s.added, removed: sum.removed + s.removed };
  }, { added: 0, removed: 0 }), [changes]);
  const kinds = useMemo(() => composition(operations), [operations]);
  const extras = [
    summary.reasoning ? (summary.reasoning === 1 ? tr('{n} resumen de razonamiento', { n: 1 }) : tr('{n} resúmenes de razonamiento', { n: summary.reasoning })) : '',
    summary.notes ? (summary.notes === 1 ? tr('{n} nota', { n: 1 }) : tr('{n} notas', { n: summary.notes })) : '',
  ].filter(Boolean);
  const incidents = summary.failed + summary.declined;
  return (
    <>
      <header className="ap-hero" data-status={status}>
        <div className="ap-hero-top">
          <Mascot agent={agent} state={status === 'failed' ? 'error' : status === 'running' ? 'thinking' : 'idle'} size={36} animated={false} />
          <div className="min-w-0 flex-1">
            <div className="ap-title">
              <strong>{AGENT_NAME[agent]}</strong>
              <span className="ap-status" data-status={status} role="status"><i aria-hidden />{turnStatus(status)}</span>
            </div>
            <p className="ap-sub">
              {turn.model}{turn.effort ? ` · ${effortLabel(turn.effort).toLowerCase()}` : ''}{fast ? ' · ' + tr('rápido') : ''}
            </p>
          </div>
          <button type="button" className="btn-icon" aria-label={tr('Ir al turno en la conversación')} data-tip={tr('Ir al turno')}
            onClick={() => goToTurn(turn.id)}><ArrowUpRight size={15} aria-hidden /></button>
        </div>
        <dl className="ap-facts">
          <div><dt>{tr('Inicio')}</dt><dd><time dateTime={new Date(turn.createdAt).toISOString()}>{fmt.dateTime(turn.createdAt, { timeStyle: 'short' })}</time></dd></div>
          <div><dt>{tr('Duración')}</dt><dd>{duration ? fmtDuration(duration) : '—'}</dd></div>
          <div><dt>{tr('Operaciones')}</dt><dd>{summary.operations}</dd></div>
          <div data-tone={incidents ? 'error' : undefined}><dt>{tr('incidencias')}</dt><dd>{incidents}</dd></div>
        </dl>
      </header>

      {!!run?.approvals.length && (
        <div className="ap-callout" data-tone="warn" role="status">
          <ShieldAlert size={15} aria-hidden />
          <span>{tr('{agent} espera tu autorización para continuar.', { agent: AGENT_NAME[agent] })}</span>
          <button type="button" className="notice-link" onClick={() => goToTurn(turn.id)}>Responder</button>
        </div>
      )}
      {status === 'failed' && (
        <div className="ap-callout" data-tone="error" role="status">
          <CircleAlert size={15} aria-hidden />
          <span className="selectable">{turn.error ?? tr('La ejecución terminó con un error.')}</span>
        </div>
      )}

      {(kinds.length > 0 || extras.length > 0) && (
        <section className="ap-section" aria-label={tr('Resumen del turno')}>
          <h3>{tr('Resumen')}</h3>
          {kinds.length > 0 && <>
            <div className="ap-bar" role="img" aria-label={kinds.map((k) => k.label).join(', ')}>
              {kinds.map((k) => <span key={k.kind} data-kind={k.kind} style={{ flexGrow: k.count }} />)}
            </div>
            <ul className="ap-legend">
              {kinds.map((k) => <li key={k.kind} data-kind={k.kind}><i aria-hidden />{k.label}</li>)}
            </ul>
          </>}
          {extras.length > 0 && <p className="ap-note">{extras.join(' · ')}</p>}
        </section>
      )}

      {problems.length > 0 && (
        <section className="ap-section" aria-label={tr('Errores y rechazos')}>
          <h3><CircleAlert size={13} aria-hidden /> {tr('Errores y rechazos')}</h3>
          <div className="ap-list">{problems.map((item) => <TimelineEntry key={item.id} item={item} />)}</div>
        </section>
      )}

      {changes.length > 0 && (
        <section className="ap-section">
          <h3>
            {tr('Archivos cambiados')} <span className="ap-count">{changes.length}</span>
            <span className="ap-h-aside">
              <span className="add">+{totals.added}</span><span className="del">−{totals.removed}</span>
              <DiffBlocks added={totals.added} removed={totals.removed} />
            </span>
          </h3>
          <ChangeRows changes={changes} root={root} onSelect={openDiffTab} />
        </section>
      )}

      {plans.size > 0 && (
        <section className="ap-section">
          <h3><ListChecks size={14} aria-hidden /> {tr('Plan y tareas')}</h3>
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
        <section className="ap-section">
          <h3>{tr('Línea de tiempo')} <span className="ap-count">{operations.length}</span></h3>
          <div className="ap-list ap-timeline">{operations.map((item) => <TimelineEntry key={item.id} item={item} live={status === 'running'} />)}</div>
        </section>
      )}
      {!operations.length && status !== 'running' && <p className="ap-note">{tr('Este turno no registró operaciones: el agente solo respondió.')}</p>}

      <details className="ap-fold ap-details">
        <summary><ChevronRight size={13} aria-hidden /> {tr('Detalles')}</summary>
        {!insights ? <p role="status" className="insight-note">{tr('Cargando información del turno…')}</p>
          : insights.error ? <p role="status" className="insight-note">{insights.error}</p>
          : <ContextDetails data={insights.data} turn={turn} messages={messages} />}
        <button type="button" className="btn ap-stats-link" onClick={() => {
          const store = useStore.getState();
          store.closePanel();
          store.setView('settings', 'statistics');
        }}><ArrowUpRight size={13} aria-hidden /> {tr('Estadísticas de uso')}</button>
      </details>
    </>
  );
}

type Kind = 'command' | 'read' | 'search' | 'edit' | 'web' | 'tool';
const KIND_ORDER: Kind[] = ['command', 'read', 'search', 'edit', 'web', 'tool'];
const kindLabel = (kind: Kind, n: number) => ({
  command: n === 1 ? tr('{n} comando', { n }) : tr('{n} comandos', { n }),
  read: n === 1 ? tr('{n} lectura', { n }) : tr('{n} lecturas', { n }),
  search: n === 1 ? tr('{n} búsqueda', { n }) : tr('{n} búsquedas', { n }),
  edit: n === 1 ? tr('{n} edición', { n }) : tr('{n} ediciones', { n }),
  web: n === 1 ? tr('{n} consulta web', { n }) : tr('{n} consultas web', { n }),
  tool: n === 1 ? tr('{n} herramienta', { n }) : tr('{n} herramientas', { n }),
})[kind];

/** Reparto de las operaciones del turno por tipo, en un orden fijo para que los colores no bailen. */
function composition(operations: TimelineItem[]) {
  const counts = new Map<Kind, number>();
  for (const item of operations) {
    const raw = operationKind(item);
    if (!raw) continue;
    const kind: Kind = raw === 'plan' ? 'tool' : raw;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return KIND_ORDER.filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind)!, label: kindLabel(kind, counts.get(kind)!) }));
}

/** Cinco bloques proporcionales a las líneas añadidas y eliminadas. */
function DiffBlocks({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const green = total ? Math.round((added / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.max(removed ? 1 : 0, Math.round((removed / total) * 5))) : 0;
  return <span className="ap-blocks" aria-hidden>
    {Array.from({ length: 5 }, (_, i) => <i key={i} data-t={i < green ? 'add' : i < green + red ? 'del' : undefined} />)}
  </span>;
}

function PlanBlock({ source, snapshots, live }: { source: string; snapshots: PlanSnapshot[]; live: boolean }) {
  const plan = snapshots.at(-1)!;
  const completed = plan.tasks.filter((t) => t.status === 'completed').length;
  const unfinished = plan.tasks.some((t) => t.status === 'pending' || t.status === 'running' || t.status === 'blocked');
  return (
    <div className="insight-plan">
      <div className="insight-caption"><span>{source}</span><span role="status">{completed} de {plan.tasks.length} completadas</span></div>
      {!live && unfinished && <p className="insight-note">{tr('Último estado del plan comunicado por el agente.')}</p>}
      <PlanRows plan={plan} />
      {snapshots.length > 1 && <details className="insight-disclosure">
        <summary><ChevronRight size={13} aria-hidden /><span>Revisiones anteriores ({snapshots.length - 1})</span></summary>
        <div className="insight-detail">
          {snapshots.slice(0, -1).map((older, i) => <details key={i} className="insight-disclosure">
            <summary><ChevronRight size={13} aria-hidden /><span>{tr('Revisión {n}', { n: i + 1 })}</span></summary>
            <PlanRows plan={older} />
          </details>)}
        </div>
      </details>}
    </div>
  );
}

function StateLabel({ status, worker = false }: { status?: InsightStatus | null; worker?: boolean }) {
  const labels = worker ? { ...statusLabels(), completed: tr('Finalizado'), blocked: tr('Bloqueado'), failed: tr('Fallido'), cancelled: tr('Detenido'), interrupted: tr('Interrumpido'), removed: tr('Eliminado') } : statusLabels();
  return <span className="insight-status" data-status={status ?? undefined}>{status ? labels[status] : tr('Sin estado')}</span>;
}

function PlanRows({ plan }: { plan: PlanSnapshot }) {
  return (
    <>
      {plan.receivedAt != null && <p className="insight-note">{tr('Actualización recibida el')}{' '}
        <time dateTime={new Date(plan.receivedAt).toISOString()}>
          {fmt.dateTime(plan.receivedAt, { dateStyle: 'short', timeStyle: 'medium' })}
        </time>
      </p>}
      {plan.explanation && <p className="insight-note selectable">{plan.explanation}</p>}
      {plan.tasks.length === 0 ? <p className="insight-note">{tr('El proveedor dejó la lista vacía.')}</p> :
        <ol className="insight-list">
          {plan.tasks.map((task, i) => (
            <li key={task.id ?? i}>
              <details className="insight-disclosure">
                <summary>
                  <ChevronRight size={13} aria-hidden />
                  <span>{task.title || (task.id ? tr('Tarea #{id}', { id: task.id }) : tr('Tarea sin nombre'))}</span>
                  <StateLabel status={task.status} />
                </summary>
                <div className="insight-detail selectable">
                  {task.id && <p>ID {task.id}</p>}
                  {task.description && <p>{task.description}</p>}
                  {task.activeForm && <p>{task.activeForm}</p>}
                  {!!task.blockedBy?.length && <p>{tr('Depende de {tasks}', { tasks: task.blockedBy.map((id) => `#${id}`).join(', ') })}</p>}
                  {!!task.blocks?.length && <p>Bloquea {task.blocks.map((id) => `#${id}`).join(', ')}</p>}
                  {!task.id && !task.description && !task.activeForm && !task.blockedBy?.length && !task.blocks?.length &&
                    <p>{tr('El proveedor solo comunicó el nombre y el estado.')}</p>}
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
                  {worker.status === 'running' && !live ? <span className="insight-status">{tr('Sin cierre')}</span>
                    : <StateLabel status={worker.status} worker />}
                </div>
                {worker.description && <p className="insight-note selectable">{worker.description}</p>}
                {worker.result && <p className="insight-note insight-result insight-result-preview selectable">{worker.result}</p>}
                <TechnicalDetails label={tr('Detalles del subagente')}>
                  {worker.progress && <p>{worker.progress}</p>}
                  {worker.result && <p className="insight-result">{worker.result}</p>}
                  <Facts rows={[
                    [tr('Identificador'), worker.id], [tr('Agente'), worker.agentId], [tr('Ejecución del subagente'), worker.runId],
                    [tr('Elemento del proveedor'), worker.itemId],
                    [tr('Identificador del agente padre'), worker.parentId], [tr('Modelo'), worker.model],
                    [tr('Esfuerzo'), worker.effort && effortLabel(worker.effort)], [tr('Herramientas observadas'), worker.tools?.join(', ')],
                    [tr('Última herramienta'), worker.lastTool], [tr('Llamadas de herramienta'), worker.toolCalls],
                    [tr('Tokens comunicados'), worker.totalTokens == null ? null : insightNumber(worker.totalTokens)],
                    [tr('Duración comunicada'), fmtDuration(worker.durationMs)],
                    [tr('Finalización'), worker.endedAt && fmt.dateTime(worker.endedAt)],
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
    <div key={label}><dt>{label}</dt><dd>{value ?? tr('No disponible')}</dd></div>
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
  const continuity = details?.continuity === 'resumed' ? tr('Sesión reanudada') : details?.continuity === 'new' ? tr('Sesión nueva')
    : details?.continuity === 'resumeRequested' ? tr('Reanudación solicitada') : undefined;
  const turnModel = details?.lastRequestModel ?? details?.reroutedTo;
  const requestedModel = details?.requestedModel ?? turn.model;
  return (
    <>
      <section className="insight-section">
        <h3>{tr('Sesión del proveedor')}</h3>
        <Facts rows={[
          [turnModel ? tr('Modelo comunicado en el turno') : details?.sessionModel ? tr('Modelo de la sesión') : tr('Modelo solicitado'),
            turnModel ?? details?.sessionModel ?? requestedModel],
          [tr('Esfuerzo solicitado'), effortLabel(details?.requestedEffort ?? turn.effort) ?? undefined],
          [tr('Continuidad'), continuity], [tr('Ventana informada'), insightNumber(u?.contextWindow)],
          [tr('Entrada de la última solicitud'), insightNumber(details?.lastInputTokens ?? measured?.contextTokens)],
        ]} />
        {details?.reroutedTo && <p className="insight-note">{tr('El proveedor redirigió de {from} a {to}.', { from: details.reroutedFrom, to: details.reroutedTo })}</p>}
        {details?.compacted && <p className="insight-note">{tr('El proveedor comunicó una compactación en este turno.')}</p>}
        <TechnicalDetails label={tr('Detalles de la sesión')}>
          <Facts rows={[
            [tr('Modelo solicitado'), requestedModel], [tr('Resolución anunciada por el catálogo'), details?.catalogResolved],
            [tr('Modelo de la sesión'), details?.sessionModel],
            [tr('Modelo comunicado en el turno'), turnModel], [tr('Máximo de salida informado'), insightNumber(measured?.maxOutputTokens)],
            [tr('Cuenta seleccionada'), details?.accountLabel ?? details?.accountId ?? (details?.accountSource === 'cli' ? tr('Perfil de la CLI') : undefined)],
            [tr('Sesión'), details?.sessionId ?? measured?.sessionId], [tr('Turno del proveedor'), details?.providerTurnId],
          ]} />
        </TechnicalDetails>
      </section>
      <section className="insight-section">
        <h3>{tr('Consumo del turno')}</h3>
        {data?.legacy && <p className="insight-note">{tr('Registro histórico con cobertura anterior a esta versión.')}</p>}
        {(measured?.partial || (measured?.accountingVersion && ['interrupted', 'cancelled', 'failed'].includes(turn.status))) &&
          <p className="insight-note">{tr('Medición parcial del turno.')}</p>}
        <Facts rows={[
          [tr('Entrada total'), insightNumber(u?.inputTokens)],
          [tr('Salida'), insightNumber(u?.outputTokens)], [tr('Total del turno'), insightNumber(measured?.totalTokens)],
        ]} />
        <TechnicalDetails label={tr('Desglose de consumo')}>
          <Facts rows={[
            [tr('Entrada fresca'), insightNumber(measured?.freshInputTokens)], [tr('Lectura de caché'), insightNumber(u?.cachedInputTokens)],
            [tr('Creación de caché'), insightNumber(measured?.cacheWriteInputTokens)],
            [u?.costKind === 'reported' ? tr('Coste reportado') : tr('Coste estimado por la CLI'), insightCost(u?.costUsd)],
            ...(turn.agent === 'codex' ? [[tr('Acumulado del hilo de Codex'), insightNumber(measured?.threadTotal?.totalTokens)] as Fact] : []),
          ]} />
          {turn.agent === 'claude' && <p>{tr('Los tokens del turno corresponden al agente principal. El coste estimado puede incluir delegaciones.')}</p>}
        </TechnicalDetails>
      </section>
      <section className="insight-section">
        <h3>{tr('Historial compartido')}</h3>
        <Facts rows={[
          [tr('Mensajes en Duovra al iniciar'), insightNumber(details?.historyMessages)],
          [tr('Estado del bloque compartido'), note?.mode === 'none' ? tr('Sin historial compartido') : details?.contextSent
            ? tr('Enviado al proveedor') : note ? tr('Preparado por Duovra') : undefined],
        ]} />
        <TechnicalDetails label={tr('Desglose del historial compartido')}>
          <Facts rows={[
            [tr('Mensajes incluidos'), insightNumber(note?.mode === 'none' ? 0 : note?.messages)],
            [tr('Mensajes omitidos del intercambio'), insightNumber(note?.mode === 'none' ? 0 : note?.omitted)],
            [tr('Caracteres del bloque compartido'), insightNumber(note?.mode === 'none' ? 0 : note?.sharedChars)],
            [tr('Respuestas incluidas de'), note?.agents?.length ? note.agents.map((agent) => AGENT_NAME[agent]).join(', ') : undefined],
          ]} />
          <p>{tr('El bloque compartido se mide en caracteres de texto preparado por Duovra. La sesión del proveedor mantiene su propio historial.')}</p>
        </TechnicalDetails>
      </section>
    </>
  );
}

import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AGENT_NAME, fmtDuration, fmtTokens } from '../../lib/format';
import { groupBy, insightCost, insightNumber, totalUsage, type InsightUsageRow, type UsageScope } from '../../lib/insights';
import { api, errorText } from '../../lib/ipc';
import type { AgentId, UsageRow } from '../../lib/types';
import { useStore } from '../../state/store';
import { Segmented } from '../ui/Controls';
import {
  bucketLabel, buildSeries, PERIODS, timelineQuery, totals as sumTotals, usedTokens,
  type Agg, type Bucket, type Grain, type Measure, type Period, type TimelineRow,
} from '../../lib/stats';

const AGENTS: AgentId[] = ['claude', 'codex'];
const PERIOD_DAYS: Record<Period, UsageScope['days'] | 1> = { '24h': 1, '7d': 7, '30d': 30, all: null };
const PERIOD_TEXT: Record<Period, string> = { '24h': 'las últimas 24 horas', '7d': 'los últimos 7 días', '30d': 'los últimos 30 días', all: 'todo el historial' };
const TOKEN_PARTS = [
  { key: 'fresh', label: 'Entrada fresca' },
  { key: 'cacheRead', label: 'Lectura de caché' },
  { key: 'cacheWrite', label: 'Escritura de caché' },
  { key: 'output', label: 'Salida' },
] as const;

/**
 * Estadísticas: un único control de periodo y datos de todos los proyectos de este equipo. Los
 * gráficos solo muestran lo registrado; cada cifra indica cuántos turnos la comunicaron y el coste
 * distingue siempre lo comunicado por el proveedor, lo estimado y lo no disponible.
 */
export function UsageDashboard() {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    // Ajustes es un <dialog>: este efecto corre antes de que el marco llame a showModal(), y dentro de
    // un diálogo cerrado focus() no surte efecto. Al abrir Ajustes directamente en Estadísticas
    // (p. ej. desde Workbench) el foco va al encabezado cuando el diálogo ya está abierto. Si el
    // diálogo ya estaba abierto, se llega desde las pestañas y el foco se queda en la pestaña.
    const dialog = heading.current?.closest('dialog');
    if (dialog?.open) return;
    queueMicrotask(() => heading.current?.focus({ preventScroll: true }));
  }, []);
  const activeCount = useStore((s) => Object.keys(s.runs).length);
  const [period, setPeriod] = useState<Period>('7d');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ period: Period; now: number; rows: TimelineRow[]; models: InsightUsageRow[]; error?: string }>();
  useEffect(() => {
    let active = true;
    const now = Date.now();
    void Promise.all([
      api.insightsTimeline(timelineQuery(period, now)),
      api.insightsUsage({ days: PERIOD_DAYS[period] as UsageScope['days'], projectId: null, conversationId: null }),
    ]).then(
      ([rows, models]) => { if (active) setResult({ period, now, rows, models }); },
      (error) => { if (active) setResult({ period, now, rows: [], models: [], error: errorText(error) }); },
    );
    return () => { active = false; };
  }, [period, revision, activeCount]);
  const current = result?.period === period ? result : undefined;
  const series = useMemo(() => current ? buildSeries(current.rows, period, current.now) : null, [current, period]);
  const sums = useMemo(() => series ? sumTotals(series.buckets) : null, [series]);

  return (
    <>
      <header className="settings-section-head">
        <span className="settings-section-icon" aria-hidden><Activity size={20} /></span>
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1}>Estadísticas</h2>
          <p>Actividad y consumo de todos los proyectos registrados en Duovra en este equipo.</p>
        </div>
      </header>
      <div className="stats-toolbar">
        <Segmented id="stats-period" value={period} onChange={(value) => setPeriod(value as Period)}
          options={PERIODS.map((p) => ({ value: p.id, label: p.label }))} />
        <button type="button" className="btn-icon" aria-label="Actualizar estadísticas" data-tip="Actualizar"
          onClick={() => setRevision((n) => n + 1)}><RefreshCw size={15} aria-hidden /></button>
      </div>
      {!current || !series || !sums ? <p className="insight-note" role="status">Cargando estadísticas…</p>
        : current.error ? <p className="insight-note" role="status">{current.error}</p>
        : <StatsBody period={period} buckets={series.buckets} grain={series.grain} sums={sums} models={current.models} />}
      <LegacyUsage />
    </>
  );
}

function StatsBody({ period, buckets, grain, sums, models }: {
  period: Period; buckets: Bucket[]; grain: Grain; sums: Record<AgentId | 'all', Agg>; models: InsightUsageRow[];
}) {
  const all = sums.all;
  const tokens = usedTokens(all);
  const cost = all.reported.count ? { value: insightCost(all.reported.value), note: 'comunicado por el proveedor' }
    : all.estimated.count ? { value: '≈ ' + insightCost(all.estimated.value), note: 'estimado por la CLI' } : null;
  if (!all.runs) {
    return <div className="stats-empty" role="status">
      <strong>Sin actividad en {PERIOD_TEXT[period]}</strong>
      <p>Las ejecuciones de Claude Code y Codex aparecerán aquí en cuanto terminen.</p>
    </div>;
  }
  return <>
    <section className="stats-tiles" aria-label="Resumen del periodo">
      <Tile label="Turnos realizados" value={insightNumber(all.runs)}
        note={`${all.completed} completados${all.failed ? ` · ${all.failed} fallidos` : ''}`} />
      <Tile label="Tiempo de ejecución" value={all.duration.count ? fmtDuration(all.duration.value) : '—'} note={coverage(all.duration, all.runs)} />
      <Tile label="Tokens utilizados" value={tokens.count ? fmtTokens(tokens.value) : '—'} note={coverage(tokens, all.runs)} />
      <Tile label="Coste" value={cost?.value ?? '—'} note={cost?.note ?? 'Sin dato de coste'} />
    </section>

    <section className="stats-card" aria-labelledby="stats-activity">
      <div className="stats-card-head">
        <h3 id="stats-activity">Actividad</h3>
        <Legend items={AGENTS.map((agent) => ({ key: agent, label: AGENT_NAME[agent] }))} />
      </div>
      <ActivityChart buckets={buckets} grain={grain} />
    </section>

    <div className="stats-grid">
      <section className="stats-card" aria-labelledby="stats-agents">
        <div className="stats-card-head"><h3 id="stats-agents">Claude Code y Codex</h3></div>
        <AgentComparison sums={sums} />
      </section>
      <section className="stats-card" aria-labelledby="stats-tokens">
        <div className="stats-card-head"><h3 id="stats-tokens">Tokens</h3></div>
        <TokenBars sums={sums} />
      </section>
    </div>

    <section className="stats-card" aria-labelledby="stats-cost">
      <div className="stats-card-head"><h3 id="stats-cost">Costes</h3></div>
      <div className="stats-costs">
        <CostTile label="Comunicado por el proveedor" value={all.reported.count ? insightCost(all.reported.value) : '—'} runs={all.reported.count} />
        <CostTile label="Estimado por la CLI" value={all.estimated.count ? '≈ ' + insightCost(all.estimated.value) : '—'} runs={all.estimated.count} />
        <CostTile label="Sin dato de coste" value={insightNumber(Math.max(0, all.runs - Math.max(all.reported.count, all.estimated.count)))} runs={null} />
      </div>
      <p className="insight-note">Una estimación no es un cargo real: con suscripción, el coste que calcula la CLI a precios de API no se factura.</p>
    </section>

    <ModelBreakdown rows={models} />
  </>;
}

function coverage(measure: Measure, runs: number) {
  return measure.count === runs ? `En los ${runs} turnos` : `${measure.count} de ${runs} turnos con dato`;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="stats-tile"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function CostTile({ label, value, runs }: { label: string; value: string; runs: number | null }) {
  return <div className="stats-cost"><span>{label}</span><strong>{value}</strong>
    {runs !== null && <small>{runs ? `${runs} ${runs === 1 ? 'turno' : 'turnos'}` : 'Ningún turno'}</small>}</div>;
}

function Legend({ items }: { items: { key: string; label: string }[] }) {
  return <ul className="stats-legend">{items.map((item) => <li key={item.key}><span className="stats-swatch" data-series={item.key} aria-hidden />{item.label}</li>)}</ul>;
}

/** Columnas apiladas por agente; cada intervalo existe aunque esté vacío. Hover y tabla accesible. */
function ActivityChart({ buckets, grain }: { buckets: Bucket[]; grain: Grain }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.agents.claude.runs + b.agents.codex.runs));
  const top = niceMax(max);
  const every = Math.max(1, Math.ceil(buckets.length / (grain === 'hour' ? 8 : 10)));
  const active = hover === null ? null : buckets[hover];
  return <>
    <div className="stats-chart" onPointerLeave={() => setHover(null)}>
      <div className="stats-axis" aria-hidden>
        {[top, top / 2, 0].map((tick) => <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>{insightNumber(tick)}</span>)}
      </div>
      <div className="stats-plot" role="img" aria-label={`Turnos por ${grain === 'hour' ? 'hora' : grain === 'day' ? 'día' : grain === 'week' ? 'semana' : 'mes'}`}>
        {[1, 0.5].map((tick) => <span key={tick} className="stats-grid-line" style={{ bottom: `calc(20px + (100% - 20px) * ${tick})` }} aria-hidden />)}
        {buckets.map((bucket, i) => {
          const { claude, codex } = bucket.agents;
          return <div key={bucket.start} className="stats-col" data-hover={hover === i || undefined} onPointerEnter={() => setHover(i)}>
            <div className="stats-stack" style={{ height: `${((claude.runs + codex.runs) / top) * 100}%` }}>
              {codex.runs > 0 && <span data-series="codex" style={{ flexGrow: codex.runs }} />}
              {claude.runs > 0 && <span data-series="claude" style={{ flexGrow: claude.runs }} />}
            </div>
            <span className="stats-x" aria-hidden>{i % every === 0 ? shortLabel(bucket.start, grain) : ''}</span>
          </div>;
        })}
      </div>
      {active && hover !== null && (
        <div className="stats-tip surface-popup" role="status" style={{ left: `calc(${((hover + 0.5) / buckets.length) * 100}% )` }}>
          <strong>{bucketLabel(active.start, grain)}</strong>
          {AGENTS.map((agent) => <span key={agent}><i className="stats-swatch" data-series={agent} aria-hidden />{AGENT_NAME[agent]} · {active.agents[agent].runs} turnos</span>)}
          {(active.agents.claude.duration.count + active.agents.codex.duration.count) > 0 &&
            <span className="faint">{fmtDuration(active.agents.claude.duration.value + active.agents.codex.duration.value)} de ejecución</span>}
        </div>
      )}
    </div>
    <details className="stats-table-toggle">
      <summary>Ver como tabla</summary>
      <div className="table-scroll usage-scroll" tabIndex={0} role="region" aria-label="Actividad por intervalo">
        <table className="usage-table">
          <thead><tr><th scope="col">Intervalo</th><th scope="col">Claude Code</th><th scope="col">Codex</th><th scope="col">Tiempo</th></tr></thead>
          <tbody>{buckets.filter((b) => b.agents.claude.runs + b.agents.codex.runs > 0).map((b) => <tr key={b.start}>
            <th scope="row">{bucketLabel(b.start, grain)}</th><td>{b.agents.claude.runs}</td><td>{b.agents.codex.runs}</td>
            <td>{fmtDuration(b.agents.claude.duration.value + b.agents.codex.duration.value) || '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </>;
}

function shortLabel(start: number, grain: Grain) {
  const d = new Date(start);
  if (grain === 'hour') return d.toLocaleTimeString('es', { hour: '2-digit' }) + ' h';
  if (grain === 'month') return d.toLocaleDateString('es', { month: 'short' });
  return d.toLocaleDateString('es', { day: 'numeric', month: grain === 'week' ? 'short' : undefined });
}

function niceMax(value: number) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value / 1) ?? 10;
  return Math.ceil(value / (step * power / 2)) * (step * power / 2);
}

/** Comparación directa: turnos, tiempo y tokens de cada agente, a la misma escala por fila. */
function AgentComparison({ sums }: { sums: Record<AgentId | 'all', Agg> }) {
  const rows: { label: string; values: Record<AgentId, number>; format: (n: number) => string }[] = [
    { label: 'Turnos', values: { claude: sums.claude.runs, codex: sums.codex.runs }, format: insightNumber },
    { label: 'Tiempo', values: { claude: sums.claude.duration.value, codex: sums.codex.duration.value }, format: (n) => n ? fmtDuration(n) : '—' },
    { label: 'Tokens', values: { claude: usedTokens(sums.claude).value, codex: usedTokens(sums.codex).value }, format: (n) => n ? fmtTokens(n) : '—' },
  ];
  return <div className="stats-compare">
    {rows.map((row) => {
      const max = Math.max(1, row.values.claude, row.values.codex);
      return <div key={row.label} className="stats-compare-row">
        <span className="stats-compare-label">{row.label}</span>
        {AGENTS.map((agent) => <div key={agent} className="stats-hbar" title={`${AGENT_NAME[agent]} · ${row.format(row.values[agent])}`}>
          <span className="stats-hbar-name">{AGENT_NAME[agent]}</span>
          <span className="stats-hbar-track"><span data-series={agent} style={{ width: `${(row.values[agent] / max) * 100}%` }} /></span>
          <span className="stats-hbar-value">{row.format(row.values[agent])}</span>
        </div>)}
      </div>;
    })}
  </div>;
}

/** Desglose de tokens por agente: cuatro partidas con leyenda y cifras; la entrada no se duplica. */
function TokenBars({ sums }: { sums: Record<AgentId | 'all', Agg> }) {
  const partsTotal = (agg: Agg) => TOKEN_PARTS.reduce((sum, part) => sum + agg[part.key].value, 0);
  const max = Math.max(1, ...AGENTS.map((agent) => partsTotal(sums[agent])));
  const any = TOKEN_PARTS.some((part) => sums.all[part.key].count > 0);
  if (!any) return <p className="insight-note">Los proveedores no comunicaron tokens en este periodo.</p>;
  return <div className="stats-tokens">
    {AGENTS.map((agent) => {
      const agg = sums[agent];
      const total = partsTotal(agg);
      return <div key={agent} className="stats-token-row">
        <span className="stats-hbar-name">{AGENT_NAME[agent]}</span>
        <span className="stats-token-track" style={{ width: `${Math.max(total ? 2 : 0, (total / max) * 100)}%` }}>
          {TOKEN_PARTS.map((part) => agg[part.key].value > 0 &&
            <span key={part.key} data-series={part.key} style={{ flexGrow: agg[part.key].value }} title={`${part.label} · ${insightNumber(agg[part.key].value)}`} />)}
        </span>
        <span className="stats-hbar-value">{total ? fmtTokens(total) : '—'}</span>
      </div>;
    })}
    <ul className="stats-token-legend">
      {TOKEN_PARTS.map((part) => {
        const measure = sums.all[part.key];
        return <li key={part.key}><span className="stats-swatch" data-series={part.key} aria-hidden />
          <span>{part.label}</span><strong>{measure.count ? fmtTokens(measure.value) : '—'}</strong></li>;
      })}
    </ul>
    <p className="insight-note">La entrada fresca, la lectura y la escritura de caché forman la entrada total; Claude Code informa los tokens del agente principal.</p>
  </div>;
}

/** Modelos del periodo, por número de turnos (información secundaria). */
function ModelBreakdown({ rows }: { rows: InsightUsageRow[] }) {
  const entries = useMemo(() => [...groupBy(rows, (row) => JSON.stringify([row.agent, row.model]))]
    .map(([id, items]) => ({ id, row: items[0], stats: totalUsage(items) })).sort((a, b) => b.stats.runs - a.stats.runs), [rows]);
  if (!entries.length) return null;
  const max = Math.max(1, ...entries.map((e) => e.stats.runs));
  return <details className="stats-card stats-models">
    <summary>Modelos utilizados <span className="ap-count">{entries.length}</span></summary>
    <ul>
      {entries.map(({ id, row, stats }) => <li key={id} className="stats-hbar">
        <span className="stats-hbar-name"><span className="stats-swatch" data-series={row.agent} aria-hidden />{row.model ?? 'Modelo desconocido'}</span>
        <span className="stats-hbar-track"><span data-series={row.agent} style={{ width: `${(stats.runs / max) * 100}%` }} /></span>
        <span className="stats-hbar-value">{stats.runs} {stats.runs === 1 ? 'turno' : 'turnos'}</span>
      </li>)}
    </ul>
    <ConversationLinks rows={rows} />
  </details>;
}

function ConversationLinks({ rows }: { rows: InsightUsageRow[] }) {
  const top = useMemo(() => [...groupBy(rows, (row) => row.conversationId)]
    .map(([id, items]) => ({ id, row: items[0], runs: items.reduce((s, r) => s + r.runs, 0) }))
    .sort((a, b) => b.runs - a.runs).slice(0, 5), [rows]);
  return <div className="stats-conversations">
    <h4>Conversaciones con más turnos</h4>
    {top.map(({ id, row, runs }) => <button key={id} type="button" className="usage-chat-link" onClick={() => {
      const store = useStore.getState();
      store.closePanel();
      void store.selectConversation(id, true);
    }}><span>{row.conversation}<small>{row.project} · {runs} {runs === 1 ? 'turno' : 'turnos'}</small></span><ArrowUpRight size={13} aria-hidden /></button>)}
  </div>;
}

function LegacyUsage() {
  const [rows, setRows] = useState<UsageRow[]>();
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    void api.usageSummary(0).then((r) => { if (active) setRows(r.rows); },
      (e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [opened]);
  return <details className="usage-legacy" onToggle={(event) => setOpened(event.currentTarget.open)}>
    <summary>Registro anterior</summary>
    <p className="insight-note">Totales históricos guardados por agente y modelo. Se conservan con la cobertura original, fuera de las sumas anteriores.</p>
    {error ? <p className="insight-note" role="status">{error}</p> : !rows ? <p className="insight-note" role="status">Cargando registro…</p>
      : !rows.length ? <p className="insight-note">El registro anterior está vacío.</p> :
        <div className="table-scroll usage-scroll" tabIndex={0} role="region" aria-label="Tabla del registro anterior">
          <table className="usage-table">
            <caption className="sr-only">Registro anterior</caption>
            <thead><tr><th scope="col">Proveedor y modelo</th><th scope="col">Registros</th><th scope="col">Entrada</th>
              <th scope="col">Lectura de caché</th><th scope="col">Salida</th><th scope="col">Coste est.</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={JSON.stringify([row.agent, row.model])}>
              <th scope="row">{AGENT_NAME[row.agent]}<small>{row.model}</small></th>
              <td>{insightNumber(row.runs)}</td><td>{insightNumber(row.inputTokens)}</td><td>{insightNumber(row.cachedInputTokens)}</td>
              <td>{insightNumber(row.outputTokens)}</td><td>{insightCost(row.costUsd)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
  </details>;
}

/**
 * Estadísticas: periodo, serie temporal e intervalos vacíos.
 *
 * Los datos vienen de `insights_timeline` (por intervalo y agente). Aquí solo se agrupan y se
 * rellenan los intervalos sin actividad con ceros: nunca se inventan valores. Cada medida guarda
 * cuántos turnos la registraron, para distinguir «0» de «sin dato».
 */
import type { AgentId } from './types';

export type Period = '24h' | '7d' | '30d' | 'all';
export const PERIODS: { id: Period; label: string }[] = [
  { id: '24h', label: '24 horas' },
  { id: '7d', label: '7 días' },
  { id: '30d', label: 'Último mes' },
  { id: 'all', label: 'Todo el historial' },
];

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface TimelineRow {
  bucket: number;
  agent: AgentId;
  runs: number;
  completed: number;
  failed: number;
  durationMs: number | null; durationCount: number;
  inputTokens: number | null; inputCount: number;
  freshInputTokens: number | null; freshCount: number;
  cachedInputTokens: number | null; cacheReadCount: number;
  cacheWriteInputTokens: number | null; cacheWriteCount: number;
  outputTokens: number | null; outputCount: number;
  reportedUsd: number | null; reportedCount: number;
  estimatedUsd: number | null; estimatedCount: number;
}

export interface Measure { value: number; count: number }
export interface Agg {
  runs: number;
  completed: number;
  failed: number;
  duration: Measure;
  input: Measure;
  fresh: Measure;
  cacheRead: Measure;
  cacheWrite: Measure;
  output: Measure;
  reported: Measure;
  estimated: Measure;
}

export const emptyAgg = (): Agg => ({
  runs: 0, completed: 0, failed: 0,
  duration: { value: 0, count: 0 }, input: { value: 0, count: 0 }, fresh: { value: 0, count: 0 },
  cacheRead: { value: 0, count: 0 }, cacheWrite: { value: 0, count: 0 }, output: { value: 0, count: 0 },
  reported: { value: 0, count: 0 }, estimated: { value: 0, count: 0 },
});

const add = (m: Measure, value: number | null, count: number) => {
  if (value != null) m.value += value;
  m.count += count;
};

export function addRow(agg: Agg, row: TimelineRow) {
  agg.runs += row.runs;
  agg.completed += row.completed;
  agg.failed += row.failed;
  add(agg.duration, row.durationMs, row.durationCount);
  add(agg.input, row.inputTokens, row.inputCount);
  add(agg.fresh, row.freshInputTokens, row.freshCount);
  add(agg.cacheRead, row.cachedInputTokens, row.cacheReadCount);
  add(agg.cacheWrite, row.cacheWriteInputTokens, row.cacheWriteCount);
  add(agg.output, row.outputTokens, row.outputCount);
  add(agg.reported, row.reportedUsd, row.reportedCount);
  add(agg.estimated, row.estimatedUsd, row.estimatedCount);
}

export function mergeAgg(into: Agg, from: Agg) {
  into.runs += from.runs;
  into.completed += from.completed;
  into.failed += from.failed;
  for (const key of ['duration', 'input', 'fresh', 'cacheRead', 'cacheWrite', 'output', 'reported', 'estimated'] as const) {
    into[key].value += from[key].value;
    into[key].count += from[key].count;
  }
}

/** Desplazamiento de la hora local respecto a UTC (ms), para alinear días y horas locales. */
export const localOffset = (at: number) => -new Date(at).getTimezoneOffset() * 60_000;

const floorTo = (t: number, size: number, offset: number) => Math.floor((t + offset) / size) * size - offset;

/** Consulta para el backend: intervalos de una hora en 24 h y de un día en el resto. */
export function timelineQuery(period: Period, now: number) {
  const offset = localOffset(now);
  if (period === '24h') return { since: floorTo(now, HOUR, offset) - 23 * HOUR, bucketMs: HOUR, offsetMs: offset };
  const today = floorTo(now, DAY, offset);
  const since = period === '7d' ? today - 6 * DAY : period === '30d' ? today - 29 * DAY : 0;
  return { since, bucketMs: DAY, offsetMs: offset };
}

export type Grain = 'hour' | 'day' | 'week' | 'month';

export interface Bucket {
  start: number;
  agents: Record<AgentId, Agg>;
}

function monthStart(t: number) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function weekStart(t: number) {
  const d = new Date(t);
  const monday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - monday).getTime();
}

/** Grano del historial completo según su duración: días, semanas o meses. */
export function grainFor(period: Period, first: number | null, now: number): Grain {
  if (period === '24h') return 'hour';
  if (period !== 'all' || first == null) return 'day';
  const span = (now - first) / DAY;
  return span <= 45 ? 'day' : span <= 400 ? 'week' : 'month';
}

function step(start: number, grain: Grain): number {
  const d = new Date(start);
  if (grain === 'hour') return start + HOUR;
  if (grain === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  if (grain === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

function align(t: number, grain: Grain): number {
  if (grain === 'hour') return floorTo(t, HOUR, localOffset(t));
  if (grain === 'week') return weekStart(t);
  if (grain === 'month') return monthStart(t);
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Serie continua del periodo: cada intervalo existe aunque no haya actividad (ceros). Los datos
 * diarios del historial completo se agrupan por semana o mes cuando el historial es largo.
 */
export function buildSeries(rows: TimelineRow[], period: Period, now: number): { grain: Grain; buckets: Bucket[] } {
  const first = rows.length ? Math.min(...rows.map((r) => r.bucket)) : null;
  const grain = grainFor(period, first, now);
  const query = timelineQuery(period, now);
  const startAt = period === 'all' ? (first == null ? align(now, grain) : align(first, grain)) : align(query.since, grain);
  const end = align(now, grain);
  const buckets: Bucket[] = [];
  const index = new Map<number, Bucket>();
  for (let t = startAt; t <= end && buckets.length < 2000; t = step(t, grain)) {
    const bucket = { start: t, agents: { claude: emptyAgg(), codex: emptyAgg() } };
    buckets.push(bucket);
    index.set(t, bucket);
  }
  for (const row of rows) {
    // Los días del backend usan el desplazamiento actual: un cambio de horario los adelanta como mucho una hora.
    const bucket = index.get(align(grain === 'hour' ? row.bucket : row.bucket + 2 * HOUR, grain));
    if (bucket && (row.agent === 'claude' || row.agent === 'codex')) addRow(bucket.agents[row.agent], row);
  }
  return { grain, buckets };
}

export function totals(buckets: Bucket[]): Record<AgentId | 'all', Agg> {
  const out = { claude: emptyAgg(), codex: emptyAgg(), all: emptyAgg() };
  for (const bucket of buckets) {
    for (const agent of ['claude', 'codex'] as const) {
      mergeAgg(out[agent], bucket.agents[agent]);
      mergeAgg(out.all, bucket.agents[agent]);
    }
  }
  return out;
}

const DATE: Record<Grain, Intl.DateTimeFormatOptions> = {
  hour: { hour: '2-digit', minute: '2-digit' },
  day: { day: 'numeric', month: 'short' },
  week: { day: 'numeric', month: 'short' },
  month: { month: 'short', year: '2-digit' },
};

export function bucketLabel(start: number, grain: Grain): string {
  const text = new Date(start).toLocaleString('es', DATE[grain]);
  return grain === 'week' ? `Semana del ${text}` : text;
}

/** Tokens utilizados: entrada total (incluye caché) más salida. No se suman las partidas de entrada. */
export function usedTokens(agg: Agg): Measure {
  return { value: agg.input.value + agg.output.value, count: Math.max(agg.input.count, agg.output.count) };
}

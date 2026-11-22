import type { AgentId, Usage } from './types';

export type InsightStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted' | 'removed';

export interface InsightTask {
  id?: string;
  title?: string;
  status?: InsightStatus | null;
  description?: string | null;
  activeForm?: string | null;
  blockedBy?: string[];
  blocks?: string[];
}

export interface PlanSnapshot {
  source: string;
  explanation?: string | null;
  receivedAt?: number;
  tasks: InsightTask[];
}

export interface SubagentInsight {
  id: string;
  role?: string;
  runId?: string;
  agentId?: string;
  itemId?: string;
  description?: string;
  model?: string;
  effort?: string;
  status?: InsightStatus;
  parentId?: string;
  progress?: string;
  result?: string;
  lastTool?: string;
  tools?: string[];
  durationMs?: number;
  totalTokens?: number;
  toolCalls?: number;
  endedAt?: number;
}

export interface RunInsights {
  legacy: boolean;
  details: {
    userMessageId?: string;
    historyMessages?: number;
    accountId?: string;
    accountLabel?: string;
    accountSource?: 'profile' | 'cli';
    requestedModel?: string;
    requestedEffort?: string;
    requestedSpeed?: string | null;
    sessionId?: string;
    providerTurnId?: string;
    sessionModel?: string;
    lastRequestModel?: string;
    reroutedFrom?: string;
    reroutedTo?: string;
    lastInputTokens?: number;
    continuity?: 'new' | 'resumed' | 'resumeRequested';
    contextSent?: boolean;
    compacted?: boolean;
    plans?: PlanSnapshot[];
    subagents?: Record<string, SubagentInsight>;
  };
  metrics: Usage & {
    accountingVersion?: number;
    freshInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
    totalTokens?: number | null;
    sessionId?: string | null;
    sessionCostUsd?: number | null;
    maxOutputTokens?: number | null;
    threadTotal?: { totalTokens?: number };
    partial?: boolean;
  };
}

export interface UsageScope {
  conversationId: string | null;
  projectId: string | null;
  days: 1 | 7 | 30 | null;
}

export interface InsightUsageRow {
  agent: AgentId;
  model: string | null;
  projectId: string;
  project: string;
  conversationId: string;
  conversation: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  running: number;
  legacy: number;
  partial: number;
  durationMs: number | null;
  durationCount: number;
  inputTokens: number | null;
  inputCount: number;
  freshInputTokens: number | null;
  freshCount: number;
  cachedInputTokens: number | null;
  cacheReadCount: number;
  cacheWriteInputTokens: number | null;
  cacheWriteCount: number;
  outputTokens: number | null;
  outputCount: number;
  reportedUsd: number | null;
  reportedCount: number;
  estimatedUsd: number | null;
  estimatedCount: number;
}

const counts = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });
const dollars = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const insightNumber = (n: number | null | undefined) => n == null ? 'No disponible' : counts.format(n);
export const insightCost = (n: number | null | undefined) => n == null ? 'No disponible' : `${dollars.format(n)} USD`;

export function groupBy<T>(rows: T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export const usageMeasures = [
  ['durationMs', 'durationCount', 'Tiempo de ejecución'],
  ['inputTokens', 'inputCount', 'Entrada total'],
  ['freshInputTokens', 'freshCount', 'Entrada fresca'],
  ['cachedInputTokens', 'cacheReadCount', 'Lectura de caché'],
  ['cacheWriteInputTokens', 'cacheWriteCount', 'Creación de caché'],
  ['outputTokens', 'outputCount', 'Salida'],
  ['reportedUsd', 'reportedCount', 'Coste reportado'],
  ['estimatedUsd', 'estimatedCount', 'Coste estimado por la CLI'],
] as const;

export type Measure = typeof usageMeasures[number][0];
const countsToSum = ['runs', 'completed', 'failed', 'cancelled', 'interrupted', 'running', 'legacy', 'partial'] as const;
export type UsageTotals = Record<typeof countsToSum[number], number> & Record<Measure, { value: number | null; count: number }>;

export function totalUsage(rows: InsightUsageRow[]): UsageTotals {
  const measures = Object.fromEntries(usageMeasures.map(([key]) => [key, { value: null, count: 0 }])) as Pick<UsageTotals, Measure>;
  const totals: UsageTotals = {
    runs: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, running: 0, legacy: 0, partial: 0,
    ...measures,
  };
  for (const row of rows) {
    for (const key of countsToSum) totals[key] += row[key];
    for (const [key, coverage] of usageMeasures) {
      totals[key].count += row[coverage];
      if (row[key] != null) totals[key].value = (totals[key].value ?? 0) + row[key];
    }
  }
  return totals;
}

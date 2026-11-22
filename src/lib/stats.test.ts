import { describe, expect, it } from 'vitest';
import { buildSeries, timelineQuery, totals, usedTokens, type TimelineRow } from './stats';

const row = (bucket: number, agent: 'claude' | 'codex', patch: Partial<TimelineRow> = {}): TimelineRow => ({
  bucket, agent, runs: 1, completed: 1, failed: 0,
  durationMs: 1000, durationCount: 1, inputTokens: 100, inputCount: 1, freshInputTokens: 40, freshCount: 1,
  cachedInputTokens: 60, cacheReadCount: 1, cacheWriteInputTokens: null, cacheWriteCount: 0,
  outputTokens: 10, outputCount: 1, reportedUsd: null, reportedCount: 0, estimatedUsd: 0.01, estimatedCount: 1, ...patch,
});

describe('estadísticas', () => {
  const now = new Date(2026, 10, 20, 15, 30).getTime();

  it('rellena con ceros los días sin actividad de los últimos 7 días', () => {
    const { since } = timelineQuery('7d', now);
    const series = buildSeries([row(since, 'claude'), row(since + 3 * 86_400_000, 'codex')], '7d', now);
    expect(series.grain).toBe('day');
    expect(series.buckets).toHaveLength(7);
    expect(series.buckets.map((b) => b.agents.claude.runs + b.agents.codex.runs)).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });

  it('usa horas en 24 horas y semanas en un historial largo', () => {
    expect(buildSeries([], '24h', now).buckets).toHaveLength(24);
    const old = now - 200 * 86_400_000;
    const all = buildSeries([row(old, 'claude'), row(now, 'codex')], 'all', now);
    expect(all.grain).toBe('week');
    expect(totals(all.buckets).all.runs).toBe(2);
  });

  it('no duplica tokens: entrada total más salida, y distingue medidas sin dato', () => {
    const t = totals(buildSeries([row(now, 'claude'), row(now, 'codex', { inputTokens: null, inputCount: 0 })], '24h', now).buckets);
    expect(usedTokens(t.all)).toEqual({ value: 120, count: 2 });
    expect(t.all.cacheWrite).toEqual({ value: 0, count: 0 });
    expect(t.all.estimated.count).toBe(2);
    expect(t.all.reported.count).toBe(0);
  });
});

import { expect, it } from 'vitest';
import { insightNumber, totalUsage, type InsightUsageRow } from './insights';

const row: InsightUsageRow = {
  agent: 'codex', model: 'gpt-6-luna', projectId: 'p', project: 'QA',
  conversationId: 'c', conversation: 'Pruebas', runs: 2, completed: 1,
  failed: 0, cancelled: 1, interrupted: 0, running: 0, legacy: 0, partial: 1,
  durationMs: 500, durationCount: 2, inputTokens: 1000, inputCount: 2,
  freshInputTokens: 500, freshCount: 2, cachedInputTokens: 500, cacheReadCount: 2,
  cacheWriteInputTokens: 0, cacheWriteCount: 2, outputTokens: 200, outputCount: 2,
  reportedUsd: null, reportedCount: 0, estimatedUsd: null, estimatedCount: 0,
};

it('conserva la distinción entre cero informado, coste estimado y ausencia de métricas', () => {
  const totals = totalUsage([row, {
    ...row, agent: 'claude', conversationId: 'previous', runs: 1, cancelled: 0,
    inputTokens: null, inputCount: 0,
    cacheWriteInputTokens: null, cacheWriteCount: 0,
    estimatedUsd: 0.0123, estimatedCount: 1,
  }]);
  expect(totals.runs).toBe(3);
  expect(totals.cancelled).toBe(1);
  expect(totals.inputTokens).toEqual({ value: 1000, count: 2 });
  expect(totals.cacheWriteInputTokens).toEqual({ value: 0, count: 2 });
  expect(totals.reportedUsd).toEqual({ value: null, count: 0 });
  expect(totals.estimatedUsd).toEqual({ value: 0.0123, count: 1 });
  expect(insightNumber(totals.cacheWriteInputTokens.value)).toBe('0');
  expect(insightNumber(totals.reportedUsd.value)).toBe('No disponible');
});

it('devuelve cobertura vacía cuando el filtro no tiene ejecuciones', () => {
  expect(totalUsage([]).runs).toBe(0);
  expect(totalUsage([]).inputTokens).toEqual({ value: null, count: 0 });
});

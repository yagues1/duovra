import { describe, expect, it } from 'vitest';
import { centerRows, isActive, taskProgress, workerOutcome } from './activityCenter';
import type { RunView } from './types';

const run = (conversationId: string, patch: Partial<RunView> = {}): RunView => ({
  runId: `r-${conversationId}`, conversationId, messageId: `m-${conversationId}`, agent: 'codex', model: 'gpt-6-luna',
  items: [], usage: null, approvals: [], startedAt: 1, ...patch,
});

describe('Activity Center', () => {
  it('ordena lo que espera al usuario primero y distingue cada estado', () => {
    const rows = centerRows(
      {
        a: run('a'),
        b: run('b', { approvals: [{ approvalId: 'x', info: {} as never }] }),
        c: run('c', { stopping: true, agent: 'claude', resolvedModel: 'claude-haiku-5-5' }),
      },
      { d: 1 },
      [{ conversationId: 'e', pending: 2, pauseReason: 'cancelled' }, { conversationId: 'a', pending: 1, pauseReason: null }],
      [{ conversationId: 'f', messageId: 'mf', agent: 'claude', model: 'm', status: 'failed', endedAt: 5 },
        { conversationId: 'a', messageId: 'old', agent: 'codex', model: 'm', status: 'done', endedAt: 4 }],
    );
    expect(rows.map((r) => [r.conversationId, r.status])).toEqual([
      ['b', 'approval'], ['d', 'answer'], ['c', 'stopping'], ['a', 'working'], ['e', 'queued'], ['f', 'error'],
    ]);
    expect(rows.find((r) => r.conversationId === 'c')!.model).toBe('claude-haiku-5-5');
    expect(rows.find((r) => r.conversationId === 'a')!.queued).toBe(1);
    expect(rows.find((r) => r.conversationId === 'e')!.queuePaused).toBe(true);
    expect(rows.filter((r) => isActive(r.status)).length).toBe(4);
  });

  it('solo calcula progreso con una lista completa comunicada', () => {
    expect(taskProgress(undefined)).toBeNull();
    // TaskCreate/TaskUpdate no comunican el total: actividad indeterminada.
    expect(taskProgress([{ source: 'Claude Code · Task tools', tasks: [{ title: 'A', status: 'completed' }] }])).toBeNull();
    const p = taskProgress([
      { source: 'Codex · turn/plan/updated', tasks: [{ title: 'A', status: 'pending' }] },
      { source: 'Claude Code · TodoWrite', tasks: [
        { title: 'A', status: 'completed' }, { title: 'B', status: 'running', activeForm: 'Haciendo B' },
        { title: 'C', status: 'pending' }, { title: 'D', status: 'removed' },
      ] },
    ]);
    expect(p).toEqual({ done: 1, total: 3, running: 'Haciendo B', source: 'Claude Code · TodoWrite' });
    expect(taskProgress([{ source: 'Codex · turn/plan/updated', tasks: [] }])).toBeNull();
  });

  it('no da por terminado un subagente sin cierre comunicado', () => {
    expect(workerOutcome('running', true)).toBe('running');
    expect(workerOutcome('running', false)).toBe('unknown');
    expect(workerOutcome(undefined, false)).toBe('unknown');
    expect(workerOutcome('completed', false)).toBe('completed');
    expect(workerOutcome('cancelled', false)).toBe('cancelled');
    expect(workerOutcome('interrupted', true)).toBe('cancelled');
    expect(workerOutcome('failed', false)).toBe('failed');
  });
});

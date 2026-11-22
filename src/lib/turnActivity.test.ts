import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './types';
import { layoutTurn, operationKind, summarizeActivity, summaryHeadline, visibleReasoning } from './turnActivity';

const item = (id: string, kind: TimelineItem['kind'], extra: Partial<TimelineItem> & Record<string, unknown> = {}): TimelineItem =>
  ({ id, kind, status: 'completed', ...extra }) as TimelineItem;

describe('actividad del turno', () => {
  it('oculta razonamientos sin texto y conserva los resúmenes legibles', () => {
    const items = [item('r1', 'reasoning', { text: '' }), item('r2', 'reasoning', { text: '  ' }), item('r3', 'reasoning', { text: 'Resumen' }), item('t', 'text', { text: 'Hecho' })];
    const { activity, answer } = layoutTurn(items, false);
    expect(activity.map((i) => i.id)).toEqual(['r3']);
    expect(answer?.id).toBe('t');
    expect(visibleReasoning(items[0])).toBe(false);
  });

  it('agrupa las notas de Codex en la actividad y usa final_answer como respuesta', () => {
    const items = [
      item('n1', 'text', { text: 'Reviso', phase: 'commentary' }),
      item('c1', 'command', { command: 'cat a', actions: [{ type: 'read', name: 'a' }], exitCode: 0 }),
      item('a', 'text', { text: 'Respuesta', phase: 'final_answer' }),
      item('n2', 'text', { text: 'Nota tardía', phase: 'commentary' }),
    ];
    const { activity, answer } = layoutTurn(items, false);
    expect(answer?.id).toBe('a');
    expect(activity.map((i) => i.id)).toEqual(['n1', 'c1', 'n2']);
  });

  it('en curso, un texto seguido de operaciones es una nota', () => {
    const items = [item('t1', 'text', { text: 'Primero' }), item('c1', 'command', { status: 'running', command: 'npm test' })];
    expect(layoutTurn(items, true).answer).toBeNull();
    expect(layoutTurn([...items, item('t2', 'text', { status: 'running', text: '' })], true).answer?.id).toBe('t2');
  });

  it('cuenta cada elemento una vez y clasifica por tipo observado', () => {
    const edit = item('f1', 'file_change', { changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] });
    const items = [
      item('c1', 'command', { command: 'ls', actions: [{ type: 'listFiles' }] }),
      item('c2', 'command', { command: 'npm test', exitCode: 1 }),
      edit, edit,
      item('t1', 'tool', { tool: 'Read', input: { file_path: 'a.ts' } }),
      item('t2', 'tool', { tool: 'Edit', input: { file_path: 'c.ts' } }),
      item('d1', 'file_change', { status: 'declined', changes: [{ path: 'z.ts', kind: 'update' }] }),
    ];
    const s = summarizeActivity(items);
    expect(s.operations).toBe(6);
    expect(s.commands).toBe(1);
    expect(s.searches).toBe(1);
    expect(s.reads).toBe(1);
    expect(s.files).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.declined).toBe(1);
    expect(summaryHeadline(s)).toBe('6 operaciones realizadas · 3 archivos modificados');
    expect(operationKind(item('w', 'web_search'))).toBe('web');
  });
});

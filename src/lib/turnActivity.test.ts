import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './types';
import { groupHeadline, layoutTurn, operationKind, summarizeActivity, summaryHeadline, visibleReasoning } from './turnActivity';

const item = (id: string, kind: TimelineItem['kind'], extra: Partial<TimelineItem> & Record<string, unknown> = {}): TimelineItem =>
  ({ id, kind, status: 'completed', ...extra }) as TimelineItem;

describe('actividad del turno', () => {
  it('muestra solo la última actualización de la lista de tareas en el chat', () => {
    const items = [item('p1', 'plan', { text: '- [ ] A' }), item('c1', 'command', { command: 'ls' }), item('p2', 'plan', { text: '- [x] A' }), item('t', 'text', { text: 'Hecho' })];
    const { activity, segments } = layoutTurn(items, false);
    const shown = segments.flatMap((s) => (s.kind === 'group' ? s.items.map((i) => i.id) : [s.key]));
    expect(shown).toEqual(['c1', 'p2', 't']);
    expect(activity.map((i) => i.id)).toEqual(['p1', 'c1', 'p2']);
  });

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

  it('intercala los mensajes de progreso entre grupos de operaciones consecutivas (Codex)', () => {
    const items = [
      item('n1', 'text', { text: 'Voy a revisar el componente del chat.', phase: 'commentary' }),
      item('r1', 'command', { command: 'cat a', actions: [{ type: 'read', path: 'a.ts' }], exitCode: 0 }),
      item('r2', 'command', { command: 'cat b', actions: [{ type: 'read', path: 'b.ts' }], exitCode: 0 }),
      item('r3', 'command', { command: 'cat a', actions: [{ type: 'read', path: 'a.ts' }], exitCode: 0 }),
      item('n2', 'text', { text: 'He encontrado el problema.', phase: 'commentary' }),
      item('f1', 'file_change', { changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'update' }] }),
      item('c1', 'command', { command: 'npm run build', exitCode: 0 }),
      item('d', 'diff', { diff: '…' }),
      item('a', 'text', { text: 'Corregido.', phase: 'final_answer' }),
    ];
    const { segments, answer } = layoutTurn(items, false);
    expect(answer?.id).toBe('a');
    expect(segments.map((s) => s.kind === 'group' ? s.items.map((i) => i.id).join('+') : `${s.kind}:${s.item.id}`))
      .toEqual(['note:n1', 'r1+r2+r3', 'note:n2', 'f1+c1', 'answer:a']);
    const [, reads, , edits] = segments;
    expect(reads.kind === 'group' && groupHeadline(summarizeActivity(reads.items))).toBe('2 archivos consultados');
    expect(edits.kind === 'group' && groupHeadline(summarizeActivity(edits.items))).toBe('2 archivos modificados · 1 comando ejecutado');
  });

  it('Claude Code: los textos entre herramientas son notas y el último es la respuesta', () => {
    const items = [
      item('t1', 'text', { text: 'Reviso el archivo.' }),
      item('u1', 'tool', { tool: 'Read', input: { file_path: 'x.ts' } }),
      item('r', 'reasoning', { text: '' }),
      item('t2', 'text', { text: 'Listo.' }),
    ];
    const { segments } = layoutTurn(items, false);
    expect(segments.map((s) => s.kind)).toEqual(['note', 'group', 'answer']);
    // En curso, un texto seguido de una operación se convierte en nota sin cambiar su clave.
    const live = layoutTurn([...items.slice(0, 1)], true).segments[0];
    const later = layoutTurn(items.slice(0, 2), true).segments[0];
    expect([live.kind, later.kind, live.key === later.key]).toEqual(['answer', 'note', true]);
  });
});

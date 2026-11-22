import { describe, expect, it } from 'vitest';
import { activityLabel, deriveActivity, restingPose, turnPhase, TURN_LABEL } from './activity';
import type { RunView, TimelineItem } from './types';

const NOW = 1_000_000;
const run = (p: Partial<RunView> = {}): RunView => ({ runId: 'r', conversationId: 'c', messageId: 'm', agent: 'claude', model: 'haiku', items: [], usage: null, approvals: [], startedAt: NOW - 5000, ...p });
const item = (p: Partial<TimelineItem>): TimelineItem => ({ id: Math.random().toString(36), kind: 'command', status: 'running', ...p });

describe('deriveActivity', () => {
  it('reposo sin run ni mensajes', () => expect(deriveActivity(undefined, undefined, NOW)).toBe('idle'));
  it('celebra unos segundos al terminar y vuelve al reposo', () => {
    expect(deriveActivity(undefined, { status: 'done', endedAt: NOW - 1000 }, NOW)).toBe('done');
    expect(deriveActivity(undefined, { status: 'done', endedAt: NOW - 3000 }, NOW)).toBe('idle');
  });
  it('un mensaje fallido muestra el error', () => expect(deriveActivity(undefined, { status: 'failed', endedAt: NOW - 500 }, NOW)).toBe('error'));
  it('run sin ítems: pensando', () => expect(deriveActivity(run(), undefined, NOW)).toBe('thinking'));
  it('razonamiento en curso: pensando', () => expect(deriveActivity(run({ items: [item({ kind: 'reasoning' })] }), undefined, NOW)).toBe('thinking'));
  it('lecturas de archivo: leyendo', () => {
    expect(deriveActivity(run({ items: [item({ kind: 'tool', tool: 'Read' })] }), undefined, NOW)).toBe('reading');
    expect(deriveActivity(run({ items: [item({ kind: 'web_search' })] }), undefined, NOW)).toBe('tools');
  });
  it('otras herramientas y comandos: ejecutando', () => {
    expect(deriveActivity(run({ items: [item({ kind: 'tool', tool: 'Bash' })] }), undefined, NOW)).toBe('tools');
    expect(deriveActivity(run({ items: [item({ kind: 'command' })] }), undefined, NOW)).toBe('tools');
  });
  it('cambios de archivos: escribiendo código', () => {
    expect(deriveActivity(run({ items: [item({ kind: 'file_change' })] }), undefined, NOW)).toBe('coding');
    expect(deriveActivity(run({ items: [item({ kind: 'diff' })] }), undefined, NOW)).toBe('tools');
  });
  it('la autorización pendiente tiene prioridad', () => {
    const r = run({ items: [item({ kind: 'command' })], approvals: [{ approvalId: 'a', info: { agent: 'codex', kind: 'command', options: [] } }, { approvalId: 'b', info: { agent: 'codex', kind: 'command', options: [] } }] });
    expect(deriveActivity(r, undefined, NOW)).toBe('waiting');
  });
  it('un ítem fallido se ve solo mientras no haya otro en curso', () => {
    const failed = item({ kind: 'command', status: 'failed', exitCode: 1 });
    expect(deriveActivity(run({ items: [failed] }), undefined, NOW)).toBe('error');
    expect(deriveActivity(run({ items: [failed, item({ kind: 'command' })] }), undefined, NOW)).toBe('tools');
  });
  it('el texto en streaming es «generando respuesta» incluso con un bloque de código', () => {
    expect(deriveActivity(run({ items: [item({ kind: 'text', text: 'Hola' })] }), undefined, NOW)).toBe('writing');
    expect(deriveActivity(run({ items: [item({ kind: 'text', text: 'Mira:\n```ts\nconst a' })] }), undefined, NOW)).toBe('writing');
  });
  it('el texto no cuenta como acción en curso', () => {
    expect(deriveActivity(run({ items: [item({ kind: 'tool', tool: 'Read' }), item({ kind: 'text', text: '' })] }), undefined, NOW)).toBe('reading');
  });
});

describe('activityLabel', () => {
  it('comando en curso', () => {
    const r = run({ items: [item({ kind: 'command', command: 'npm test' })] });
    expect(activityLabel(r, 'tools')).toEqual({ label: 'Ejecutando comandos', detail: 'npm test' });
  });
  it('autorización', () => {
    const r = run({ approvals: [{ approvalId: 'a', info: { agent: 'codex', kind: 'command', command: 'npm install', options: [] } }] });
    expect(activityLabel(r, 'waiting')).toEqual({ label: 'Esperando autorización', detail: 'npm install' });
  });
  it('lectura: nombre del archivo', () => {
    const r = run({ items: [item({ kind: 'tool', tool: 'Read', input: { file_path: 'C:/p/src/a.ts' } })] });
    expect(activityLabel(r, 'reading').detail).toBe('a.ts');
  });
  it('pensando y deteniendo', () => {
    expect(activityLabel(run(), 'thinking')).toEqual({ label: 'Pensando', detail: null });
    expect(activityLabel(run({ stopping: true }), 'thinking')).toEqual({ label: 'Deteniendo…', detail: null });
  });
});

it('pose de reposo en el historial', () => {
  expect(restingPose({ status: 'failed' })).toBe('error');
  expect(restingPose({ status: 'done' })).toBe('idle');
  expect(restingPose({ status: 'interrupted' })).toBe('idle');
});

describe('estado coherente del turno (cabecera, compositor y mascota)', () => {
  const waiting = run({ items: [item({ kind: 'command' })], approvals: [{ approvalId: 'a', info: { agent: 'claude', kind: 'command', command: 'npm install', options: [] } }] });
  it('esperando autorización: ningún texto dice que sigue trabajando', () => {
    expect(turnPhase(waiting)).toBe('waiting');
    expect(TURN_LABEL[turnPhase(waiting)]).toBe(activityLabel(waiting, deriveActivity(waiting, undefined, NOW)).label);
  });
  it('pensando y generando se nombran; el resto es «Trabajando»', () => {
    expect(TURN_LABEL[turnPhase(run())]).toBe('Pensando');
    expect(TURN_LABEL[turnPhase(run({ items: [item({ kind: 'text', text: 'Hola' })] }))]).toBe('Escribiendo respuesta');
    expect(TURN_LABEL[turnPhase(run({ items: [item({ kind: 'command' })] }))]).toBe('Trabajando');
    expect(TURN_LABEL[turnPhase(run({ items: [item({ kind: 'tool', tool: 'Read' })] }))]).toBe('Trabajando');
  });
  it('deteniendo prevalece', () => {
    expect(turnPhase({ ...waiting, stopping: true })).toBe('stopping');
    expect(activityLabel({ ...waiting, stopping: true }, 'waiting')).toEqual({ label: 'Deteniendo…', detail: null });
  });
  it('una acción fallida con el turno en curso no se presenta como error del turno', () => {
    const r = run({ items: [item({ kind: 'command', status: 'failed', exitCode: 1 })] });
    expect(activityLabel(r, deriveActivity(r, undefined, NOW)).label).toBe('Una acción ha fallado');
    expect(TURN_LABEL[turnPhase(r)]).toBe('Trabajando');
  });
});

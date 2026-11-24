import { describe, expect, it } from 'vitest';
import { primaryAction, type PrimaryActionInput } from './primaryAction';

const base: PrimaryActionInput = { running: false, queuePending: false, hasDraft: false, canSend: false, stopping: false };

describe('botón principal del compositor', () => {
  it('sin ejecución ni borrador: enviar deshabilitado', () => {
    expect(primaryAction(base)).toEqual({ action: 'send', disabled: true });
  });

  it('sin ejecución y con borrador válido: enviar', () => {
    expect(primaryAction({ ...base, hasDraft: true, canSend: true })).toEqual({ action: 'send', disabled: false });
  });

  it('con ejecución y sin borrador: cancelar', () => {
    expect(primaryAction({ ...base, running: true })).toEqual({ action: 'cancel', disabled: false });
  });

  it('con ejecución y borrador: encolar, sin interrumpir', () => {
    expect(primaryAction({ ...base, running: true, hasDraft: true, canSend: true })).toEqual({ action: 'queue', disabled: false });
  });

  it('al borrar el borrador durante la ejecución vuelve a cancelar', () => {
    const typing = primaryAction({ ...base, running: true, hasDraft: true, canSend: true });
    const cleared = primaryAction({ ...base, running: true, hasDraft: false, canSend: false });
    expect([typing.action, cleared.action]).toEqual(['queue', 'cancel']);
  });

  it('si la ejecución termina con un borrador pasa a enviar y no envía nada por sí solo', () => {
    expect(primaryAction({ ...base, running: false, hasDraft: true, canSend: true })).toEqual({ action: 'send', disabled: false });
  });

  it('con la cola pendiente o pausada, un borrador se encola aunque no haya ejecución', () => {
    expect(primaryAction({ ...base, queuePending: true, hasDraft: true, canSend: true }).action).toBe('queue');
  });

  it('cancelación solicitada: no permite cancelar dos veces', () => {
    expect(primaryAction({ ...base, running: true, stopping: true })).toEqual({ action: 'cancel', disabled: true });
  });

  it('envío en curso: ni envía ni encola dos veces', () => {
    expect(primaryAction({ ...base, hasDraft: true, canSend: false }).disabled).toBe(true);
    expect(primaryAction({ ...base, running: true, hasDraft: true, canSend: false })).toEqual({ action: 'queue', disabled: true });
  });
});

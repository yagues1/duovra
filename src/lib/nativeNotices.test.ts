import { describe, expect, it } from 'vitest';
import { approvalNoticeKey, finishedKind, isConversationInView, runNoticeKey } from './nativeNotices';

const chat = { view: 'chat', settingsOpen: false, activeConversationId: 'c1' };
const focused = () => true;
const unfocused = () => false;

describe('isConversationInView', () => {
  it('solo cuenta como visible la conversación abierta con la ventana enfocada', () => {
    expect(isConversationInView(chat, 'c1', focused)).toBe(true);
    expect(isConversationInView(chat, 'c2', focused)).toBe(false);
    expect(isConversationInView(chat, 'c1', unfocused)).toBe(false);
    expect(isConversationInView({ ...chat, settingsOpen: true }, 'c1', focused)).toBe(false);
    expect(isConversationInView({ ...chat, view: 'projects' }, 'c1', focused)).toBe(false);
  });

  it('no consulta el foco si la conversación ya no está abierta', () => {
    let asked = false;
    const probe = () => {
      asked = true;
      return true;
    };
    isConversationInView({ ...chat, view: 'projects' }, 'c1', probe);
    expect(asked).toBe(false);
  });
});

describe('finishedKind', () => {
  it('avisa al terminar o fallar, pero no de las ejecuciones detenidas', () => {
    expect(finishedKind('done')).toBe('finished');
    expect(finishedKind('failed')).toBe('failed');
    expect(finishedKind('error')).toBe('failed');
    expect(finishedKind('cancelled')).toBeNull();
    expect(finishedKind('interrupted')).toBeNull();
  });
});

describe('claves de aviso', () => {
  it('identifican el evento para no repetirlo', () => {
    expect(runNoticeKey('r1', 'finished')).toBe('run:r1:finished');
    expect(runNoticeKey('r1', 'failed')).not.toBe(runNoticeKey('r1', 'finished'));
    expect(approvalNoticeKey('a1')).toBe('approval:a1');
  });
});

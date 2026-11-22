import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/ipc';
import type { AgentId, Message, QueueView } from '../lib/types';
import { useStore } from './store';

const cid = 'cola-a';
const another = 'cola-b';
const original = useStore.getState();

function message(id: string, seq: number, role: Message['role'], agent: AgentId, status: Message['status']): Message {
  return {
    id, conversationId: cid, seq, role, agent, status, model: agent === 'codex' ? 'gpt-6-luna' : 'haiku',
    effort: agent === 'codex' ? 'high' : 'medium', content: id, items: [], error: null, completedAt: null,
    contextNote: null, usage: null, attachments: [], createdAt: 1,
  };
}

afterEach(() => {
  useStore.setState(original);
  vi.restoreAllMocks();
});

describe('Eventos de la cola', () => {
  it('mantiene la autoría y el orden con un segundo turno activo y un final duplicado', () => {
    vi.spyOn(api, 'listMessages').mockResolvedValue({ messages: [], sessions: [] });
    useStore.setState({ activeConversationId: another, messages: {}, runs: {}, settings: { 'notify.taskAttention': false } });
    const handle = useStore.getState().handleRunEvent;
    const first = {
      type: 'started' as const, conversationId: cid, runId: 'run-1', renamedTitle: null,
      userMessage: message('u1', 1, 'user', 'codex', 'done'),
      assistantMessage: message('a1', 2, 'assistant', 'codex', 'running'),
    };
    const second = {
      type: 'started' as const, conversationId: cid, runId: 'run-2', renamedTitle: null,
      userMessage: message('u2', 3, 'user', 'claude', 'done'),
      assistantMessage: message('a2', 4, 'assistant', 'claude', 'running'),
    };
    const finished = {
      type: 'finished' as const, conversationId: cid, runId: 'run-1', status: 'done',
      message: message('a1', 2, 'assistant', 'codex', 'done'),
    };
    handle(first);
    handle(first);
    handle(finished);
    handle(second);
    handle(finished);
    handle({ type: 'runReady', conversationId: cid, runId: 'run-1', steerable: true });
    expect(useStore.getState().runs[cid]).toMatchObject({ runId: 'run-2', agent: 'claude', ready: false });
    expect(useStore.getState().messages[cid].map(({ id, agent, status }) => [id, agent, status])).toEqual([
      ['u1', 'codex', 'done'], ['a1', 'codex', 'done'], ['u2', 'claude', 'done'], ['a2', 'claude', 'running'],
    ]);
    expect(useStore.getState().activeConversationId).toBe(another);
    expect(useStore.getState().activityFinish).toBeUndefined();
  });

  it('vincula la finalización al turno visible y la retira al arrancar el siguiente', () => {
    vi.spyOn(api, 'listMessages').mockResolvedValue({ messages: [], sessions: [] });
    useStore.setState({ view: 'projects', activeConversationId: cid, messages: {}, runs: {}, settings: { 'notify.taskAttention': false } });
    const handle = useStore.getState().handleRunEvent;
    handle({
      type: 'started', conversationId: cid, runId: 'run-1', renamedTitle: null,
      userMessage: message('u1', 1, 'user', 'codex', 'done'),
      assistantMessage: message('a1', 2, 'assistant', 'codex', 'running'),
    });
    handle({ type: 'finished', conversationId: cid, runId: 'run-1', status: 'done', message: message('a1', 2, 'assistant', 'codex', 'done') });
    expect(useStore.getState().activityFinish).toMatchObject({ conversationId: cid, runId: 'run-1', agent: 'codex' });
    handle({
      type: 'started', conversationId: cid, runId: 'run-2', renamedTitle: null,
      userMessage: message('u2', 3, 'user', 'claude', 'done'),
      assistantMessage: message('a2', 4, 'assistant', 'claude', 'running'),
    });
    expect(useStore.getState().activityFinish).toBeUndefined();
    expect(useStore.getState().runs[cid].agent).toBe('claude');
  });

  it('ignora una lectura de cola anterior que termina después de la actual', async () => {
    let old!: (v: QueueView) => void;
    const recent: QueueView = { entries: [], pauseReason: 'cancelled', reviewMessageId: 'a1' };
    vi.spyOn(api, 'messageQueue').mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }))
      .mockResolvedValueOnce(recent);
    const refresh = useStore.getState().refreshQueue;
    const first = refresh(cid);
    await refresh(cid);
    old({ entries: [], pauseReason: null, reviewMessageId: null });
    await first;
    expect(useStore.getState().queues[cid]).toEqual(recent);
  });
});

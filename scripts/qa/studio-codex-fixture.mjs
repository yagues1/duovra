#!/usr/bin/env node
// App Server local para el QA de persistencia. Solo responde por stdin/stdout.
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('duovra-qa-codex-fixture 1.0');
  process.exit();
}
if (process.argv[2] !== 'app-server') process.exit(2);

let thread = 0;
let turn = 0;
const active = new Map();
const emit = (event) => console.log(JSON.stringify({ jsonrpc: '2.0', ...event }));
const complete = (threadId, status) => {
  const run = active.get(threadId);
  if (!run) return;
  clearTimeout(run.timer);
  active.delete(threadId);
  if (status === 'completed') {
    emit({ method: 'item/completed', params: { threadId, item: { id: run.id, type: 'agentMessage', text: 'Respuesta guardada por el proveedor local de QA.' } } });
  }
  emit({ method: 'turn/completed', params: { threadId, turn: { id: run.id, status } } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => emit({ id, result });
  if (method === 'initialize') reply({ userAgent: 'duovra-qa-fixture' });
  else if (method === 'thread/start') reply({ thread: { id: 'qa-thread-' + ++thread } });
  else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
  else if (method === 'turn/start') {
    const name = 'qa-turn-' + ++turn;
    const hold = params.input.some((item) => item.text?.includes('Espera la cancelación de QA'));
    const timer = hold ? undefined : setTimeout(() => complete(params.threadId, 'completed'), 120);
    active.set(params.threadId, { id: name, timer });
    reply({ turn: { id: name, status: 'inProgress' } });
  } else if (method === 'turn/interrupt') {
    reply({});
    complete(params.threadId, 'interrupted');
  } else if (id != null) {
    emit({ id, error: { code: -32601, message: 'Método sin fixture: ' + method } });
  }
}

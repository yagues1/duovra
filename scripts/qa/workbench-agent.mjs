// Servidor local de QA. No se conecta a proveedores ni lee sus configuraciones.
import { createInterface } from 'node:readline';

const [agent, mode] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
const emit = (value) => console.log(JSON.stringify(value));

if (mode === '--version') {
  console.log('Duovra Workbench QA fixture 1.0');
  input.close();
} else if (agent === 'claude') {
  for await (const line of input) {
    const { request_id: requestId, request } = JSON.parse(line);
    if (request?.subtype !== 'initialize') process.exit(2);
    emit({ type: 'control_response', response: { request_id: requestId, response: {
      models: [{ value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: ['medium'] }],
    } } });
  }
} else if (mode === 'app-server') {
  let turn = 0;
  let timer;
  let active;
  const notify = (method, params) => emit({ jsonrpc: '2.0', method, params });
  const finish = (status) => {
    if (!active) return;
    clearInterval(timer);
    notify('turn/completed', { threadId: active.threadId, turn: { id: active.id, status } });
    active = undefined;
  };
  for await (const line of input) {
    const { id, method, params } = JSON.parse(line);
    const reply = (result) => emit({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') reply({ userAgent: 'duovra-workbench-qa' });
    else if (method === 'model/list') reply({ data: [{ model: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', isDefault: true }] });
    else if (method === 'thread/start') reply({ thread: { id: 'qa-workbench-thread' } });
    else if (method === 'thread/resume') reply({ thread: { id: params.threadId } });
    else if (method === 'turn/start') {
      const threadId = params.threadId;
      const turnId = `qa-workbench-turn-${++turn}`;
      const itemId = `${turnId}-text`;
      active = { id: turnId, threadId };
      reply({ turn: { id: turnId, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: turnId } });
      notify('item/started', { threadId, item: { id: itemId, type: 'agentMessage' } });
      let count = 0;
      let text = '';
      timer = setInterval(() => {
        const delta = `\n\nFragmento de streaming local ${++count}.`;
        text += delta;
        notify('item/agentMessage/delta', { threadId, itemId, delta });
        if (count === 48) {
          notify('item/completed', { threadId, item: { id: itemId, type: 'agentMessage', text } });
          finish('completed');
        }
      }, 170);
    } else if (method === 'turn/interrupt') {
      reply({});
      finish('interrupted');
    } else if (id != null) {
      emit({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método de QA sin respuesta: ${method}` } });
    }
  }
  if (active) finish('interrupted');
} else {
  input.close();
  process.exitCode = 2;
}

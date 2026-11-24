// Dos adaptadores de protocolo locales. Nunca llaman a un proveedor ni ejecutan herramientas.
import { streamStart, streamEnd, toolOutput, visualResponse } from './visual-previews-content.mjs';
import { firstChunk, throughFence, followingText, interactiveResponse } from './interactive-views-content.mjs';

const fixtureResponse = (tag) => interactiveResponse(tag) ?? visualResponse(tag);
const refinementResponse = [
  '## Revisión del módulo de cálculo',
  'La suma y la resta comparten ahora la misma validación de entrada. El cambio deja intactas las firmas públicas para que las llamadas existentes sigan funcionando.',
  '### Casos revisados',
  '- Los números negativos y el cero siguen las reglas de JavaScript.\n- Las entradas inválidas devuelven un error explícito.\n- Las pruebas cubren transacciones con saldo de apertura y cierre.',
  '`'.repeat(3) + 'js\nexport function resta(a, b) {\n  if (!Number.isFinite(a) || !Number.isFinite(b)) {\n    throw new TypeError("Se esperaban dos importes numéricos");\n  }\n  return a - b;\n}\n' + '`'.repeat(3),
  '### Validación',
  'Revisé el cambio sobre valores positivos, negativos y decimales. También comprobé que el consumidor recibe el mismo tipo de retorno y que el mensaje de error permite localizar la entrada incorrecta.',
  '### Siguiente paso',
  'La tabla de casos queda lista para la revisión. El panel de actividad recoge la lectura del módulo, los cambios y el resultado de las pruebas.',
].join('\n\n');
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createInterface } from 'node:readline';

const [agent, mode] = process.argv.slice(2);
const root = process.env.DUOVRA_QUEUE_FIXTURE;
if (!root) process.exit(2);
const profile = (agent === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR);
if (!profile) process.exit(2);
const account = basename(profile);
mkdirSync(profile, { recursive: true });
const settings = () => {
  const path = join(profile, 'controls.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
};
const markers = (prompt) => prompt.split('</conversation_context>\n\n').at(-1);
const tagOf = (prompt) => markers(prompt).match(/\[QA:([A-Z0-9-]+)\]/)?.[1] ?? 'OTHER';
const log = (data) => appendFileSync(join(root, 'provider.ndjson'), JSON.stringify({ agent, account, ...data }) + '\n');
const emit = (data) => console.log(JSON.stringify(data));
const getFlag = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const released = (tag) => existsSync(join(root, tag + '.release'));
async function catalogGate() {
  if (!settings().holdCatalog) return;
  writeFileSync(join(root, 'catalog-' + agent + '.requested'), '');
  while (!existsSync(join(root, 'catalog-' + agent + '.release'))) await wait(20);
}
const claudeTokens = { input_tokens: 120, cache_read_input_tokens: 1500, cache_creation_input_tokens: 300, output_tokens: 84 };
const codexKeys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const codexRequest = { inputTokens: 500, cachedInputTokens: 320, cacheWriteInputTokens: 0, outputTokens: 70, reasoningOutputTokens: 17, totalTokens: 570 };
const profiles = [
  { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: ['medium'] },
];
if (mode === '--version') {
  console.log(agent === 'claude' ? '2.1.325 (Claude Code)' : 'codex-cli 0.169.0');
} else if (agent === 'claude' && mode === 'auth') {
  emit({ loggedIn: !settings().offline, email: (settings().identity ?? account) + '@qa.invalid', orgId: 'qa', authMethod: 'claude.ai', apiProvider: 'firstParty' });
} else if (agent === 'claude' && mode === '-p') {
  let tag, sessionId, timer;
  const model = getFlag('--model');
  const toolId = 'claude-permission';
  const finish = (text, failed = false) => {
    clearInterval(timer);
    emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'thinking', thinking: '', signature: 'qa' }, { type: 'text', text }] } });
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1795202400, rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 4102444800, status: 'allowed' }, seven_day: { utilization: 0.61, resetsAt: 4102444800, status: 'allowed' } } },
      uuid: randomUUID(), session_id: sessionId });
    const result = { type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed,
      errors: failed ? [text] : [], uuid: randomUUID(), session_id: sessionId, usage: {} };
    if (tag.startsWith('INSIGHTS-CLAUDE')) {
      mkdirSync(join(profile, 'projects', 'qa'), { recursive: true });
      writeFileSync(join(profile, 'projects', 'qa', sessionId + '.jsonl'), '');
      Object.assign(result, {
        usage: claudeTokens, modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000, maxOutputTokens: 8192 } },
        total_cost_usd: getFlag('--resume') ? 0.0173 : 0.0123, duration_ms: 300, num_turns: 4,
      });
    }
    emit(result);
    if (tag.startsWith('INSIGHTS-CLAUDE')) emit(result);
  };
  const reportInsights = () => {
    const call = (id, name, input) => emit({ type: 'assistant', parent_tool_use_id: null,
      message: { id: randomUUID(), content: [{ type: 'tool_use', id, name, input }] } });
    const resolve = (id, text, tool_use_result) => emit({ type: 'user', parent_tool_use_id: null, tool_use_result,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    const task = (subtype, task_id, fields) => emit({ type: 'system', subtype, task_id,
      uuid: randomUUID(), session_id: sessionId, ...fields });
    const request = { type: 'assistant', parent_tool_use_id: null, message: { id: randomUUID(), model: 'claude-haiku-5-5',
      usage: claudeTokens, content: [] } };
    emit(request);
    emit(request);
    call('qa-todo', 'TodoWrite', { todos: [{ content: 'Verificar el estado inicial', status: 'completed' }] });
    resolve('qa-todo', 'Todos have been modified successfully.');
    call('qa-create', 'TaskCreate', { subject: 'Revisar el contrato del proveedor', description: 'Comprobar los campos de uso y caché.' });
    resolve('qa-create', 'Task #1 created successfully: Revisar el contrato del proveedor', { task: { id: '1' } });
    call('qa-create-2', 'TaskCreate', { subject: 'Validar la persistencia', description: 'Reabrir la base local de QA.' });
    resolve('qa-create-2', 'Task #2 created successfully: Validar la persistencia', { task: { id: '2' } });
    call('qa-update', 'TaskUpdate', { taskId: '1', status: 'completed' });
    resolve('qa-update', 'Updated task #1 status', { success: true });
    call('qa-update-2', 'TaskUpdate', { taskId: '2', status: 'in_progress', addBlockedBy: ['1'] });
    resolve('qa-update-2', 'Updated task #2 status', { success: true });
    call('qa-agent', 'Agent', { description: 'Comprobar los eventos del protocolo', subagent_type: 'Explore' });
    task('task_started', 'qa-worker-claude', { task_type: 'local_agent', run_id: 'qa-work-1', tool_use_id: 'qa-agent', description: 'Comprobar los eventos del protocolo' });
    emit({ type: 'assistant', parent_tool_use_id: 'qa-agent', message: { id: randomUUID(), usage: claudeTokens,
      content: [{ type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: 'contrato.json' } }] } });
    task('task_progress', 'qa-worker-claude', { run_id: 'qa-work-1', tool_use_id: 'qa-agent',
      summary: 'Contraste de campos en curso.', last_tool_name: 'Read', usage: { total_tokens: 240, tool_uses: 1, duration_ms: 85 } });
    task('task_notification', 'qa-worker-claude', { run_id: 'qa-work-1', tool_use_id: 'qa-agent', status: 'completed',
      summary: 'Contrato comprobado. El contador acumulado y la última solicitud tienen alcances distintos.',
      usage: { total_tokens: 320, tool_uses: 2, duration_ms: 160 } });
    task('task_notification', 'qa-unidentified', { status: 'completed', summary: 'Evento sin datos de delegación' });
    task('task_started', 'qa-background', { task_type: 'local_bash', description: 'Comprobar datos incompletos' });
    task('task_notification', 'qa-background', { status: 'failed', summary: 'El fixture omitió un campo requerido.' });
  };
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const msg = JSON.parse(line);
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      await catalogGate();
      emit({ type: 'control_response', response: {
        request_id: msg.request_id, response: { models: settings().retired ? [] : profiles, account: { tokenSource: 'oauth' }, claude_code_version: '2.1.325' },
      } });
    } else if (msg.type === 'user') {
      const prompt = msg.message.content[0].text;
      tag = tagOf(prompt);
      sessionId = getFlag('--resume') ?? randomUUID();
      log({ type: 'start', tag, model, effort: getFlag('--effort'), settings: getFlag('--settings'), cwd: process.cwd(), prompt: markers(prompt), sessionId });
      const insights = tag.startsWith('INSIGHTS-CLAUDE');
      emit({ type: 'system', subtype: 'init', session_id: sessionId, model: insights ? 'claude-haiku-5-5' : model });
      if (insights) {
        reportInsights();
        setTimeout(() => finish('Claude completó la comprobación de los eventos.'), 280);
      } else if (tag === 'CHAT-CLAUDE') {
        // 1.0.4: mensajes de progreso entre grupos de herramientas, en el orden real del protocolo.
        const say = (text) => emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text }] } });
        const use = (id, name, input, output) => {
          emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id, name, input }] } });
          emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
        };
        const steps = [
          () => say('Voy a revisar el componente del chat.'),
          () => use('chat-read-1', 'Read', { file_path: 'src/Chat.tsx' }, 'export function Chat() {}'),
          () => use('chat-read-2', 'Read', { file_path: 'src/state.ts' }, 'export const state = {};'),
          () => say('He encontrado el problema en la gestión del estado.'),
          () => use('chat-bash', 'Bash', { command: 'npm run build', description: 'Compilar' }, 'built in 1.2s'),
        ];
        let at = 0;
        timer = setInterval(() => {
          if (at < steps.length) steps[at++]();
          else finish('He solucionado el problema y la compilación funciona correctamente.\n\n```ts\nexport const fixed = true;\n```');
        }, 180);
      } else if (tag === 'VISUAL-CLAUDE') {
        const id = 'qa-visual-tool';
        emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id, name: 'RenderReport', input: {} }] } });
        emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: toolOutput }] } });
        finish(fixtureResponse(tag));
      } else if (tag.startsWith('PERMISSION')) {
        const tool = { type: 'tool_use', id: toolId, name: 'Write', input: { file_path: 'qa.txt', content: 'simulado' } };
        emit({ type: 'assistant', message: { id: randomUUID(), content: [tool] } });
        emit({ type: 'control_request', request_id: toolId, request: {
          subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: toolId, input: tool.input,
        } });
      } else if (tag.startsWith('HOLD')) {
        timer = setInterval(() => { if (released(tag)) finish('Claude completó ' + tag); }, 40);
      } else if (tag.startsWith('FAIL')) {
        setTimeout(() => finish('Fallo simulado de Claude', true), 150);
      } else {
        setTimeout(() => finish(fixtureResponse(tag) ?? 'Claude completó ' + tag), 220);
      }
    } else if (msg.type === 'control_response') {
      const declined = msg.response.response.behavior === 'deny';
      log({ type: 'permission', tag, decision: declined ? 'decline' : 'accept' });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: declined,
        content: declined ? 'El usuario rechazó esta acción desde Duovra.' : 'Herramienta simulada.' }] } });
      finish(declined ? 'Claude respetó el rechazo' : 'Claude procesó la autorización');
    } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      log({ type: 'cancel', tag });
      finish('Claude se detuvo');
    }
  }
  clearInterval(timer);
} else if (agent === 'codex' && mode === 'app-server') {
  const active = new Map();
  const previous = new Map();
  const notify = (method, params) => emit({ method, params });
  const tokenPath = (threadId) => join(profile, threadId + '.tokens.json');
  const reportTokens = (run, times, repeat = true) => {
    const path = tokenPath(run.threadId);
    let total = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    for (let i = 0; i < times; i++) {
      total = Object.fromEntries(codexKeys.map((key) => [key, (total[key] ?? 0) + codexRequest[key]]));
      const params = {
        threadId: run.threadId, turnId: run.id,
        tokenUsage: { total, last: codexRequest, modelContextWindow: run.tag === 'INSIGHTS-RESUME' ? null : 258_400 },
      };
      writeFileSync(path, JSON.stringify(total));
      notify('thread/tokenUsage/updated', params);
      if (repeat) notify('thread/tokenUsage/updated', params);
    }
  };
  const reportInsights = (run) => {
    const emitTurn = (method, value) => notify(method, { threadId: run.threadId, turnId: run.id, ...value });
    const plan = (states) => emitTurn('turn/plan/updated', { explanation: 'Verificar el flujo de uso en Duovra.',
      plan: ['Leer eventos de ambos proveedores', 'Reconciliar tokens y caché', 'Comprobar reinicio en SQLite']
        .map((step, index) => ({ step, status: states[index] })) });
    plan(['inProgress', 'pending', 'pending']);
    plan(['completed', 'inProgress', 'pending']);
    plan(['completed', 'inProgress', 'pending']);
    emitTurn('item/completed', { item: { id: run.id + '-compaction', type: 'contextCompaction' } });
    const delegate = (method, id, tool, data) => emitTurn(method, { item: {
      id, type: 'collabAgentToolCall', senderThreadId: run.threadId, receiverThreadIds: [], agentsStates: {}, tool, ...data,
    } });
    delegate('item/completed', run.id + '-spawn', 'spawnAgent', {
      status: 'completed', receiverThreadIds: ['qa-sub-codex-a'], prompt: 'Revisar los snapshots acumulados del hilo.',
      model: 'gpt-6-luna', reasoningEffort: 'high', agentsStates: { 'qa-sub-codex-a': { status: 'running', message: null } },
    });
    emitTurn('item/completed', { item: { id: run.id + '-sub-b', type: 'subAgentActivity',
      agentThreadId: 'qa-sub-codex-b', agentPath: 'revisión', model: 'gpt-6-luna', kind: 'started' } });
    delegate('item/completed', run.id + '-wait', 'wait', {
      status: 'completed', receiverThreadIds: ['qa-sub-codex-a', 'qa-sub-codex-b', 'qa-no-evidence'],
      agentsStates: { 'qa-sub-codex-a': { status: 'completed', message: 'La repetición del snapshot conserva el mismo consumo.' },
        'qa-sub-codex-b': { status: 'interrupted', message: 'Resultado parcial de la revisión.' } },
    });
  };
  const completion = (run, status) => ({ threadId: run.threadId, turn: {
    id: run.id, status, error: status === 'failed' ? { message: 'Fallo simulado de Codex' } : null,
  } });
  const finish = (run, status, response = 'Codex completó ' + run.tag, silent = false) => {
    if (!active.has(run.threadId)) return;
    clearInterval(run.timer);
    active.delete(run.threadId);
    const item = { id: run.id + '-text', type: 'agentMessage', text: response };
    const event = completion(run, status);
    const file = join(profile, run.threadId + '.turns.json');
    const turns = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, JSON.stringify([...turns, { ...event.turn, items: [item] }]));
    log({ type: 'terminal', tag: run.tag, status, turnId: run.id, silent });
    if (silent) return;
    notify('item/completed', { threadId: run.threadId, turnId: run.id, item });
    notify('turn/completed', event);
    previous.set(run.threadId, event);
    notify('turn/completed', event);
  };
  const input = createInterface({ input: process.stdin });
  const ask = (run, name, turnId = run.id) => emit({
    id: 'approval-' + name, method: 'item/commandExecution/requestApproval', params: {
      threadId: run.threadId, turnId, itemId: 'qa-' + name, command: 'Operación simulada',
      availableDecisions: ['accept', 'decline'],
    },
  });
  for await (const line of input) {
    const { id, method, params, result } = JSON.parse(line);
    if (!method && typeof id === 'string' && id.startsWith('approval-')) {
      log({ type: 'codex-permission', name: id, decision: result?.decision });
      continue;
    }
    const reply = (result) => emit({ id, result });
    const reject = (code, message) => emit({ id, error: { code, message } });
    if (method === 'initialize') reply({ userAgent: 'duovra-queue-fixture' });
    else if (method === 'account/read') reply({ account: settings().offline ? null : {
      type: 'chatgpt', email: (settings().identity ?? account) + '@qa.invalid',
    }, requiresOpenaiAuth: true });
    else if (method === 'model/list') {
      await catalogGate();
      if (settings().catalogError) {
        reject(-32603, 'Catálogo no disponible temporalmente');
        continue;
      }
      const models = ['gpt-6-luna', 'gpt-6.2-sol'].filter((model) => model !== settings().retired);
      reply({ data: models.map((model) => ({ model, displayName: model, supportedReasoningEfforts: [
        { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
      ], defaultReasoningEffort: 'high', isDefault: model === 'gpt-6-luna',
      serviceTiers: model === 'gpt-6-luna' ? [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] : [] })) });
    } else if (method === 'thread/start') reply({ thread: { id: randomUUID() }, model: params.model });
    else if (method === 'thread/resume') reply({ thread: { id: params.threadId }, model: 'gpt-6-luna' });
    else if (method === 'thread/read') {
      const file = join(profile, params.threadId + '.turns.json');
      reply({ thread: { id: params.threadId, turns: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [] } });
    } else if (method === 'turn/start') {
      const threadId = params.threadId;
      const prompt = params.input[0].text;
      const tag = tagOf(prompt);
      if (tag.startsWith('SANDBOX-')) {
        log({ type: 'policy', tag, threadId, policy: params.sandboxPolicy?.type });
        if (tag === 'SANDBOX-REJECT') {
          reject(401, 'Unauthorized: qa-canario');
          continue;
        }
        if (tag === 'SANDBOX-INCOMPLETE') {
          reply({});
          continue;
        }
      }
      const run = { id: randomUUID(), threadId, tag };
      active.set(threadId, run);
      log({ type: 'start', tag, model: params.model, effort: params.effort, speed: params.serviceTierForTurn ?? null, prompt: markers(prompt), threadId, turnId: run.id });
      reply({ turn: { id: run.id, status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: run.id } });
      const old = previous.get(threadId);
      if (old) {
        notify('turn/completed', old);
        log({ type: 'duplicate', tag, oldTurn: old.turn.id });
      }
      if (tag === 'MASCOT-CODEX') {
        const at = (it, done) => notify(done ? 'item/completed' : 'item/started', { threadId, turnId: run.id, item: it });
        const read = { id: 'm1', type: 'commandExecution', command: 'Get-Content src/math.js', cwd: 'C:/qa', status: 'inProgress', commandActions: [{ type: 'read', command: 'Get-Content src/math.js', name: 'math.js', path: 'C:/qa/src/math.js' }] };
        const edit = { id: 'm2', type: 'fileChange', status: 'inProgress', changes: [{ path: 'C:/qa/src/math.js', kind: { type: 'update' }, diff: '@@ -1 +1,2 @@\n+export const resta = (a, b) => a - b;' }] };
        const tool = { id: 'm3', type: 'commandExecution', command: 'npm test', cwd: 'C:/qa', status: 'inProgress', commandActions: [] };
        const steps = [
          () => at({ id: 'm0', type: 'reasoning', summary: [], content: [] }, false),
          () => { at({ id: 'm0', type: 'reasoning', summary: [], content: [] }, true); at(read, false); },
          () => { at({ ...read, status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }, true); at(edit, false); },
          () => { at({ ...edit, status: 'completed' }, true); at(tool, false); },
          () => { at({ ...tool, status: 'completed', exitCode: 0, aggregatedOutput: '4 tests ok' }, true); ask(run, 'mascot'); },
        ];
        let step = 0;
        run.timer = setInterval(() => {
          if (step < steps.length) {
            if (existsSync(join(root, 'MASCOT-STEP-' + step + '.release'))) steps[step++]();
          } else if (released('MASCOT-CODEX')) finish(run, 'completed', 'Listo: resta(a, b) añadida y probada.');
        }, 60);
        continue;
      }
      if (tag.startsWith('ACTIVITY')) {
        const item = (it, done = true) => notify(done ? 'item/completed' : 'item/started', { threadId, turnId: run.id, item: it });
        const steps = [
          () => item({ id: 'r0', type: 'reasoning', summary: [], content: [] }),
          () => item({ id: 'n1', type: 'agentMessage', text: 'Reviso el módulo y ejecuto las pruebas.', phase: 'commentary' }),
          () => item({ id: 'c1', type: 'commandExecution', command: 'Get-Content src/math.js', cwd: 'C:/qa', status: 'completed', aggregatedOutput: 'export function suma(a, b) { return a + b; }', exitCode: 0, durationMs: 140, commandActions: [{ type: 'read', command: 'Get-Content src/math.js', name: 'math.js', path: 'C:/qa/src/math.js' }] }),
          () => item({ id: 'r1', type: 'reasoning', summary: [], content: [] }),
          () => item({ id: 'c2', type: 'commandExecution', command: 'rg -n resta src', cwd: 'C:/qa', status: 'completed', aggregatedOutput: '', exitCode: 1, durationMs: 60, commandActions: [{ type: 'search', command: 'rg -n resta src', query: 'resta', path: 'src' }] }),
          () => item({ id: 'r2', type: 'reasoning', summary: ['**Plan**\n\nAñadir resta(a, b) y comprobarla.'], content: [] }),
          () => item({ id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'C:/qa/src/math.js', kind: { type: 'update' }, diff: '@@ -1 +1,2 @@\n export function suma(a, b) { return a + b; }\n+export function resta(a, b) { return a - b; }' }] }),
          () => item({ id: 'c3', type: 'commandExecution', command: 'npm test', cwd: 'C:/qa', status: 'completed', aggregatedOutput: '4 tests ok', exitCode: 0, durationMs: 2100, commandActions: [] }),
        ];
        let at = 0;
        run.timer = setInterval(() => {
          if (at < steps.length) steps[at++]();
          else if (!tag.startsWith('ACTIVITY-HOLD') || released(tag)) {
            finish(run, 'completed', tag === 'ACTIVITY-HOLD-REFINEMENT' ? refinementResponse : 'Añadí `resta(a, b)` y las pruebas pasan.');
          }
        }, 160);
        continue;
      }
      if (tag === 'INSIGHTS-CODEX') reportInsights(run);
      if (tag === 'INSIGHTS-CODEX' || tag.startsWith('INSIGHTS-RESUME')) reportTokens(run, 2);
      if (tag === 'HOLD-CANCEL') {
        notify('turn/plan/updated', { threadId, turnId: run.id,
          plan: [{ step: 'Paso activo antes de cancelar', status: 'inProgress' }] });
      }
      if (tag === 'HOLD-APPROVAL') {
        ask(run, 'old', old?.turn.id ?? 'turno-anterior');
        ask(run, 'current');
      }
      if (tag === 'HOLD-CRASH') ask(run, 'crash');
      if (['HOLD-STEER', 'HOLD-CRASH', 'HOLD-CANCEL', 'DURABLE-CRASH'].includes(tag)) reportTokens(run, 1);
      if (tag === 'HOLD-WIDGET-CODEX') {
        const itemId = run.id + '-text';
        const stream = (delta) => notify('item/agentMessage/delta', { threadId, turnId: run.id, itemId, delta });
        stream(firstChunk);
        run.timer = setInterval(() => {
          if (released(tag + '-FENCE') && !run.closedFence) { stream(throughFence); run.closedFence = true; }
          if (run.closedFence && released(tag + '-CLOSE') && !run.confirmedFence) { stream('\n'); run.confirmedFence = true; }
          if (run.confirmedFence && released(tag + '-MORE') && !run.afterFence) { stream(followingText); run.afterFence = true; }
          if (released(tag)) finish(run, 'completed', fixtureResponse(tag));
        }, 40);
      } else if (tag === 'HOLD-CHAT-JUMP') {
        const itemId = run.id + '-text';
        const stream = (delta) => notify('item/agentMessage/delta', { threadId, turnId: run.id, itemId, delta });
        const content = Array.from({ length: 70 }, (_, i) => 'Párrafo largo de comprobación ' + (i + 1) + '.').join('\n\n');
        const tail = '\n\nÚltimo fragmento de la respuesta.';
        stream(content);
        run.timer = setInterval(() => {
          if (released(tag + '-MORE') && !run.afterText) { stream(tail); run.afterText = true; }
          if (released(tag)) finish(run, 'completed', content + tail);
        }, 40);
      } else if (tag === 'HOLD-VISUAL-CODEX') {
        const itemId = run.id + '-text';
        const stream = (delta) => notify('item/agentMessage/delta', { threadId, turnId: run.id, itemId, delta });
        stream(streamStart);
        run.timer = setInterval(() => {
          if (!released(tag + '-CLOSE')) return;
          if (!run.closedFence) { stream(streamEnd); run.closedFence = true; }
          if (released(tag)) finish(run, 'completed', fixtureResponse(tag));
        }, 40);
      } else if (tag.startsWith('HOLD') || tag.startsWith('DURABLE')) {
        run.timer = setInterval(() => {
          if (released(tag)) finish(run, 'completed', 'Codex completó ' + tag, tag.startsWith('DURABLE'));
        }, 40);
        if (tag === 'HOLD-CRASH') appendFileSync(join(root, 'efecto-antes-del-cierre.txt'), 'una modificación simulada\n');
      } else {
        setTimeout(() => finish(run, tag.startsWith('FAIL') ? 'failed' : 'completed', fixtureResponse(tag)), 280);
      }
    } else if (method === 'turn/steer') {
      const run = active.get(params.threadId);
      if (!run) reject(-32600, 'thread not found: ' + params.threadId);
      else if (run.id !== params.expectedTurnId) reject(-32600, 'active_turn_mismatch');
      else if (params.input[0].text.includes('QA-REJECT')) reject(-32600, 'intervención rechazada por el fixture');
      else {
        const text = params.input[0].text;
        log({ type: 'steer', tag: run.tag, text, threadId: run.threadId, turnId: run.id });
        reply({ turnId: run.id });
        reportTokens(run, 1);
        setTimeout(() => finish(run, 'completed', fixtureResponse(run.tag) ?? 'Intervención aplicada en el turno activo: ' + text), 220);
      }
    } else if (method === 'turn/interrupt') {
      const run = active.get(params.threadId);
      if (run?.id !== params.turnId) reject(-32600, 'active_turn_mismatch');
      else {
        log({ type: 'cancel', tag: run.tag });
        reply({});
        if (run.tag === 'HOLD-CANCEL') ask(run, 'late');
        finish(run, 'interrupted', 'Codex se detuvo');
      }
    } else if (id != null) reject(-32601, 'Método de QA sin respuesta: ' + method);
  }
  for (const run of active.values()) clearInterval(run.timer);
}

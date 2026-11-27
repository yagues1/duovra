// QA 1.0.11 · fase 5: APIs simuladas (Anthropic Messages y OpenAI Responses) para recorrer Duovra con
// las CLIs reales SIN invocar modelos. Amplía las de la fase 4 (`planning-mock-apis.mjs`) con:
//   QA-SLOW        Respuesta con 12 s de retraso (intervenir, encolar, interrumpir y continuar).
//   QA-FAIL        Claude: 401 de autenticación. Codex: 429 de límite de uso (errores normalizados).
// y registra si la petición lleva el bloque de contexto compartido y el objetivo de la conversación.
//
// Uso: node scripts/qa/control-mock-apis.mjs <carpeta-estado> [puerto-anthropic] [puerto-responses]
//   Escribe <carpeta-estado>/ports.json y <carpeta-estado>/requests.jsonl.
//
// Escenarios (texto del mensaje del usuario):
//   QA-PLAN        Claude: ExitPlanMode; tras pedir cambios, una segunda versión. Codex: <proposed_plan>.
//   QA-ASK         Claude: AskUserQuestion (una opción + varias). Codex: request_user_input (opciones + secreta).
//   QA-WAIT        Igual que QA-ASK, para dejar una pregunta pendiente.
//   QA-TASKS       (fase 6) Claude: TaskCreate ×3 y TaskUpdate ×3. Codex: dos `update_plan` (turn/plan/updated).
//   QA-AGENT       (fase 6) Claude: herramienta Agent con un subagente que responde al momento.
//                  Codex: `spawn_agent` (si la instalación no ofrece subagentes, se registra el error).
//   QA-TASKSLOW    (fase 6) Como QA-TASKS en Claude, con 15 s antes de la última actualización de tareas.
//   QA-VERYSLOW    (fase 6) Respuesta con 90 s de retraso (Activity Center: detener).
//   QA-AGENTSLOW   (fase 6) Como QA-AGENT, pero el subagente tarda 90 s (para detener la ejecución).
//   Cualquier otro texto: respuesta breve.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { taskTurn } from './activity-qa-helpers.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('Falta la carpeta de estado');
mkdirSync(dir, { recursive: true });
const log = (entry) => appendFileSync(join(dir, 'requests.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');

const PLAN_V1 = '# Sección de QA en el README\n1. Leer `README.md`.\n2. Añadir una sección «QA» con una línea de prueba.\n3. Revisar el resultado.';
const PLAN_V2 = '# Sección de QA en el README (v2)\n1. Leer `README.md`.\n2. Añadir una sección «QA» con una línea de prueba.\n3. Añadir una comprobación de que la sección existe.\n4. Revisar el resultado.';
const LONG_PLAN = `${PLAN_V1}\n\n## Detalle\n${Array.from({ length: 14 }, (_, i) => `- Nota ${i + 1} del plan de prueba.`).join('\n')}`;

// ---------- Anthropic ----------
const blocksOf = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? []);
const textOf = (c) => blocksOf(c).map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? JSON.stringify(b.content) : '').join('\n');
function lastHumanText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    // Solo el texto del usuario: el bloque de contexto compartido de Duovra repite mensajes anteriores.
    const text = blocksOf(m.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/<duovra_context[\s\S]*?<\/duovra_context>/g, '');
    if (/QA-[A-Z]+|Implementa|Implement|cambios|change/i.test(text)) return text;
  }
  return '';
}
/** Texto del último mensaje del usuario (sin resultados de herramientas ni contexto de Duovra). */
function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const blocks = blocksOf(m.content);
    if (blocks.some((b) => b.type === 'tool_result')) return '';
    return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(/<duovra_context[\s\S]*?<\/duovra_context>/g, '');
  }
  return '';
}
const extras = (raw) => ({ context: raw.includes('<duovra_context'), goal: /<conversation_goal>/.test(raw), goalText: /<conversation_goal>[\s\S]*?- ([^\n\[]+)/.exec(raw)?.[1]?.trim() ?? null ,
  // Fase 6: instrucciones de Duovra recibidas (marcadores QA-INS-…), retiradas y aviso de actualización.
  instructions: [...new Set([...raw.matchAll(/QA-INS-[A-Z0-9-]+/g)].map((m) => m[0]))], duovraBlock: raw.includes('<duovra_instructions>'),
  retraction: raw.includes('No longer applies (disabled'), updated: raw.includes('replaces the earlier version'),
  retiredInstructions: raw.includes('<retired_instructions>') });
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_qa_${Math.random().toString(16).slice(2, 12)}`, name, input });

function claudeReply(body) {
  const messages = body.messages ?? [];
  const human = lastHumanText(messages);
  const results = messages.flatMap((m) => blocksOf(m.content)).filter((b) => b.type === 'tool_result');
  const exits = messages.flatMap((m) => m.role === 'assistant' ? blocksOf(m.content) : []).filter((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode');
  const task = taskTurn(messages, 'anthropic');
  const last = task ? task.last : results.at(-1);
  log({ api: 'anthropic', ...extras(JSON.stringify(messages.filter((m) => m.role === 'user').at(-1) ?? {})), last: latestUserText(messages).slice(-160), model: body.model, scenario: /QA-[A-Z]+/.exec(task?.human ?? human)?.[0] ?? null, taskRunId: task?.id ?? null, taskResultId: task?.last?.tool_use_id ?? null, approvedPlan: /approved_plan version=\\?"(\d+)/.exec(JSON.stringify(messages))?.[1] ?? null, toolResult: last ? { error: !!last.is_error, text: textOf([last]).slice(0, 300) } : null });
  if (/QA-PLAN/.test(human) || /QA-LONGPLAN/.test(human)) {
    if (!exits.length) return [{ type: 'text', text: 'He revisado el proyecto y propongo este plan.' }, toolUse('ExitPlanMode', { plan: /QA-LONGPLAN/.test(human) ? LONG_PLAN : PLAN_V1 })];
    if (last?.is_error && /cambios/i.test(textOf([last])) && exits.length === 1) {
      return [{ type: 'text', text: 'He incorporado los cambios.' }, toolUse('ExitPlanMode', { plan: PLAN_V2 })];
    }
    if (last && !last.is_error) return [{ type: 'text', text: 'Implementación simulada del plan aprobado (datos de prueba de QA).' }];
    return [{ type: 'text', text: 'De acuerdo: no implemento el plan.' }];
  }
  if (/QA-ASK|QA-WAIT/.test(human)) {
    if (!results.length) {
      return [toolUse('AskUserQuestion', { questions: [
        { question: '¿Qué base de datos usa el proyecto de prueba?', header: 'Base', multiSelect: false, options: [
          { label: 'SQLite (Recommended)', description: 'Archivo local, sin servidor' }, { label: 'Postgres', description: 'Servidor externo' }] },
        { question: '¿Qué comprobaciones ejecuto después?', header: 'QA', multiSelect: true, options: [
          { label: 'Tests', description: 'Pruebas unitarias' }, { label: 'Lint', description: 'Estilo de código' }, { label: 'Build', description: 'Compilación' }] },
      ] })];
    }
    return [{ type: 'text', text: `Respuestas recibidas (datos de prueba): ${textOf([last]).slice(0, 400)}` }];
  }
  // Fase 6 · subagentes: la petición del propio subagente lleva el encargo con QA-SUB.
  if (/QA-SUB/.test(latestUserText(messages)) && !results.length) return [{ type: 'text', text: 'Resultado del subagente: revisé README.md (datos de prueba).' }];
  // Claude Code 2.1.325 desactiva TodoWrite en `-p` («TodoWrite is disabled for this session») y ofrece
  // TaskCreate/TaskUpdate: el escenario usa esas herramientas, una llamada por petición.
  if (task) {
    const calls = task.calls.length;
    const steps = [
      () => toolUse('TaskCreate', { subject: 'Leer README.md', description: 'Revisar el README de prueba', activeForm: 'Leyendo README.md' }),
      () => toolUse('TaskCreate', { subject: 'Añadir la sección QA', description: 'Sección de prueba', activeForm: 'Añadiendo la sección QA' }),
      () => toolUse('TaskCreate', { subject: 'Revisar el resultado', activeForm: 'Revisando el resultado' }),
      () => toolUse('TaskUpdate', { taskId: '2', addBlockedBy: ['1'] }),
      () => toolUse('TaskUpdate', { taskId: '1', status: 'completed' }),
      () => toolUse('TaskUpdate', { taskId: '2', status: 'in_progress' }),
    ];
    if (calls < steps.length) return [steps[calls]()];
    return [{ type: 'text', text: 'Tareas de prueba actualizadas (datos de prueba de QA).' }];
  }
  if (/QA-AGENT/.test(human)) {
    // Solo el mensaje del usuario lanza el subagente (no su resultado ni la notificación de la tarea).
    if (/QA-AGENT/.test(latestUserText(messages))) return [{ type: 'text', text: 'Delego una revisión en un subagente.' }, toolUse('Agent', {
      description: 'Revisar README (QA)', subagent_type: 'general-purpose',
      prompt: /QA-AGENTSLOW/.test(human) ? 'QA-SUBSLOW Revisa README.md y resume.' : 'QA-SUB Revisa README.md y resume.' })];
    if (/QA-AGENTSLOW/.test(human) && !latestUserText(messages).includes('<task-notification>')) {
      return [{ type: 'text', text: 'Subagente iniciado, pendiente de su resultado (datos de prueba de QA).' }];
    }
    return [{ type: 'text', text: 'El subagente terminó (datos de prueba de QA).' }];
  }
  if (/Implementa|Implement/i.test(human)) return [{ type: 'text', text: 'Implementación simulada del plan aprobado (datos de prueba de QA).' }];
  return [{ type: 'text', text: 'Respuesta simulada de QA.' }];
}

function anthropicStream(res, model, content) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { message: { id: `msg_qa_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {});
  res.end();
}

// ---------- OpenAI Responses (Codex) ----------
function codexReply(body) {
  const input = body.input ?? [];
  const users = input.filter((i) => i.role === 'user').map((i) => JSON.stringify(i.content));
  const human = (users.at(-1) ?? '').replace(/<duovra_context[\s\S]*?\/duovra_context>/g, '');
  const modes = input.filter((i) => i.role === 'developer').map((i) => JSON.stringify(i.content)).filter((t) => /Plan Mode|Default mode|collaboration_mode/i.test(t));
  const planMode = modes.length ? /Plan Mode/.test(modes.at(-1)) : false;
  const outputs = input.filter((i) => i.type === 'function_call_output');
  const lastIsOutput = input.at(-1)?.type === 'function_call_output';
  const task = taskTurn(input, 'responses');
  log({ api: 'responses', tools: (body.tools ?? []).map((t) => t.name ?? t.type).sort(), ...extras(JSON.stringify(input.filter((i) => i.role === 'user').at(-1) ?? {})), last: (users.at(-1) ?? '').slice(-200), model: body.model, planMode, approvedPlan: /approved_plan version=\\?"(\d+)/.exec(JSON.stringify(input))?.[1] ?? null, scenario: /QA-[A-Z]+/.exec(task?.human ?? human)?.[0] ?? null, taskRunId: task?.id ?? null, taskResultId: task?.last?.call_id ?? null, output: task ? (task.last ? String(task.last.output).slice(0, 300) : null) : lastIsOutput ? String(outputs.at(-1).output).slice(0, 300) : null });
  if (planMode && /QA-ASK|QA-WAIT/.test(human) && !lastIsOutput) {
    return [{ type: 'function_call', name: 'request_user_input', call_id: `call_qa_${Date.now()}`, arguments: JSON.stringify({ questions: [
      { id: 'rama', header: 'Rama', question: '¿Sobre qué rama trabajo en el proyecto de prueba?', options: [
        { label: 'main (Recommended)', description: 'Rama principal' }, { label: 'develop', description: 'Rama de integración' }] },
      // Codex 0.169 exige opciones en todas las preguntas; la respuesta secreta va por «Otra».
      { id: 'clave', header: 'Clave', question: 'Clave de prueba (no se guarda en el historial).', isSecret: true, options: [
        { label: 'Sin clave', description: 'Continuar sin clave' }, { label: 'Usar la de ejemplo', description: 'Clave ficticia de QA' }] },
    ] }) }];
  }
  // Fase 6 · tareas y subagentes.
  if (/QA-SUB/.test(human) && !lastIsOutput) return [{ type: 'message', text: 'Resultado del subagente (datos de prueba).' }];
  if (task) {
    const calls = task.calls.length;
    const steps = (states) => ['Leer README.md', 'Añadir la sección QA', 'Revisar el resultado'].map((step, i) => ({ step, status: states[i] }));
    if (calls === 0) return [{ type: 'function_call', name: 'update_plan', call_id: `call_qa_plan1_${Date.now()}`, arguments: JSON.stringify({ explanation: 'Plan de prueba', plan: steps(['completed', 'in_progress', 'pending']) }) }];
    if (calls === 1) return [{ type: 'function_call', name: 'update_plan', call_id: `call_qa_plan2_${Date.now()}`, arguments: JSON.stringify({ plan: steps(['completed', 'completed', 'in_progress']) }) }];
    return [{ type: 'message', text: 'Tareas de prueba actualizadas (datos de prueba de QA).' }];
  }
  if (/QA-AGENT/.test(human)) {
    if (!lastIsOutput) return [{ type: 'function_call', name: 'spawn_agent', call_id: `call_qa_agent_${Date.now()}`, arguments: JSON.stringify({ message: 'QA-SUB Revisa README.md y resume.' }) }];
    return [{ type: 'message', text: `Fin del escenario de subagentes (datos de prueba). Salida: ${String(outputs.at(-1).output).slice(0, 200)}` }];
  }
  // No repite las respuestas: una de ellas es secreta.
  if (lastIsOutput) return [{ type: 'message', text: 'Respuestas recibidas (datos de prueba).' }];
  if (planMode) {
    const revised = users.length > 1 && !/QA-PLAN/.test(human);
    return [{ type: 'message', text: `Propuesta de plan (datos de prueba).\n<proposed_plan>\n${revised ? PLAN_V2 : PLAN_V1}\n</proposed_plan>` }];
  }
  if (/Implementa|Implement|approved_plan/i.test(human)) return [{ type: 'message', text: 'Implementación simulada del plan aprobado (datos de prueba de QA).' }];
  return [{ type: 'message', text: 'Respuesta simulada de QA.' }];
}

function responsesStream(res, body) {
  const id = `resp_qa_${Date.now()}`;
  const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send({ type: 'response.created', response: { id, model: body.model, output: [] } });
  const items = codexReply(body).map((o, index) => {
    if (o.type === 'message') {
      const item = { type: 'message', id: `msg_qa_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: o.text, annotations: [] }] };
      send({ type: 'response.output_item.added', output_index: index, item: { ...item, content: [] } });
      send({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: o.text });
      send({ type: 'response.output_item.done', output_index: index, item });
      return item;
    }
    const item = { type: 'function_call', id: `fc_qa_${index}`, call_id: o.call_id, name: o.name, arguments: o.arguments, status: 'completed' };
    send({ type: 'response.output_item.added', output_index: index, item });
    send({ type: 'response.output_item.done', output_index: index, item });
    return item;
  });
  send({ type: 'response.completed', response: { id, model: body.model, output: items,
    usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 } } });
  res.end();
}

const serve = (handler) => createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => handler(req, res, raw ? JSON.parse(raw) : {}));
});
const anthropic = serve((req, res, body) => {
  const url = req.url ?? '';
  if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: 20 }));
  }
  if (req.method === 'POST' && url.startsWith('/v1/messages')) {
    const latest = latestUserText(body.messages ?? []);
    if (/QA-FAIL/.test(latest)) {
      log({ api: 'anthropic', scenario: 'QA-FAIL', status: 401 });
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key (QA simulada)' } }));
    }
    const content = claudeReply(body);
    // QA-TASKSLOW: las tareas llegan al momento y la última actualización tarda 15 s (Activity Center).
    const task = taskTurn(body.messages ?? [], 'anthropic');
    if (task && /QA-TASKSLOW/.test(task.human) && task.calls.length === 5 && body.stream) return setTimeout(() => anthropicStream(res, body.model, content), 15000);
    if (/QA-VERYSLOW|QA-SUBSLOW/.test(latest) && body.stream) {
      const timer = setTimeout(() => anthropicStream(res, body.model, content), 90000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (/QA-SLOW/.test(latest) && body.stream) return setTimeout(() => anthropicStream(res, body.model, content), 12000);
    if (body.stream) return anthropicStream(res, body.model, content);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_qa', type: 'message', role: 'assistant', model: body.model, content, stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 10 } }));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
});
const responses = serve((req, res, body) => {
  if (req.method === 'POST' && (req.url ?? '').includes('/responses')) {
    const users = (body.input ?? []).filter((i) => i.role === 'user').map((i) => JSON.stringify(i.content));
    const latest = (users.at(-1) ?? '').replace(/<duovra_context[\s\S]*?\/duovra_context>/g, '');
    if (/QA-FAIL/.test(latest)) {
      log({ api: 'responses', scenario: 'QA-FAIL', status: 429 });
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'You have hit your usage limit (QA simulada).', plan_type: 'plus' } }));
    }
    if (/QA-SLOW/.test(latest)) return setTimeout(() => responsesStream(res, body), 12000);
    return responsesStream(res, body);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: [], models: [] }));
});
await Promise.all([new Promise((r) => anthropic.listen(Number(process.argv[3] ?? 0), '127.0.0.1', r)), new Promise((r) => responses.listen(Number(process.argv[4] ?? 0), '127.0.0.1', r))]);
const ports = { anthropic: anthropic.address().port, responses: responses.address().port };
writeFileSync(join(dir, 'ports.json'), JSON.stringify(ports));
console.log(`APIs simuladas · Anthropic 127.0.0.1:${ports.anthropic} · Responses 127.0.0.1:${ports.responses}`);

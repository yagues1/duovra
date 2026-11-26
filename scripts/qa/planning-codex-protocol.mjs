// QA 1.0.11 · fase 4: modo plan y preguntas de Codex App Server SIN invocar modelos.
//
// Lanza el `codex app-server` instalado con un CODEX_HOME temporal cuyo proveedor de modelos apunta a
// una API Responses simulada en 127.0.0.1 (clave ficticia). Usa los mismos mensajes que Duovra:
// `initialize` con `experimentalApi`, `collaborationMode/list`, `thread/start` y `turn/start` con
// `collaborationMode`. Ninguna petición sale del equipo.
//
// Uso: node scripts/qa/planning-codex-protocol.mjs [carpeta-salida]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-planning-codex');
mkdirSync(out, { recursive: true });
const results = [];
const requests = [];
const PLAN = '1. Revisar `README.md`.\n2. Añadir una sección de prueba.';

// ---------- API Responses simulada ----------
const textOfInput = (input) => JSON.stringify(input ?? []);
function plan(body) {
  const raw = textOfInput(body.input);
  // El último escenario de la conversación (el hilo conserva los turnos anteriores).
  const scenario = [...raw.matchAll(/SCENARIO:([\w-]+)/g)].at(-1)?.[1] ?? null;
  const outputs = (body.input ?? []).filter((i) => i.type === 'function_call_output');
  // Instrucciones vigentes: el último mensaje de desarrollador que declara un modo de colaboración.
  const modes = (body.input ?? []).filter((i) => i.role === 'developer').map((i) => JSON.stringify(i.content))
    .filter((t) => /collaboration_mode|Plan Mode|Default mode/i.test(t));
  requests.push({ scenario, model: body.model, modeMessages: modes.length,
    planMode: modes.length ? /Plan Mode/.test(modes.at(-1)) : false, output: outputs.at(-1)?.output ?? null });
  if (scenario === 'plan') return [{ type: 'message', text: `Este es el plan.\n<proposed_plan>\n${PLAN}\n</proposed_plan>` }];
  if (scenario === 'ask' && !outputs.length) {
    return [{ type: 'function_call', name: 'request_user_input', call_id: 'call_qa_1',
      arguments: JSON.stringify({ questions: [
        { id: 'branch', header: 'Rama', question: '¿Sobre qué rama trabajo?', options: [
          { label: 'main (Recommended)', description: 'Rama principal' }, { label: 'develop', description: 'Integración' }] },
      ] }) }];
  }
  return [{ type: 'message', text: scenario ? `Fin del escenario ${scenario}.` : 'ok' }];
}

function stream(res, body) {
  const id = `resp_${Math.random().toString(16).slice(2, 12)}`;
  const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send({ type: 'response.created', response: { id, model: body.model, output: [] } });
  const items = plan(body).map((o, index) => {
    if (o.type === 'message') {
      const item = { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: o.text, annotations: [] }] };
      send({ type: 'response.output_item.added', output_index: index, item: { ...item, content: [] } });
      send({ type: 'response.output_text.delta', output_index: index, item_id: item.id, content_index: 0, delta: o.text });
      send({ type: 'response.output_item.done', output_index: index, item });
      return item;
    }
    const item = { type: 'function_call', id: `fc_${index}`, call_id: o.call_id, name: o.name, arguments: o.arguments, status: 'completed' };
    send({ type: 'response.output_item.added', output_index: index, item });
    send({ type: 'response.output_item.done', output_index: index, item });
    return item;
  });
  send({ type: 'response.completed', response: { id, model: body.model, output: items,
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } });
  res.end();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.method === 'POST' && (req.url ?? '').includes('/responses')) return stream(res, JSON.parse(raw || '{}'));
    if ((req.url ?? '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [], models: [] }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------- Codex aislado ----------
const home = mkdtempSync(join(tmpdir(), 'duovra-plan-codex-home-'));
writeFileSync(join(home, 'config.toml'), `model = "gpt-6-luna"
model_reasoning_effort = "high"
model_provider = "qa"
[model_providers.qa]
name = "QA (simulado)"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
env_key = "DUOVRA_QA_FAKE_KEY"
request_max_retries = 0
stream_max_retries = 0
`);
const project = mkdtempSync(join(tmpdir(), 'duovra-plan-codex-project-'));
writeFileSync(join(project, 'README.md'), '# Proyecto QA\n');
const env = { ...process.env, CODEX_HOME: home, DUOVRA_QA_FAKE_KEY: 'qa-not-a-real-key' };
delete env.OPENAI_API_KEY;
const child = spawn('codex', ['app-server'], { env, shell: true });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
const pending = new Map();
const notifications = [];
const serverRequests = [];
let next = 1;
let onServerRequest = null;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method && m.id !== undefined) { serverRequests.push({ method: m.method, params: m.params }); onServerRequest?.(m); return; }
  if (m.method) notifications.push({ method: m.method, params: m.params });
});
const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params, timeout = 20_000) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  write({ id, method, params });
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method}: sin respuesta`)); }, timeout);
});
const waitFor = (pred, timeout = 45_000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const found = notifications.find(pred);
    if (found) return resolve(found);
    if (Date.now() - start > timeout) return reject(new Error(`tiempo agotado · stderr: ${stderr.slice(-400)}`));
    setTimeout(tick, 100);
  };
  tick();
});
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 320) : '');
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 500));
  }
};

const init = await request('initialize', { clientInfo: { name: 'duovra', title: 'Duovra QA', version: '1.0.11' }, capabilities: { experimentalApi: true, requestAttestation: false } });
write({ method: 'initialized' });
const mode = (m) => ({ mode: m, settings: { model: 'gpt-6-luna', reasoning_effort: 'high', developer_instructions: null } });
const turn = async (thread, text, m) => {
  const before = notifications.length;
  const started = await request('turn/start', { threadId: thread, input: [{ type: 'text', text, text_elements: [] }], model: 'gpt-6-luna', effort: 'high', collaborationMode: mode(m) });
  const done = await waitFor((n, i) => i >= before && n.method === 'turn/completed' && n.params.turn?.id === started.turn.id);
  return { id: started.turn.id, events: notifications.slice(before), status: done.params.turn.status, error: done.params.turn.error };
};

await check('collaborationMode/list publica plan y default (con experimentalApi)', async () => {
  const list = await request('collaborationMode/list', {});
  const modes = list.data.map((d) => d.mode);
  assert(modes.includes('plan') && modes.includes('default'));
  return { modes, userAgent: init.userAgent };
});

let thread;
await check('thread/start en el proveedor simulado', async () => {
  const r = await request('thread/start', { model: 'gpt-6-luna', cwd: project, approvalPolicy: 'on-request', sandbox: 'read-only' });
  thread = r.thread.id;
  return { thread, model: r.model };
});

await check('turno en modo plan: elemento plan con item/plan/delta (no una lista de tareas)', async () => {
  const t = await turn(thread, 'SCENARIO:plan', 'plan');
  const deltas = t.events.filter((e) => e.method === 'item/plan/delta');
  const item = t.events.find((e) => e.method === 'item/completed' && e.params.item?.type === 'plan');
  const checklist = t.events.filter((e) => e.method === 'turn/plan/updated');
  assert.equal(t.status, 'completed', JSON.stringify(t.error));
  assert(item, `sin elemento plan · eventos: ${[...new Set(t.events.map((e) => e.method))].join(', ')}`);
  assert.equal(item.params.item.text.trim(), PLAN);
  const last = requests.filter((r) => r.scenario === 'plan').at(-1);
  return { planDeltas: deltas.length, planText: item.params.item.text.trim().slice(0, 80), checklistEvents: checklist.length,
    modelRequested: last?.model, planInstructions: last?.planMode };
});

await check('pregunta en modo plan: item/tool/requestUserInput y respuesta con la estructura de 0.169', async () => {
  onServerRequest = (m) => {
    if (m.method === 'item/tool/requestUserInput') {
      write({ id: m.id, result: { answers: { [m.params.questions[0].id]: { answers: ['develop'] } } } });
    }
  };
  const t = await turn(thread, 'SCENARIO:ask', 'plan');
  onServerRequest = null;
  const req = serverRequests.find((r) => r.method === 'item/tool/requestUserInput');
  assert(req, `sin solicitud · eventos: ${[...new Set(t.events.map((e) => e.method))].join(', ')}`);
  const sent = requests.filter((r) => r.scenario === 'ask' && r.output).at(-1);
  assert(sent && String(sent.output).includes('develop'), JSON.stringify(sent));
  writeFileSync(join(out, 'request-user-input.json'), JSON.stringify(req.params, null, 2));
  return { paramsKeys: Object.keys(req.params), question: req.params.questions[0], isBlocking: req.params.isBlocking, toolOutput: String(sent.output).slice(0, 200), status: t.status };
});

await check('turno en modo default tras el plan: las instrucciones vigentes dejan de ser las de plan', async () => {
  const t = await turn(thread, 'SCENARIO:build', 'default');
  const last = requests.filter((r) => r.scenario === 'build').at(-1);
  assert.equal(t.status, 'completed');
  assert.equal(last?.planMode, false, JSON.stringify(last));
  return { planInstructions: last?.planMode, modeMessages: last?.modeMessages };
});

child.kill();
server.close();
writeFileSync(join(out, 'planning-codex-protocol.json'), JSON.stringify({ codex: init.userAgent, api: 'simulada en 127.0.0.1', results, requests }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones · informe en ${join(out, 'planning-codex-protocol.json')}`);
process.exit(failed ? 1 : 0);

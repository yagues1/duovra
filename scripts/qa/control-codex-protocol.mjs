// QA 1.0.11 · fase 5: revisión, objetivos, intervención e interrupción de Codex App Server SIN invocar modelos.
//
// Lanza el `codex app-server` instalado con un CODEX_HOME temporal cuyo proveedor de modelos apunta a
// una API Responses simulada en 127.0.0.1 (clave ficticia). Usa los mismos mensajes que Duovra:
// `initialize` con `experimentalApi`, `collaborationMode/list`, `thread/start` y `turn/start` con
// `collaborationMode`. Ninguna petición sale del equipo.
//
// Uso: node scripts/qa/control-codex-protocol.mjs [carpeta-salida]
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-control-codex');
mkdirSync(out, { recursive: true });
const results = [];
const requests = [];
let delayMs = 0;
const PLAN = '1. Revisar `README.md`.\n2. Añadir una sección de prueba.';

// ---------- API Responses simulada ----------
const textOfInput = (input) => JSON.stringify(input ?? []);
function plan(body) {
  const raw = textOfInput(body.input);
  const scenario = [...raw.matchAll(/SCENARIO:([\w-]+)/g)].at(-1)?.[1] ?? null;
  requests.push({ scenario, model: body.model, review: /review/i.test(JSON.stringify(body.instructions ?? '')), inputTail: raw.slice(-200) });
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
    if (req.method === 'POST' && (req.url ?? '').includes('/responses')) {
      const body = JSON.parse(raw || '{}');
      return delayMs ? setTimeout(() => stream(res, body), delayMs) : stream(res, body);
    }
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
const home = mkdtempSync(join(tmpdir(), 'duovra-control-codex-home-'));
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
const project = mkdtempSync(join(tmpdir(), 'duovra-control-codex-project-'));
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

// Repositorio git con un cambio sin commit para `review/start`.
execSync('git init -q && git -c user.email=qa@duovra.invalid -c user.name=QA commit -q --allow-empty -m base', { cwd: project });
writeFileSync(join(project, 'cambio.txt'), 'cambio sin commit\n');

const init = await request('initialize', { clientInfo: { name: 'duovra', title: 'Duovra QA', version: '1.0.11' }, capabilities: { experimentalApi: true, requestAttestation: false } });
write({ method: 'initialized' });
const methodsOf = (from) => [...new Set(notifications.slice(from).map((n) => n.method))];

let thread;
await check('thread/start en el proveedor simulado', async () => {
  const r = await request('thread/start', { model: 'gpt-6-luna', cwd: project, approvalPolicy: 'never', sandbox: 'read-only' });
  thread = r.thread.id;
  return { thread };
});

await check('thread/goal/get sin objetivo', async () => request('thread/goal/get', { threadId: thread }));

await check('thread/goal/set (origin user): ¿inicia un turno por sí solo?', async () => {
  const before = notifications.length;
  const calls = requests.length;
  const r = await request('thread/goal/set', { threadId: thread, objective: 'Objetivo de prueba QA', origin: 'user' });
  await new Promise((res) => setTimeout(res, 4000));
  return { goal: r.goal, turnStarted: notifications.slice(before).some((n) => n.method === 'turn/started'),
    apiCalls: requests.length - calls, events: methodsOf(before) };
});

await check('thread/goal/set status paused y thread/goal/clear', async () => {
  const before = notifications.length;
  const paused = await request('thread/goal/set', { threadId: thread, status: 'paused', origin: 'user' });
  const cleared = await request('thread/goal/clear', { threadId: thread, origin: 'user' });
  const after = await request('thread/goal/get', { threadId: thread });
  return { paused: paused.goal?.status, cleared, after, events: methodsOf(before) };
});

await check('review/start uncommittedChanges: turno inline con enteredReviewMode/exitedReviewMode', async () => {
  const before = notifications.length;
  const r = await request('review/start', { threadId: thread, target: { type: 'uncommittedChanges' } });
  const done = await waitFor((n, i) => i >= before && n.method === 'turn/completed' && n.params.turn?.id === r.turn.id);
  const items = notifications.slice(before).filter((n) => n.method === 'item/completed').map((n) => n.params.item.type);
  writeFileSync(join(out, 'review-events.json'), JSON.stringify(notifications.slice(before), null, 2));
  return { reviewThreadId: r.reviewThreadId, sameThread: r.reviewThreadId === thread, turn: r.turn.id, status: done.params.turn.status, items };
});

await check('turn/steer con expectedTurnId incorrecto se rechaza', async () => {
  delayMs = 3000;
  const started = await request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'SCENARIO:steer', text_elements: [] }], model: 'gpt-6-luna', effort: 'high' });
  await waitFor((n) => n.method === 'turn/started' && n.params.turn?.id === started.turn.id);
  let wrong;
  try { await request('turn/steer', { threadId: thread, expectedTurnId: 'turn-inexistente', input: [{ type: 'text', text: 'x', text_elements: [] }] }); wrong = 'aceptado'; }
  catch (e) { wrong = e.message; }
  const right = await request('turn/steer', { threadId: thread, expectedTurnId: started.turn.id, input: [{ type: 'text', text: 'SCENARIO:steer-ok', text_elements: [] }] });
  const done = await waitFor((n) => n.method === 'turn/completed' && n.params.turn?.id === started.turn.id);
  delayMs = 0;
  return { wrong, rightAck: right, sameTurn: right.turnId === started.turn.id, status: done.params.turn.status };
});

await check('turn/interrupt y turno nuevo a continuación (interrumpir y continuar)', async () => {
  delayMs = 6000;
  const started = await request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'SCENARIO:largo', text_elements: [] }], model: 'gpt-6-luna', effort: 'high' });
  await waitFor((n) => n.method === 'turn/started' && n.params.turn?.id === started.turn.id);
  const t0 = Date.now();
  const ack = await request('turn/interrupt', { threadId: thread, turnId: started.turn.id });
  const done = await waitFor((n) => n.method === 'turn/completed' && n.params.turn?.id === started.turn.id);
  const waited = Date.now() - t0;
  delayMs = 0;
  const next = await request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'SCENARIO:continuar', text_elements: [] }], model: 'gpt-6-luna', effort: 'high' });
  const nextDone = await waitFor((n) => n.method === 'turn/completed' && n.params.turn?.id === next.turn.id);
  return { ack, interruptedStatus: done.params.turn.status, confirmMs: waited, nextStatus: nextDone.params.turn.status };
});

await check('thread/read: agentMessage con moderation/display', async () => {
  const r = await request('thread/read', { threadId: thread, includeTurns: true });
  const msgs = (r.thread.turns ?? []).flatMap((t) => t.items ?? []).filter((i) => i.type === 'agentMessage');
  return { agentMessages: msgs.length, keys: Object.keys(msgs[0] ?? {}), moderation: msgs.map((m) => m.moderation ?? null).slice(0, 3) };
});

child.kill();
server.close();
writeFileSync(join(out, 'control-codex-protocol.json'), JSON.stringify({ codex: init.userAgent, api: 'simulada en 127.0.0.1', results, requests }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones · ${init.userAgent} · informe en ${join(out, 'control-codex-protocol.json')}`);
process.exit(failed ? 1 : 0);

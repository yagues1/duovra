// QA 1.0.11 · fase 4: Planning & Decisions sobre la app en desarrollo (perfil QA aislado).
//
// Requisitos:
//   1. APIs simuladas: `node scripts/qa/planning-mock-apis.mjs <estado>` (escribe ports.json).
//   2. Configuraciones aisladas de las cuentas QA en <qa>/claude-config y <qa>/codex-home que apuntan a
//      esas APIs (clave ficticia). Ninguna petición sale del equipo y ningún modelo responde de verdad.
//   3. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y
//      `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json`.
//
// Uso: node scripts/qa/planning-webview.mjs <carpeta-qa> [carpeta-salida]
// Recorre Duovra con las CLIs instaladas reales (Claude Code y Codex App Server) y deja las
// conversaciones «QA · …» como datos de prueba para revisar la interfaz.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const qa = process.argv[2];
if (!qa) throw new Error('Falta la carpeta QA');
const out = process.argv[3] ?? join(qa, 'report');
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const results = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 260) : '');
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 500), String(error?.stack ?? '').split('\n').slice(1, 3).join(' '));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLog = () => {
  try { return readFileSync(join(qa, 'mock', 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const messages = async (id) => (await invoke('list_messages', { conversationId: id, includeSessions: false })).messages;
const interactions = (id) => invoke('list_interactions', { conversationId: id });
async function until(fn, what, timeout = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`tiempo agotado: ${what}`);
    await sleep(250);
  }
}
const idle = (id) => until(async () => {
  const list = await messages(id);
  return list.length && list.every((m) => m.status !== 'running') ? list : null;
}, 'fin de la ejecución', 90_000);
const plans = async (id) => (await interactions(id)).filter((i) => i.kind === 'plan');

// ---------- Preparación ----------
const dir = mkdtempSync(join(tmpdir(), 'duovra-plan-qa-project-'));
writeFileSync(join(dir, 'README.md'), '# Proyecto de prueba de QA (fase 4)\n');
const PROJECT = 'QA · Planning & Decisions (datos de prueba)';
// Una ejecución anterior del guion se sustituye: solo hay un juego de datos de prueba.
{
  const boot = await invoke('bootstrap');
  const oldProjects = boot.projects.filter((p) => p.name === PROJECT).map((p) => p.id);
  const oldConversations = new Set(boot.conversations.filter((c) => oldProjects.includes(c.projectId)).map((c) => c.id));
  for (const run of boot.activeRuns.filter((r) => oldConversations.has(r.conversationId))) await invoke('cancel_run', { runId: run.runId });
  await until(async () => !(await invoke('bootstrap')).activeRuns.some((r) => oldConversations.has(r.conversationId)), 'cancelar la QA anterior', 30_000);
  for (const id of oldProjects) await invoke('delete_project', { id });
}
const project = await invoke('create_project', { name: PROJECT, path: dir });
const accounts = {};
for (const [agent, label, sub] of [['claude', 'QA simulada · Claude Code', 'claude-config'], ['codex', 'QA simulada · Codex', 'codex-home']]) {
  const existing = (await invoke('bootstrap')).accounts.filter((a) => a.label === label && a.agent === agent);
  for (const old of existing) await invoke('remove_account', { id: old.id });
  const { accounts: list } = await invoke('add_account', { agent, label, configDir: join(qa, sub) });
  accounts[agent] = list.find((a) => a.label === label && a.agent === agent).id;
  await invoke('set_setting', { key: `accounts.active.${agent}`, value: accounts[agent] });
}
// El catálogo de la cuenta QA da al backend la resolución exacta de los alias (haiku → claude-haiku-5-5).
const catalogs = { claude: await invoke('agent_models', { agent: 'claude', refresh: true }), codex: await invoke('agent_models', { agent: 'codex', refresh: true }) };
const MODEL = { claude: 'haiku', codex: 'gpt-6-luna' };
const EFFORT = { claude: 'medium', codex: 'high' };
const PERMS = { claude: { mode: 'manual' }, codex: { sandbox: 'read-only', approval: 'on-request' } };
async function conversation(title) {
  const conv = await invoke('create_conversation', { projectId: project.id, title });
  await invoke('set_draft', { conversationId: conv.id, draft: 'qa' });
  return conv;
}
const request = (conv, agent, text, workMode = 'build', extra = {}) => ({
  conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent], text, attachments: [], speed: null,
  permissions: PERMS[agent], workMode, ...extra,
});
const submit = (req) => invoke('submit_message', { id: crypto.randomUUID(), request: req, accountId: accounts[req.agent] });

await check('catálogos de las cuentas QA (sin modelos reales)', async () => {
  const haiku = catalogs.claude.models?.find((m) => m.id === 'haiku');
  assert(haiku, 'el catálogo de Claude Code no incluye haiku');
  return { claude: { haiku: haiku.exact }, codex: catalogs.codex.models?.map((m) => m.id).slice(0, 4) ?? catalogs.codex };
});

// ---------- Modo de trabajo ----------
await check('modo de trabajo: Construir por defecto y guardado por conversación y agente', async () => {
  const conv = await conversation('QA · Selector de modo');
  const fresh = (await invoke('bootstrap')).conversations.find((c) => c.id === conv.id);
  assert.deepEqual(fresh.workModes, {});
  await invoke('set_conversation_work_mode', { conversationId: conv.id, agent: 'claude', mode: 'plan' });
  await invoke('set_conversation_permissions', { conversationId: conv.id, agent: 'claude', permissions: { mode: 'acceptEdits' } });
  const after = (await invoke('bootstrap')).conversations.find((c) => c.id === conv.id);
  assert.deepEqual(after.workModes, { claude: 'plan' });
  // El modo no cambia los permisos y los permisos no cambian el modo.
  assert.equal(after.permissionPrefs.claude.mode, 'acceptEdits');
  await assert.rejects(invoke('set_conversation_work_mode', { conversationId: conv.id, agent: 'claude', mode: 'yolo' }));
  return after.workModes;
});

// ---------- Plan nativo de Claude Code ----------
const claudePlan = await conversation('QA · Plan de Claude Code (aprobación nativa)');
await invoke('set_conversation_work_mode', { conversationId: claudePlan.id, agent: 'claude', mode: 'plan' });
let v1;
await check('Claude · modo plan nativo: tarjeta de plan con el contenido de ExitPlanMode y el modelo autorizado', async () => {
  const before = mockLog().length;
  await submit(request(claudePlan, 'claude', 'QA-PLAN Planifica una sección de QA en el README.', 'plan'));
  v1 = await until(async () => (await plans(claudePlan.id)).find((p) => p.status === 'pending'), 'plan v1');
  assert.equal(v1.version, 1);
  assert(v1.native && v1.payload.text.includes('Sección de QA'));
  const models = [...new Set(mockLog().slice(before).filter((r) => r.api === 'anthropic').map((r) => r.model))];
  assert.deepEqual(models, ['claude-haiku-5-5'], `modelos pedidos: ${models}`);
  const insights = await invoke('run_insights', { messageId: v1.messageId });
  assert.equal(insights?.details?.workMode, 'plan');
  return { version: v1.version, title: v1.payload.title, models, pending: await invoke('pending_interactions') };
});

await check('Claude · solicitar cambios: la misma ejecución recibe la petición y propone la versión 2', async () => {
  await invoke('decide_plan', { interactionId: v1.id, action: 'changes', feedback: 'Añade una comprobación de que la sección existe.', request: null });
  const v2 = await until(async () => (await plans(claudePlan.id)).find((p) => p.version === 2 && p.status === 'pending'), 'plan v2');
  const old = (await plans(claudePlan.id)).find((p) => p.id === v1.id);
  assert.equal(old.status, 'changes_requested');
  assert.equal(old.response.feedback, 'Añade una comprobación de que la sección existe.');
  assert.equal(v2.messageId, v1.messageId);
  await assert.rejects(invoke('decide_plan', { interactionId: v1.id, action: 'approve', feedback: null, request: null }));
  return { v2: v2.payload.title };
});

await check('Claude · aprobar e implementar con el mismo agente: continúa en la misma ejecución y conserva la versión', async () => {
  const v2 = (await plans(claudePlan.id)).find((p) => p.version === 2);
  const r = await invoke('decide_plan', { interactionId: v2.id, action: 'approve', feedback: null, request: null });
  assert.equal(r.mode, 'native');
  const list = await idle(claudePlan.id);
  const approved = (await plans(claudePlan.id)).find((p) => p.id === v2.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.response.version, 2);
  assert(list.at(-1).content.includes('Implementación simulada'));
  await assert.rejects(invoke('decide_plan', { interactionId: v2.id, action: 'approve', feedback: null, request: null }));
  const conv = (await invoke('bootstrap')).conversations.find((c) => c.id === claudePlan.id);
  return { status: list.at(-1).status, permissions: conv.permissionPrefs ?? {}, mirrored: list.at(-1).items.filter((i) => i.kind === 'plan_proposal').map((i) => i.decision) };
});

// ---------- Rechazo ----------
await check('Claude · rechazar: el plan queda rechazado y el agente no lo implementa', async () => {
  const conv = await conversation('QA · Plan rechazado');
  await submit(request(conv, 'claude', 'QA-PLAN Planifica algo que vas a rechazar.', 'plan'));
  const plan = await until(async () => (await plans(conv.id)).find((p) => p.status === 'pending'), 'plan');
  await invoke('decide_plan', { interactionId: plan.id, action: 'reject', feedback: null, request: null });
  const list = await idle(conv.id);
  assert.equal((await plans(conv.id))[0].status, 'rejected');
  assert(!list.at(-1).content.includes('Implementación simulada'));
  return { status: list.at(-1).status };
});

// ---------- Plan de Codex → implementa Claude Code ----------
const codexPlan = await conversation('QA · Plan de Codex → implementa Claude Code');
await invoke('set_conversation_work_mode', { conversationId: codexPlan.id, agent: 'codex', mode: 'plan' });
await check('Codex · collaborationMode plan: el elemento plan es una tarjeta pendiente (sin solicitud nativa)', async () => {
  await submit(request(codexPlan, 'codex', 'QA-PLAN Planifica una sección de QA en el README.', 'plan'));
  await idle(codexPlan.id);
  const plan = await until(async () => (await plans(codexPlan.id)).find((p) => p.status === 'pending'), 'plan de Codex');
  assert(!plan.native && plan.payload.text.includes('Sección de QA'));
  const last = mockLog().filter((r) => r.api === 'responses').at(-1);
  assert(last.planMode && last.model === 'gpt-6-luna');
  return { version: plan.version, model: last.model };
});

await check('Codex · solicitar cambios: turno nuevo en modo plan con la petición; versión 2', async () => {
  const plan = (await plans(codexPlan.id)).find((p) => p.status === 'pending');
  const req = request(codexPlan, 'codex', 'Añade una comprobación de que la sección existe.', 'plan');
  const r = await invoke('decide_plan', { interactionId: plan.id, action: 'changes', feedback: 'Añade una comprobación de que la sección existe.', request: req });
  assert.equal(r.mode, 'started');
  await idle(codexPlan.id);
  const v2 = await until(async () => (await plans(codexPlan.id)).find((p) => p.version === 2), 'v2');
  return { v1: (await plans(codexPlan.id)).find((p) => p.version === 1).status, v2: v2.status };
});

await check('Codex → Claude · aprobar con el otro agente: la versión exacta viaja por Context Engine y no se trasladan permisos', async () => {
  const v2 = (await plans(codexPlan.id)).find((p) => p.version === 2);
  const before = mockLog().length;
  const req = request(codexPlan, 'claude', 'Implementa el plan aprobado (versión 2).', 'build');
  const r = await invoke('decide_plan', { interactionId: v2.id, action: 'approve', feedback: null, request: req });
  assert.equal(r.mode, 'started');
  const list = await idle(codexPlan.id);
  const sent = mockLog().slice(before).filter((x) => x.api === 'anthropic');
  assert(sent.some((x) => x.approvedPlan === '2'), JSON.stringify(sent));
  const user = list.filter((m) => m.role === 'user').at(-1);
  assert.deepEqual(user.contextNote.approvedPlan, { id: v2.id, version: 2, agent: 'codex' });
  const approved = (await plans(codexPlan.id)).find((p) => p.id === v2.id);
  assert.equal(approved.response.agent, 'claude');
  // Nada se lanzó en Codex después de la aprobación.
  assert(!mockLog().slice(before).some((x) => x.api === 'responses'));
  return { assistant: list.at(-1).agent, status: list.at(-1).status, models: [...new Set(sent.map((x) => x.model))] };
});

// ---------- Preguntas de Claude Code ----------
await check('Claude · AskUserQuestion: pregunta individual y múltiple, validación y respuesta personalizada', async () => {
  const conv = await conversation('QA · Preguntas de Claude Code');
  await submit(request(conv, 'claude', 'QA-ASK Necesito decisiones antes de seguir.'));
  const q = await until(async () => (await interactions(conv.id)).find((i) => i.kind === 'question' && i.status === 'pending'), 'pregunta');
  assert.deepEqual(q.payload.questions.map((x) => x.multiSelect), [false, true]);
  await assert.rejects(invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['SQLite (Recommended)', 'Postgres'] }, { selected: ['Tests'] }] }));
  await assert.rejects(invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['MySQL'] }, { selected: ['Tests'] }] }));
  await invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['SQLite (Recommended)'] }, { selected: ['Tests', 'Lint'], custom: 'Revisión manual' }] });
  await assert.rejects(invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['Postgres'] }, { selected: ['Build'] }] }));
  const list = await idle(conv.id);
  assert(list.at(-1).content.includes('Revisión manual'), list.at(-1).content);
  const saved = (await interactions(conv.id))[0];
  assert.equal(saved.status, 'answered');
  return { answers: saved.response.answers, reply: list.at(-1).content.slice(0, 160) };
});

// ---------- Preguntas de Codex ----------
await check('Codex · requestUserInput: respuesta con «Otra» y pregunta secreta que no se guarda', async () => {
  const conv = await conversation('QA · Preguntas de Codex');
  await invoke('set_conversation_work_mode', { conversationId: conv.id, agent: 'codex', mode: 'plan' });
  await submit(request(conv, 'codex', 'QA-ASK Necesito decisiones antes de planificar.', 'plan'));
  const q = await until(async () => (await interactions(conv.id)).find((i) => i.kind === 'question' && i.status === 'pending'), 'pregunta de Codex');
  assert.deepEqual(q.payload.questions.map((x) => x.secret), [false, true]);
  assert(q.payload.questions.every((x) => x.custom), 'Codex marca isOther en ambas');
  await invoke('answer_question', { interactionId: q.id, answers: [{ selected: [], custom: 'feature/qa' }, { selected: [], custom: 'clave-de-prueba-123' }] });
  await idle(conv.id);
  const sent = mockLog().filter((r) => r.api === 'responses' && r.output).at(-1);
  assert(sent.output.includes('feature/qa') && sent.output.includes('clave-de-prueba-123'), JSON.stringify(sent));
  const saved = (await interactions(conv.id)).find((i) => i.id === q.id);
  assert.equal(saved.response.answers[1].custom, '••••');
  const items = (await messages(conv.id)).flatMap((m) => m.items ?? []);
  assert(!JSON.stringify(items).includes('clave-de-prueba-123'));
  return { stored: saved.response.answers };
});

// ---------- Cancelación y aislamiento ----------
await check('cancelación: la pregunta pendiente se cierra como cancelada y no se puede responder', async () => {
  const conv = await conversation('QA · Cancelación con pregunta');
  const started = await submit(request(conv, 'claude', 'QA-WAIT Pregunta y espera.'));
  const q = await until(async () => (await interactions(conv.id)).find((i) => i.kind === 'question' && i.status === 'pending'), 'pregunta');
  await invoke('cancel_run', { runId: started.started.runId });
  await idle(conv.id);
  const saved = (await interactions(conv.id)).find((i) => i.id === q.id);
  assert.equal(saved.status, 'cancelled');
  await assert.rejects(invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['Postgres'] }, { selected: ['Build'] }] }));
  return { status: saved.status };
});

await check('aislamiento: dos conversaciones con preguntas pendientes; responder una no toca la otra', async () => {
  const a = await conversation('QA · Pregunta pendiente A');
  const b = await conversation('QA · Pregunta pendiente B');
  await submit(request(a, 'claude', 'QA-WAIT Pregunta A.'));
  await submit(request(b, 'claude', 'QA-WAIT Pregunta B.'));
  const qa1 = await until(async () => (await interactions(a.id)).find((i) => i.status === 'pending'), 'A');
  const qb = await until(async () => (await interactions(b.id)).find((i) => i.status === 'pending'), 'B');
  assert.notEqual(qa1.runId, qb.runId);
  const pending = await invoke('pending_interactions');
  assert(pending.some((p) => p.conversationId === a.id) && pending.some((p) => p.conversationId === b.id));
  await invoke('answer_question', { interactionId: qa1.id, answers: [{ selected: ['Postgres'] }, { selected: ['Build'] }] });
  await idle(a.id);
  assert.equal((await interactions(b.id)).find((i) => i.id === qb.id).status, 'pending');
  assert.equal((await interactions(a.id)).find((i) => i.id === qa1.id).status, 'answered');
  return { pendingAfter: (await invoke('pending_interactions')).filter((p) => [a.id, b.id].includes(p.conversationId)) };
});

// ---------- Bifurcación ----------
await check('bifurcación: hereda planes y decisiones como historial, nunca solicitudes activas', async () => {
  const conv = await conversation('QA · Plan de Codex pendiente (bifurcable)');
  await invoke('set_conversation_work_mode', { conversationId: conv.id, agent: 'codex', mode: 'plan' });
  await submit(request(conv, 'codex', 'QA-PLAN Plan que queda pendiente.', 'plan'));
  await idle(conv.id);
  const plan = await until(async () => (await plans(conv.id)).find((p) => p.status === 'pending'), 'plan');
  const last = (await messages(conv.id)).at(-1);
  const fork = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: last.id, purpose: 'fork' } });
  const copied = await interactions(fork.id);
  assert.equal(copied.length, 1);
  assert.equal(copied[0].status, 'historical');
  assert.notEqual(copied[0].id, plan.id);
  await assert.rejects(invoke('decide_plan', { interactionId: copied[0].id, action: 'approve', feedback: null, request: request(fork, 'codex', 'x') }));
  assert.equal((await plans(conv.id))[0].status, 'pending');
  const approvedFork = await invoke('fork_conversation', { request: { conversationId: claudePlan.id, messageId: (await messages(claudePlan.id)).at(-1).id, purpose: 'fork' } });
  const inherited = await interactions(approvedFork.id);
  return { pendingCopy: copied[0].status, inherited: inherited.map((i) => `${i.kind} v${i.version} ${i.status}`) };
});

// ---------- Demostración visual (datos de prueba) ----------
await check('datos de prueba para revisión visual', async () => {
  const long = await conversation('QA · Plan largo de Claude Code (pendiente)');
  await invoke('set_conversation_work_mode', { conversationId: long.id, agent: 'claude', mode: 'plan' });
  await submit(request(long, 'claude', 'QA-LONGPLAN Propón un plan largo para revisar la tarjeta.', 'plan'));
  await until(async () => (await plans(long.id)).find((p) => p.status === 'pending'), 'plan largo');
  return { pending: await invoke('pending_interactions') };
});

writeFileSync(join(out, 'planning-webview.json'), JSON.stringify({ project: project.id, accounts, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones · informe en ${join(out, 'planning-webview.json')}`);
await browser.close();
process.exit(failed ? 1 : 0);

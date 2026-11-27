// QA 1.0.11 · fase 6: Activity Center, tareas y subagentes
// sobre la app en desarrollo (perfil QA aislado). Ningún modelo real: CLIs instaladas contra APIs simuladas.
//
// Requisitos (los mismos que la fase 5):
//   1. `node scripts/qa/control-mock-apis.mjs <qa>/mock-fase6 53396 53397`.
//   2. <qa>/claude-config y <qa>/codex-home apuntando a esos puertos (clave ficticia).
//   3. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y
//      `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json` (sin variables CLAUDE_*/ANTHROPIC_*).
//
// Uso: node scripts/qa/activity-webview.mjs <carpeta-qa> [carpeta-salida] [--resume-visual] [--review-activity | --review-tasks]
// Deja el proyecto «QA · Activity & Instructions (datos de prueba)» con ejemplos para revisar.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { parseActivityArgs, assertTaskRejections } from './activity-qa-helpers.mjs';

const { qa, out, resumeVisual, reviewActivity, reviewTasks } = parseActivityArgs(process.argv.slice(2));
const mockDir = join(qa, 'mock-fase6');
if (!resumeVisual) rmSync(join(out, 'shots'), { recursive: true, force: true });
mkdirSync(join(out, 'shots'), { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const results = [];
const report = () => {
  const requests = mockLog().slice(runStart);
  writeFileSync(join(out, 'activity-webview.json'), JSON.stringify({
    resumeVisual, reviewTasks, results, pageErrors, mockRequests: requests.length,
    apis: [...new Set(requests.map((r) => r.api))], realModelCalls: 0,
  }, null, 2));
};
const check = async (name, fn) => {
  if (reviewActivity && ![
    'Activity Center: ejecuciones simultáneas, espera, navegación y detener',
    'subagentes: al detener, el estado final desconocido no se marca como completado',
    '/status abre el Activity Center',
  ].includes(name)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 300) : '');
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 600));
    await page.screenshot({ path: join(out, 'shots', `fallo-${results.length}.png`) }).catch(() => {});
  }
  report();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLog = () => {
  try { return readFileSync(join(mockDir, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const runStart = mockLog().length;
const messages = async (id) => (await invoke('list_messages', { conversationId: id, includeSessions: false })).messages;
async function until(fn, what, timeout = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`tiempo agotado: ${what}`);
    await sleep(200);
  }
}
const expectedTurns = new Map();
const idle = (id) => until(async () => {
  const list = await messages(id);
  const expected = expectedTurns.get(id);
  return list.some((m) => m.id === expected && m.status !== 'running') &&
    !(await invoke('bootstrap')).activeRuns.some((r) => r.conversationId === id) ? list : null;
}, 'fin de la ejecución', 90_000);
const shot = (name, target) => (target ?? page).screenshot({ path: join(out, 'shots', `${name}.png`) }).catch(() => {});

// ---------- Preparación (datos de prueba) ----------
const PROJECT = 'QA · Activity & Instructions (datos de prueba)';
let dir, project, convs;
const accounts = {};
const MODEL = { claude: 'haiku', codex: 'gpt-6-luna' };
const EFFORT = { claude: 'medium', codex: 'high' };
const PERMS = { claude: { mode: 'manual' }, codex: { sandbox: 'read-only', approval: 'never' } };
const titles = {
  claude: 'QA · Instrucciones (Claude Code)', codex: 'QA · Instrucciones (Codex)',
  tasks: 'QA · Tareas (Claude Code)', codexTasks: 'QA · Tareas (Codex)',
  agents: 'QA · Subagentes (Claude Code)', agentsSlow: 'QA · Subagente detenido (Claude Code)',
  codexAgents: 'QA · Subagentes (Codex)', slow: 'QA · Ejecución larga', wait: 'QA · Pregunta pendiente',
};
const request = (conv, agent, text) => ({ conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent], text, attachments: [], speed: null, permissions: PERMS[agent] });
const submit = async (conv, agent, text) => {
  const result = await invoke('submit_message', { id: crypto.randomUUID(), request: request(conv, agent, text), accountId: accounts[agent] });
  assert.equal(result.mode, 'started', `El turno QA quedó en cola: ${conv.title}`);
  expectedTurns.set(conv.id, result.started.assistantMessage.id);
  await invoke('set_draft', { conversationId: conv.id, draft: '' });
  return result.started;
};
async function verifyTaskRejections(taskConvs) {
  const from = mockLog().length;
  const runIds = { claude: crypto.randomUUID(), codex: crypto.randomUUID() };
  const claudeTurn = await submit(taskConvs.tasks, 'claude', `QA-TASKS qa-run:${runIds.claude} organiza el trabajo de prueba.`);
  const codexTurn = await submit(taskConvs.codexTasks, 'codex', `QA-TASKS qa-run:${runIds.codex} organiza el trabajo de prueba en Codex.`);
  const claude = await idle(taskConvs.tasks.id);
  const codex = await idle(taskConvs.codexTasks.id);
  const plansOf = async (list, turn) => {
    const id = turn.assistantMessage.id;
    assert.equal(list.find((m) => m.id === id)?.status, 'done', `Turno QA no completado: ${id}`);
    return (await invoke('run_insights', { messageId: id }))?.details?.plans ?? [];
  };
  const cp = await plansOf(claude, claudeTurn);
  const xp = await plansOf(codex, codexTurn);
  assert.equal(cp.length, 0, `Claude: ${JSON.stringify(cp)}`);
  assert.equal(xp.length, 0, `Codex: ${JSON.stringify(xp)}`);
  const detail = assertTaskRejections(mockLog().slice(from), runIds);
  return { claudePlans: cp.length, codexPlans: xp.length, ...detail };
}
if (!resumeVisual) {
dir = mkdtempSync(join(tmpdir(), 'duovra-activity-qa-project-'));
writeFileSync(join(dir, 'README.md'), '# Proyecto de prueba de QA (fase 6)\n');
writeFileSync(join(dir, 'CLAUDE.md'), '# Instrucciones de prueba para Claude Code (QA)\n');
writeFileSync(join(dir, 'CLAUDE.local.md'), 'Notas locales de prueba (QA).\n');
writeFileSync(join(dir, 'AGENTS.md'), '# Instrucciones de prueba para Codex (QA)\n');
mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
writeFileSync(join(dir, '.claude', 'rules', 'estilo.md'), 'Regla de estilo de prueba (QA).\n');
mkdirSync(join(dir, 'paquete'), { recursive: true });
writeFileSync(join(dir, 'paquete', 'AGENTS.md'), 'Instrucciones de una carpeta (QA).\n');
execSync('git init -q && git add . && git -c user.email=qa@duovra.invalid -c user.name=QA commit -q -m "base de QA"', { cwd: dir });
{
  const boot = await invoke('bootstrap');
  const old = boot.projects.filter((p) => p.name === PROJECT).map((p) => p.id);
  const convs = new Set(boot.conversations.filter((c) => old.includes(c.projectId)).map((c) => c.id));
  for (const run of boot.activeRuns.filter((r) => convs.has(r.conversationId))) await invoke('cancel_run', { runId: run.runId }).catch(() => {});
  for (const id of old) await invoke('delete_project', { id }).catch(() => {});
}
project = await invoke('create_project', { name: PROJECT, path: dir });
for (const [agent, label, sub] of [['claude', 'QA simulada · Claude Code', 'claude-config'], ['codex', 'QA simulada · Codex', 'codex-home']]) {
  for (const old of (await invoke('bootstrap')).accounts.filter((a) => a.label === label && a.agent === agent)) await invoke('remove_account', { id: old.id });
  const { accounts: list } = await invoke('add_account', { agent, label, configDir: join(qa, sub) });
  accounts[agent] = list.find((a) => a.label === label && a.agent === agent).id;
  await invoke('set_setting', { key: `accounts.active.${agent}`, value: accounts[agent] });
}
await invoke('agent_models', { agent: 'claude', refresh: true });
await invoke('agent_models', { agent: 'codex', refresh: true });
await invoke('set_setting', { key: 'context.enabled', value: true });
async function conversation(title, agent) {
  const conv = await invoke('create_conversation', { projectId: project.id, title });
  await invoke('set_conversation_prefs', { conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent] });
  await invoke('set_conversation_permissions', { conversationId: conv.id, agent, permissions: PERMS[agent] });
  // bootstrap limpia chats vacíos incluso cuando lo usamos para consultar ejecuciones.
  // Conserva el chat provisional hasta que su primer turno esté registrado.
  await invoke('set_draft', { conversationId: conv.id, draft: 'Preparación QA (borrador temporal)' });
  return conv;
}

convs = {
  claude: await conversation('QA · Instrucciones (Claude Code)', 'claude'),
  codex: await conversation('QA · Instrucciones (Codex)', 'codex'),
  tasks: await conversation('QA · Tareas (Claude Code)', 'claude'),
  codexTasks: await conversation('QA · Tareas (Codex)', 'codex'),
  agents: await conversation('QA · Subagentes (Claude Code)', 'claude'),
  agentsSlow: await conversation('QA · Subagente detenido (Claude Code)', 'claude'),
  codexAgents: await conversation('QA · Subagentes (Codex)', 'codex'),
  slow: await conversation('QA · Ejecución larga', 'claude'),
  wait: await conversation('QA · Pregunta pendiente', 'claude'),
};
const persisted = (await invoke('bootstrap')).conversations;
for (const conv of Object.values(convs)) {
  assert.ok(persisted.some((c) => c.id === conv.id && c.projectId === project.id && c.title === conv.title), `Conversación QA no persistida: ${conv.title}`);
}

// Mantener los chats al recargar (API simulada).
for (const key of Object.keys(convs)) {
  const agent = ['codex', 'codexTasks', 'codexAgents'].includes(key) ? 'codex' : 'claude';
  await submit(convs[key], agent, 'Hola, conversación de prueba de QA.');
  await idle(convs[key].id);
}


} else {
  const boot = await invoke('bootstrap');
  project = boot.projects.find((p) => p.name === PROJECT);
  assert.ok(project, 'No existe el proyecto QA que se pretende reanudar');
  dir = project.path;
  convs = Object.fromEntries(Object.entries(titles).map(([key, title]) => {
    const conv = boot.conversations.find((c) => c.projectId === project.id && c.title === title);
    assert.ok(conv, `No existe la conversación QA: ${title}`);
    return [key, conv];
  }));
  for (const [agent, label] of [['claude', 'QA simulada · Claude Code'], ['codex', 'QA simulada · Codex']]) {
    const account = boot.accounts.find((a) => a.agent === agent && a.label === label);
    assert.ok(account, `Falta la cuenta simulada: ${agent}`);
    accounts[agent] = account.id;
    assert.equal(boot.settings[`accounts.active.${agent}`], account.id);
  }
}

// ---------- Interfaz ----------
// Regresión dirigida: no modifica los chats ni los fixtures de la entrega visual.
// Se reutilizan las mismas dos conversaciones temporales y sus sesiones nativas.
if (reviewTasks) {
  const temporary = {};
  try {
    for (const [key, agent] of [['tasks', 'claude'], ['codexTasks', 'codex']]) {
      const conv = await invoke('create_conversation', { projectId: project.id, title: `QA temporal · Regresión de tareas (${agent})` });
      temporary[key] = conv;
      await invoke('set_draft', { conversationId: conv.id, draft: 'Preparación QA temporal' });
      await invoke('set_conversation_prefs', { conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent] });
      await invoke('set_conversation_permissions', { conversationId: conv.id, agent, permissions: PERMS[agent] });
    }
    const nativeSessions = async () => Object.fromEntries(await Promise.all(Object.entries(temporary).map(async ([key, conv]) => {
      const { sessions } = await invoke('list_messages', { conversationId: conv.id, includeSessions: true });
      return [key, sessions];
    })));
    const first = await nativeSessions();
    assert.ok(Object.values(first).every((sessions) => sessions.length === 0), 'Las conversaciones nuevas ya tienen sesiones');
    await check('tareas: rechazos de turnos nuevos', () => verifyTaskRejections(temporary));
    const prior = await nativeSessions();
    await check('tareas: rechazos de turnos reanudados', async () => {
      assert.ok(Object.values(prior).every((sessions) => sessions.length > 0), 'Faltan sesiones nativas previas');
      const detail = await verifyTaskRejections(temporary);
      const after = await nativeSessions();
      for (const key of Object.keys(temporary)) {
        const before = prior[key][0];
        const resumed = after[key].find((s) => s.sessionId === before.sessionId && s.agent === before.agent && s.accountId === before.accountId);
        assert.ok(resumed && resumed.lastSeq > before.lastSeq, `No se reanudó la sesión nativa: ${key}`);
      }
      return { ...detail, sessions: Object.fromEntries(Object.keys(temporary).map((key) => [key, { sameSession: true, beforeSeq: prior[key][0].lastSeq, afterSeq: after[key].find((s) => s.sessionId === prior[key][0].sessionId).lastSeq }])) };
    });
  } finally {
    for (const conv of Object.values(temporary)) {
      const active = (await invoke('bootstrap')).activeRuns.find((r) => r.conversationId === conv.id);
      if (active) {
        await invoke('cancel_run', { runId: active.runId });
        await until(async () => !(await invoke('bootstrap')).activeRuns.some((r) => r.conversationId === conv.id), 'cierre de la conversación temporal');
      }
      await invoke('delete_conversation', { id: conv.id });
    }
  }
  report();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones dirigidas · errores de página: ${pageErrors.length}`);
  await browser.close();
  process.exit(results.length === 2 && results.every((r) => r.ok) && !pageErrors.length ? 0 : 1);
}
async function readyUI() {
  await page.waitForFunction(async (id) => {
    const { useStore } = await import('/src/state/store.ts');
    const s = useStore.getState();
    if (s.bootError) throw new Error(s.bootError);
    return s.ready && s.projects.some((p) => p.id === id);
  }, project.id);
  const expand = page.getByRole('button', { name: 'Mostrar barra lateral', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.tree-project', { hasText: 'QA · Activity & Instructions' }).first().waitFor();
}
if (!resumeVisual) await page.reload();
await readyUI();
async function open(conv) {
  // Cierra cualquier superficie flotante que haya quedado abierta (Activity Center, selectores).
  for (let i = 0; i < 3 && await page.locator('.activity-center, dialog[open]').first().isVisible().catch(() => false); i++) {
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  const row = page.locator('.tree-conv', { hasText: conv.title }).first();
  if (!(await row.isVisible().catch(() => false))) await page.locator('.tree-project', { hasText: 'QA · Activity & Instructions' }).first().click();
  await page.locator('.tree-conv', { hasText: conv.title }).first().click();
  await page.locator('.composer-input').waitFor();
  const latest = (await messages(conv.id)).at(-1);
  await page.waitForFunction(async ({ id, messageId }) => {
    const { useStore } = await import('/src/state/store.ts');
    const s = useStore.getState();
    return s.activeConversationId === id && s.messages[id]?.some((m) => m.id === messageId) && !!s.queues[id];
  }, { id: conv.id, messageId: latest.id });
}
const input = () => page.locator('.composer-input');
async function sendLive(conv, text) {
  await open(conv);
  const previous = new Set((await messages(conv.id)).map((m) => m.id));
  await page.waitForFunction(async ({ id, accountId }) => {
    const { useStore, canDispatch } = await import('/src/state/store.ts');
    const s = useStore.getState();
    const prefs = s.prefs[id];
    return prefs?.agent === 'claude' && s.settings['accounts.active.claude'] === accountId && canDispatch(prefs, s.catalogs.claude);
  }, { id: conv.id, accountId: accounts.claude });
  const sent = await page.evaluate(async ({ id, text, accountId, model, effort }) => {
    const { useStore } = await import('/src/state/store.ts');
    const s = useStore.getState();
    if (s.settings['accounts.active.claude'] !== accountId || s.prefs[id]?.agent !== 'claude' || s.prefs[id].model !== model || s.prefs[id].effort !== effort) throw new Error('Selección QA no coincide con la cuenta y el modelo esperados');
    return s.send(id, text, []);
  }, { id: conv.id, text, accountId: accounts.claude, model: MODEL.claude, effort: EFFORT.claude });
  assert.equal(sent, true, `No se pudo enviar desde el store: ${conv.title}`);
  const assistant = await until(async () => (await messages(conv.id)).find((m) => m.role === 'assistant' && !previous.has(m.id)), 'turno nuevo', 10000);
  expectedTurns.set(conv.id, assistant.id);
}

await check('tareas: sin tareas ficticias cuando el proveedor rechaza sus herramientas de planificación', async () => {
  // Claude Code 2.1.325 en -p rechaza TodoWrite/TaskCreate/TaskUpdate («disabled for this session») y Codex
  // 0.172 con el proveedor simulado no ofrece herramientas (`tools: []`, «unsupported call: update_plan»).
  // Duovra no inventa tareas a partir de llamadas rechazadas ni del texto del agente.
  return verifyTaskRejections(convs);
});

// Dato de prueba inyectado en SQLite (no procede del proveedor) para revisar la interfaz de progreso.
await check('Workbench · Actividad: plan de prueba inyectado (marcado como dato de QA)', async () => {
  const list = await messages(convs.codexTasks.id);
  const id = list.findLast((m) => m.role === 'assistant').id;
  const steps = (states) => ['Leer README.md', 'Añadir la sección QA', 'Revisar el resultado'].map((title, i) => ({ title, status: states[i] }));
  const plans = [
    { source: 'Codex · turn/plan/updated', explanation: 'Plan inyectado por la QA (dato de prueba, no del proveedor)', tasks: steps(['completed', 'running', 'pending']), receivedAt: Date.now() - 2000 },
    { source: 'Codex · turn/plan/updated', explanation: 'Plan inyectado por la QA (dato de prueba, no del proveedor)', tasks: steps(['completed', 'completed', 'running']), receivedAt: Date.now() },
  ];
  const db = join(process.env.APPDATA, 'dev.duovra.studio.qa.agents', 'studio.sqlite3');
  const py = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1]);c.execute("UPDATE run_insights SET details=json_set(details,'$.plans',json(?)) WHERE message_id=?",(open(sys.argv[3],encoding='utf-8').read(),sys.argv[2]));c.commit();print(c.total_changes)`;
  const file = join(out, 'inject-plan.py');
  writeFileSync(file, py);
  writeFileSync(join(out, 'inject-plan.json'), JSON.stringify(plans));
  const changed = execSync(`python "${file}" "${db}" "${id}" "${join(out, 'inject-plan.json')}"`).toString().trim();
  assert.equal(changed, '1');
  assert.deepEqual((await invoke('run_insights', { messageId: id })).details.plans, plans);
  return { messageId: id };
});

await check('Workbench · Actividad: barra de progreso solo con total conocido (Codex)', async () => {
  await open(convs.codexTasks);
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts');
    useStore.getState().openPanel();
    useStore.getState().setActiveTab(null);
  });
  await page.locator('.activity-panel .insight-progress').first().waitFor({ timeout: 10_000 });
  const label = await page.locator('.activity-panel .insight-caption [role="status"]').first().textContent();
  const now = await page.locator('.activity-panel .insight-progress').first().getAttribute('aria-valuenow');
  assert.equal(now, '2');
  assert.equal(await page.locator('.activity-panel .insight-progress').first().getAttribute('aria-valuemax'), '3');
  assert.match(await page.locator('.activity-panel').innerText(), /Plan inyectado por la QA/);
  await shot('workbench-tareas-codex');
  // En el chat solo queda la última actualización del plan (los turn/plan/updated no crean tarjetas).
  return { label, valueNow: now };
});

await check('subagentes: Claude Code (Agent) con resultado y estado final', async () => {
  await submit(convs.agents, 'claude', 'QA-AGENT revisa el README con un subagente.');
  const list = await idle(convs.agents.id);
  const ins = await invoke('run_insights', { messageId: list.findLast((m) => m.role === 'assistant').id });
  const workers = Object.values(ins?.details?.subagents ?? {});
  assert.ok(workers.length >= 1, JSON.stringify(ins?.details));
  assert.ok(workers.some((w) => w.status === 'completed'), JSON.stringify(workers));
  await open(convs.agents);
  await input().fill('/tasks');
  await input().press('Enter');
  await page.locator('.activity-panel .insight-worker[data-outcome="completed"]').first().waitFor();
  await shot('subagente-finalizado');
  return workers.map((w) => ({ role: w.role, status: w.status, result: w.result?.slice(0, 80), tools: w.tools, model: w.model, totalTokens: w.totalTokens }));
});

await check('subagentes: Codex (spawn_agent) según la instalación', async () => {
  await submit(convs.codexAgents, 'codex', 'QA-AGENT delega en un subagente.');
  const list = await idle(convs.codexAgents.id);
  const last = list.findLast((m) => m.role === 'assistant');
  const ins = await invoke('run_insights', { messageId: last.id });
  return { subagents: Object.values(ins?.details?.subagents ?? {}), answer: last.content.slice(0, 220) };
});

await check('Activity Center: ejecuciones simultáneas, espera, navegación y detener', async () => {
  // Los envíos directos por IPC no notifican "started": el compositor registra el resultado
  // en el store. Usar el mismo flujo del frontend para comprobar las ejecuciones activas.
  const from = mockLog().length;
  await sendLive(convs.slow, 'QA-VERYSLOW trabajo largo de prueba.');
  const previousPending = reviewActivity && (await invoke('list_interactions', { conversationId: convs.wait.id })).some((i) => i.kind === 'question' && i.status === 'pending');
  if (!previousPending) await sendLive(convs.wait, 'QA-WAIT necesito una respuesta.');
  await sendLive(convs.agentsSlow, 'QA-AGENTSLOW subagente lento.');
  await until(() => mockLog().slice(from).some((r) => r.api === 'anthropic' && r.scenario === 'QA-SUBSLOW'), 'petición local del subagente lento', 35000);
  await until(async () => {
    const active = (await invoke('bootstrap')).activeRuns;
    return [convs.slow, convs.agentsSlow].every((c) => active.some((r) => r.conversationId === c.id));
  }, 'dos ejecuciones activas');
  const pending = await until(async () => {
    const interactions = await invoke('list_interactions', { conversationId: convs.wait.id });
    return interactions.find((i) => i.status === 'pending' && i.kind === 'question');
  }, 'pregunta realmente pendiente', 15000);
  await open(convs.claude);
  const button = page.locator('.side-foot [data-activity-center]');
  await until(async () => (await button.locator('.activity-count').textContent()) === '3', 'tres ejecuciones o esperas', 10000);
  const badge = await button.locator('.activity-count').textContent();
  assert.equal(badge, '3');
  await button.click();
  const center = page.locator('.activity-center');
  await center.waitFor();
  for (const c of [convs.slow, convs.agentsSlow]) await center.locator('.ac-row', { hasText: c.title }).locator('.ac-stop').waitFor({ timeout: 10000 });
  await center.locator('.ac-row[data-status="answer"]', { hasText: convs.wait.title }).waitFor({ timeout: 10000 });
  const layout = await center.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const controls = [...el.querySelectorAll('.ac-stop, .ac-status')];
    return { width: el.clientWidth, scrollWidth: el.scrollWidth, visibleControls: controls.every((c) => {
      const rect = c.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.left + el.clientWidth + 1;
    }) };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1 && layout.visibleControls, JSON.stringify(layout));
  const rows = await center.locator('.ac-row').evaluateAll((els) => els.map((e) => ({ status: e.dataset.status, title: e.querySelector('strong')?.textContent })));
  const progress = await center.locator('.ac-progress[role="progressbar"]').count();
  await shot('activity-center');
  // Navegar a la conversación que espera respuesta.
  await center.locator('.ac-row', { hasText: 'QA · Pregunta pendiente' }).locator('.ac-main').click();
  await until(async () => (await page.locator('#conversation-title').textContent().catch(() => ''))?.includes('Pregunta pendiente'), 'navegación', 5000);
  // Detener la ejecución larga desde el Activity Center (misma acción que «Detener»).
  await button.click();
  await center.locator('.ac-row', { hasText: 'QA · Ejecución larga' }).locator('.ac-stop').click();
  const stopped = await idle(convs.slow.id);
  assert.equal(stopped.find((m) => m.id === expectedTurns.get(convs.slow.id)).status, 'cancelled');
  await until(async () => (await center.locator('.ac-row', { hasText: 'QA · Ejecución larga' }).getAttribute('data-status')) === 'cancelled', 'estado detenido', 10_000);
  await shot('activity-center-detenido');
  await page.keyboard.press('Escape');
  return { badge, rows, progress, pending: pending.id, layout };
});

await check('subagentes: al detener, el estado final desconocido no se marca como completado', async () => {
  const conv = convs.agentsSlow;
  const list = await messages(conv.id);
  await until(async () => {
    const ins = await invoke('run_insights', { messageId: expectedTurns.get(conv.id) });
    return Object.values(ins?.details?.subagents ?? {}).some((w) => w.status === 'running' || !w.status);
  }, 'subagente registrado en curso', 15000);
  const run = (await invoke('bootstrap')).activeRuns.find((r) => r.conversationId === conv.id);
  assert.ok(run, 'la ejecución ya terminó antes de cancelar');
  await invoke('cancel_run', { runId: run.runId });
  const done = await idle(conv.id);
  const last = done.findLast((m) => m.role === 'assistant');
  const ins = await invoke('run_insights', { messageId: last.id });
  const workers = Object.values(ins?.details?.subagents ?? {});
  assert.equal(last.status, 'cancelled');
  assert.ok(workers.length >= 1, 'sin subagente registrado');
  assert.ok(workers.every((w) => w.status !== 'completed'), JSON.stringify(workers));
  await open(conv);
  await input().click();
  await input().fill('/tasks');
  await input().press('Enter');
  const workerRows = page.locator('.activity-panel .insight-worker');
  await until(async () => {
    const outcomes = await workerRows.evaluateAll((els) => els.map((e) => e.dataset.outcome));
    return outcomes.length === workers.length && outcomes.every((o) => ['unknown', 'cancelled', 'failed'].includes(o)) ? outcomes : null;
  }, 'estado final del subagente', 10000);
  const outcomes = await workerRows.evaluateAll((els) => els.map((e) => e.dataset.outcome));
  for (const outcome of outcomes) {
    if (outcome !== 'unknown') assert.ok(workers.some((w) => w.status === outcome || (outcome === 'cancelled' && w.status === 'interrupted')));
  }
  const labels = await page.locator('.activity-panel .insight-worker .insight-status').allTextContents();
  await shot('subagente-detenido');
  return { status: last.status, workers: workers.map((w) => w.status ?? null), outcomes, labels, before: list.length };
});

await check('/status abre el Activity Center', async () => {
  await open(convs.claude);
  await input().click();
  await input().fill('/status');
  await input().press('Enter');
  await page.locator('.activity-center').waitFor();
  await page.keyboard.press('Escape');
  return null;
});

await check('bifurcación histórica sin ejecuciones activas', async () => {
  const list = await messages(convs.claude.id);
  const first = list.find((m) => m.role === 'assistant');
  const fork = await invoke('fork_conversation', { request: { conversationId: convs.claude.id, messageId: first.id, purpose: 'fork' } });
  const forkId = fork.conversation?.id ?? fork.id;
  assert.ok((await messages(forkId)).length > 0);
  const active = (await invoke('bootstrap')).activeRuns.filter((r) => r.conversationId === forkId);
  assert.equal(active.length, 0);
  const pending = (await invoke('pending_interactions')).filter((p) => p.conversationId === forkId);
  assert.equal(pending.length, 0);
  await invoke('rename_conversation', { id: forkId, title: 'QA · Bifurcación histórica (Claude Code)' });
  return { forkId };
});

// La pregunta pendiente se deja abierta a propósito para revisar el Activity Center.
report();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones · errores de página: ${pageErrors.length}`);
await browser.close().catch(() => {});
process.exit(results.every((r) => r.ok) ? 0 : 1);

// QA 1.0.11 · fase 5: Agent Control Center sobre la app en desarrollo (perfil QA aislado).
//
// Requisitos:
//   1. APIs simuladas: `node scripts/qa/control-mock-apis.mjs <qa>/mock 53396 53397`.
//   2. Configuraciones aisladas en <qa>/claude-config (settings.json con ANTHROPIC_BASE_URL y clave
//      ficticia) y <qa>/codex-home (config.toml con un proveedor en 127.0.0.1). Ningún modelo real.
//   3. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y
//      `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json`.
//
// Uso: node scripts/qa/control-webview.mjs <carpeta-qa> [carpeta-salida]
// Deja el proyecto «QA · Agent Control Center (datos de prueba)» con sus conversaciones para revisar.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const qa = process.argv[2];
if (!qa) throw new Error('Falta la carpeta QA');
const out = process.argv[3] ?? join(qa, 'report');
rmSync(join(out, 'shots'), { recursive: true, force: true });
mkdirSync(join(out, 'shots'), { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
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
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 500));
    await page.screenshot({ path: join(out, 'shots', `fallo-${results.length}.png`) }).catch(() => {});
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockLog = () => {
  try { return readFileSync(join(qa, 'mock', 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
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
const idle = (id) => until(async () => {
  const list = await messages(id);
  return list.length && list.every((m) => m.status !== 'running') ? list : null;
}, 'fin de la ejecución', 90_000);
const shot = (name, target) => (target ?? page).screenshot({ path: join(out, 'shots', `${name}.png`) }).catch(() => {});

// ---------- Preparación (datos de prueba) ----------
const dir = mkdtempSync(join(tmpdir(), 'duovra-control-qa-project-'));
writeFileSync(join(dir, 'README.md'), '# Proyecto de prueba de QA (fase 5)\n');
execSync('git init -q && git add . && git -c user.email=qa@duovra.invalid -c user.name=QA commit -q -m "base de QA"', { cwd: dir });
writeFileSync(join(dir, 'cambio-de-prueba.txt'), 'Cambio sin commit para la revisión de QA.\n');
const PROJECT = 'QA · Agent Control Center (datos de prueba)';
{
  const boot = await invoke('bootstrap');
  const old = boot.projects.filter((p) => p.name === PROJECT).map((p) => p.id);
  const convs = new Set(boot.conversations.filter((c) => old.includes(c.projectId)).map((c) => c.id));
  for (const run of boot.activeRuns.filter((r) => convs.has(r.conversationId))) await invoke('cancel_run', { runId: run.runId }).catch(() => {});
  await until(async () => !(await invoke('bootstrap')).activeRuns.some((r) => convs.has(r.conversationId)), 'cancelar la QA anterior', 30_000);
  // Solo hay un juego de datos de prueba: el anterior se elimina por completo.
  for (const id of old) await invoke('delete_project', { id });
}
const project = await invoke('create_project', { name: PROJECT, path: dir });
const accounts = {};
for (const [agent, label, sub] of [['claude', 'QA simulada · Claude Code', 'claude-config'], ['codex', 'QA simulada · Codex', 'codex-home']]) {
  for (const old of (await invoke('bootstrap')).accounts.filter((a) => a.label === label && a.agent === agent)) await invoke('remove_account', { id: old.id });
  const { accounts: list } = await invoke('add_account', { agent, label, configDir: join(qa, sub) });
  accounts[agent] = list.find((a) => a.label === label && a.agent === agent).id;
  await invoke('set_setting', { key: `accounts.active.${agent}`, value: accounts[agent] });
}
await invoke('agent_models', { agent: 'claude', refresh: true });
await invoke('agent_models', { agent: 'codex', refresh: true });
const MODEL = { claude: 'haiku', codex: 'gpt-6-luna' };
const EFFORT = { claude: 'medium', codex: 'high' };
const PERMS = { claude: { mode: 'manual' }, codex: { sandbox: 'read-only', approval: 'on-request' } };
async function conversation(title, agent) {
  const conv = await invoke('create_conversation', { projectId: project.id, title });
  await invoke('set_conversation_prefs', { conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent] });
  await invoke('set_conversation_permissions', { conversationId: conv.id, agent, permissions: PERMS[agent] });
  return conv;
}
const request = (conv, agent, text, extra = {}) => ({ conversationId: conv.id, agent, model: MODEL[agent], effort: EFFORT[agent], text, attachments: [], speed: null, permissions: PERMS[agent], ...extra });
const submit = (req) => invoke('submit_message', { id: crypto.randomUUID(), request: req, accountId: accounts[req.agent] });

const convs = {
  menu: await conversation('QA · Menú / (Claude Code)', 'claude'),
  codexMenu: await conversation('QA · Menú / y revisión (Codex)', 'codex'),
  goal: await conversation('QA · Objetivo persistente', 'claude'),
  other: await conversation('QA · Aislamiento (sin objetivo)', 'codex'),
  steer: await conversation('QA · Intervenir en Codex', 'codex'),
  claudeRun: await conversation('QA · Cola e interrumpir (Claude Code)', 'claude'),
  errors: await conversation('QA · Errores normalizados', 'codex'),
  wait: await conversation('QA · Pregunta pendiente', 'claude'),
};
// Cada conversación recibe un primer mensaje (API simulada): una conversación vacía se descarta al
// cambiar de vista y /fork necesita historial.
for (const conv of Object.values(convs)) {
  const agent = ['menu', 'goal', 'claudeRun', 'wait'].some((k) => convs[k] === conv) ? 'claude' : 'codex';
  await submit(request(conv, agent, 'Hola, conversación de prueba de QA.'));
  await idle(conv.id);
}
await page.reload();
await page.waitForFunction(() => !!document.querySelector('.tree-project'));
await invoke('set_setting', { key: 'ui.sidebarCollapsed', value: false });

async function open(conv) {
  const row = page.locator('.tree-conv', { hasText: conv.title ?? '' }).first();
  if (!(await row.isVisible().catch(() => false))) await page.locator('.tree-project', { hasText: 'QA · Agent Control Center' }).first().click();
  await page.locator('.tree-conv', { hasText: conv.title }).first().click();
  await page.locator('.composer-input').waitFor();
  await sleep(350);
}
const input = () => page.locator('.composer-input');
const popup = () => page.locator('.composer-suggestions');
async function typeComposer(text) {
  await input().click();
  await input().fill('');
  await input().pressSequentially(text, { delay: 12 });
}
const optionNames = () => popup().locator('[role="option"] strong').allTextContents();

// ---------- Menú «/» ----------
await check('menú /: aparece al escribir / al principio, agrupa y no muestra listas enormes', async () => {
  await open(convs.menu);
  await typeComposer('/');
  await popup().waitFor();
  // El informe de capacidades se consulta al escribir «/» la primera vez.
  const names = await until(async () => { const n = await optionNames(); return n.includes('/compact') ? n : null; }, 'informe de capacidades', 30_000);
  const groups = await popup().locator('.suggestion-group').allTextContents();
  assert(names.includes('/compact') && names.includes('/help'));
  assert(!names.some((n) => n === '/simplify' || n === '/config'), 'sin consulta no aparecen comandos del proveedor');
  assert.deepEqual(groups, ['Duovra']);
  const footer = await popup().locator('footer').textContent();
  await shot('01-menu-barra');
  return { visibles: names.length, groups, footer };
});

await check('menú /: filtrado instantáneo, flechas y Escape conservan el borrador', async () => {
  await typeComposer('/rev');
  await until(async () => (await optionNames())[0] === '/review', 'filtrado');
  await input().press('ArrowDown');
  const selected = await popup().locator('[role="option"][aria-selected="true"] strong').textContent();
  await input().press('Escape');
  await until(async () => !(await popup().isVisible().catch(() => false)), 'cerrar con Escape');
  assert.equal(await input().inputValue(), '/rev');
  return { primero: '/review', trasFlecha: selected };
});

await check('menú /: texto normal que empieza por / se envía como mensaje', async () => {
  const before = (await messages(convs.menu.id)).length;
  await typeComposer('/ruta/de/ejemplo no es un comando');
  assert(!(await popup().isVisible().catch(() => false)), 'fuera de la primera palabra no hay menú');
  await input().press('Enter');
  const list = await until(async () => { const l = await messages(convs.menu.id); return l.length > before ? l : null; }, 'mensaje enviado');
  await idle(convs.menu.id);
  const sent = list.find((m) => m.role === 'user' && m.content.startsWith('/ruta'));
  assert(sent, 'el texto se envió tal cual');
  return { enviado: sent.content };
});

await check('comandos de Duovra: abren su interfaz sin enviar nada ni consumir', async () => {
  const before = (await messages(convs.menu.id)).length;
  const calls = mockLog().length;
  // /plan y /build cambian el modo; /model abre el selector; /diff abre Workbench.
  await typeComposer('/plan'); await input().press('Enter');
  await until(async () => (await page.locator('.composer').getAttribute('data-mode')) === 'plan', 'modo plan');
  await typeComposer('/build'); await input().press('Enter');
  await until(async () => (await page.locator('.composer').getAttribute('data-mode')) === 'build', 'modo construir');
  await typeComposer('Borrador conservado'); await input().press('Home'); await input().pressSequentially('/model ');
  await input().press('ArrowLeft'); // el cursor vuelve a la palabra del comando
  await popup().waitFor();
  await input().press('Enter');
  await page.locator('.model-btn[aria-expanded="true"]').waitFor();
  await shot('02-model-desde-comando');
  await page.keyboard.press('Escape');
  const draft = await input().inputValue();
  await typeComposer('/diff'); await input().press('Enter');
  await until(async () => (await page.locator('.panel, [data-panel-open], .right-panel').count()) > 0, 'Workbench abierto', 8000).catch(() => null);
  await typeComposer('/context'); await input().press('Enter');
  await page.locator('.ctx-card').waitFor();
  await page.keyboard.press('Escape');
  await input().fill('');
  assert.equal((await messages(convs.menu.id)).length, before, 'ningún mensaje');
  assert.equal(mockLog().length, calls, 'ninguna petición a la API');
  return { borradorTrasModel: draft };
});

await check('comandos de Claude Code: compatibles al buscar, preparados sin ejecutarse y enviados solo con Enter', async () => {
  const before = (await messages(convs.menu.id)).length;
  const calls = mockLog().length;
  await typeComposer('/simpl');
  await until(async () => (await optionNames()).includes('/simplify'), 'comando de Claude Code');
  const groups = await popup().locator('.suggestion-group').allTextContents();
  const tag = await popup().locator('[role="option"]', { hasText: '/simplify' }).locator('.suggestion-tag').textContent();
  await shot('03-menu-claude');
  await input().press('Enter');
  await page.locator('.command-chip').waitFor();
  assert.equal((await messages(convs.menu.id)).length, before, 'seleccionar no ejecuta');
  assert.equal(mockLog().length, calls);
  await shot('04-comando-preparado');
  // Los de terminal no se ofrecen; /help los lista con su motivo.
  await input().press('Escape');
  await typeComposer('/config');
  // Solo terminal: aparece por coincidir exactamente, deshabilitado y con su motivo; Enter no lo envía.
  const configRow = popup().locator('[role="option"]', { hasText: '/config' });
  await configRow.waitFor();
  assert.equal(await configRow.getAttribute('aria-disabled'), 'true');
  const configReason = await configRow.locator('small').textContent();
  await input().press('Enter');
  await sleep(600);
  assert.equal((await messages(convs.menu.id)).length, before, 'Enter no envía un comando no disponible');
  await typeComposer('/help'); await input().press('Enter');
  await typeComposer('/conf');
  await page.locator('.composer-suggestions').waitFor().catch(() => {});
  await input().fill('');
  // Enviar el comando preparado: va tal cual y sin el bloque de contexto.
  await typeComposer('/simplify'); await input().press('Enter');
  await page.locator('.command-chip').waitFor();
  await input().press('Enter');
  const list = await until(async () => { const l = await messages(convs.menu.id); return l.length > before ? l : null; }, 'comando enviado');
  await idle(convs.menu.id);
  const req = mockLog().slice(calls).filter((r) => r.api === 'anthropic');
  return { groups, etiqueta: tag, configMotivo: configReason, enviado: list.filter((m) => m.role === 'user').at(-1).content, peticiones: req.length, conContexto: req.some((r) => r.context) };
});

await check('Codex: sin comandos propios; /review con review/start en el hilo y resultado en el chat', async () => {
  await open(convs.codexMenu);
  await typeComposer('/simpl');
  const names = await optionNames().catch(() => []);
  assert(!names.includes('/simplify'));
  await typeComposer('/review');
  await until(async () => (await optionNames().catch(() => []))[0] === '/review'
    && (await popup().locator('[role="option"]').first().getAttribute('aria-disabled')) !== 'true', 'informe de Codex', 30_000);
  await input().press('Enter');
  await page.locator('.review-form').waitFor();
  const kinds = await page.locator('.review-kind').allTextContents();
  await shot('05-revision-codex', page.locator('.review-form'));
  const before = (await messages(convs.codexMenu.id)).length;
  await page.locator('.review-form button[type="submit"]').click();
  const list = await until(async () => { const l = await messages(convs.codexMenu.id); return l.length > before ? l : null; }, 'revisión iniciada');
  const done = await idle(convs.codexMenu.id);
  const assistant = done.at(-1);
  const notices = (assistant.items ?? []).filter((i) => i.kind === 'notice').map((i) => i.text);
  assert(notices.some((t) => /Revisión de código iniciada/.test(t)), JSON.stringify(notices));
  assert.equal(assistant.status, 'done');
  // No modifica archivos.
  const status = execSync('git status --porcelain', { cwd: dir }).toString().trim();
  await shot('06-revision-resultado');
  return { opciones: kinds, mensaje: list.filter((m) => m.role === 'user').at(-1).content, avisos: notices, git: status };
});

await check('Claude Code: /review prepara /code-review en el compositor (sin --fix)', async () => {
  await open(convs.menu);
  await typeComposer('/review'); await input().press('Enter');
  await page.locator('.review-form').waitFor();
  const kinds = await page.locator('.review-kind').allTextContents();
  await page.locator('.review-form button[type="submit"]').click();
  await page.locator('.command-chip', { hasText: '/code-review' }).waitFor();
  const chip = await page.locator('.command-chip').textContent();
  await page.locator('.command-chip .attach-remove').click();
  return { opciones: kinds, chip };
});

// ---------- Objetivos ----------
await check('objetivo: definirlo no inicia ejecución; cápsula; prioridad en el contexto; aislado por conversación', async () => {
  await open(convs.goal);
  const calls = mockLog().length;
  await typeComposer('/goal'); await input().press('Enter');
  await page.locator('.goal-editor textarea').waitFor();
  await page.locator('.goal-editor textarea').fill('Publicar la beta de prueba sin regresiones (QA)');
  await shot('07-objetivo-editor', page.locator('.goal-editor'));
  await page.locator('.goal-editor .btn-primary').click();
  await page.locator('.goal-capsule').waitFor();
  await sleep(1500);
  assert.equal(mockLog().length, calls, 'definir el objetivo no llama a la API');
  assert.equal((await messages(convs.goal.id)).length, 2, 'ni crea mensajes');
  await shot('08-objetivo-capsula');
  await submit(request(convs.goal, 'claude', 'Primer mensaje con objetivo.'));
  await idle(convs.goal.id);
  const withGoal = mockLog().slice(calls).filter((r) => r.api === 'anthropic').at(-1);
  assert(withGoal?.goal, 'el objetivo viaja en el contexto');
  // Otra conversación no lo recibe.
  await submit(request(convs.other, 'codex', 'Mensaje en otra conversación.'));
  await idle(convs.other.id);
  const other = mockLog().filter((r) => r.api === 'responses').at(-1);
  assert(!other?.goal, 'aislamiento entre conversaciones');
  return { objetivo: withGoal.goalText, otraConversacion: other.goal };
});

await check('objetivo: editar y marcar completado', async () => {
  await page.locator('.goal-capsule').click();
  await page.locator('.goal-editor textarea').fill('Publicar la beta de prueba (QA, editado)');
  await page.locator('.goal-editor .btn-primary').click();
  await until(async () => (await page.locator('.goal-capsule').textContent())?.includes('editado'), 'objetivo editado');
  await page.locator('.goal-capsule').click();
  await page.locator('.goal-actions .btn', { hasText: /Completado|Completed/ }).click();
  await until(async () => !(await page.locator('.goal-capsule').count()), 'cápsula oculta');
  const memories = await invoke('memory_list', { conversationId: convs.goal.id, includeArchived: true });
  const g = memories.find((m) => m.category === 'goal');
  const calls = mockLog().length;
  await submit(request(convs.goal, 'claude', 'Mensaje tras completar.'));
  await idle(convs.goal.id);
  const req = mockLog().slice(calls).filter((r) => r.api === 'anthropic').at(-1);
  return { prioridad: g.priority, archivado: g.archived, revision: g.revision, objetivoActivoEnContexto: req?.goal ?? null };
});

// ---------- Control durante la ejecución ----------
await check('Codex: menú del botón principal; «Enviar ahora» usa turn/steer en el turno activo', async () => {
  await open(convs.steer);
  await typeComposer('QA-SLOW Trabajo largo de prueba');
  await input().press('Enter');
  await page.locator('.composer[data-busy]').waitFor();
  await until(async () => (await page.locator('.send-btn').getAttribute('aria-keyshortcuts')) === 'Alt+Enter', 'turno de Codex intervenible', 20_000);
  await typeComposer('Instrucción adicional de QA durante el turno');
  await page.locator('.send-more').click();
  const items = await page.locator('.popover .menu-item').allTextContents();
  const disabled = await page.locator('.popover .menu-item:disabled').count();
  await shot('09-menu-envio-codex');
  await page.locator('.popover .menu-item', { hasText: /Enviar ahora|Send now/ }).click();
  const list = await idle(convs.steer.id);
  const steered = list.find((m) => m.role === 'user' && m.content.includes('Instrucción adicional'));
  assert(steered, 'la intervención queda en el historial');
  return { opciones: items.map((t) => t.split(/(?<=[a-z])(?=[A-Z])/)[0]).slice(0, 3), deshabilitadas: disabled, estado: steered.contextNote?.steer ?? steered.status };
});

await check('Claude Code: sin steering real; encolar e «Interrumpir y continuar» sin duplicar ejecuciones', async () => {
  await open(convs.claudeRun);
  await typeComposer('QA-SLOW Primera tarea larga');
  await input().press('Enter');
  await page.locator('.composer[data-busy]').waitFor();
  await typeComposer('Mensaje encolado de QA');
  await page.locator('.send-more').click();
  const steerDisabled = await page.locator('.popover .menu-item', { hasText: /Enviar ahora|Send now/ }).isDisabled();
  await page.locator('.popover .menu-item', { hasText: /Añadir a la cola|Add to queue/ }).click();
  await until(async () => (await invoke('message_queue', { conversationId: convs.claudeRun.id })).entries.length === 1, 'encolado');
  await typeComposer('Nueva instrucción tras interrumpir');
  await page.locator('.send-more').click();
  await page.locator('.popover .menu-item', { hasText: /Interrumpir y continuar|Interrupt and continue/ }).click();
  const list = await until(async () => {
    const l = await messages(convs.claudeRun.id);
    return l.some((m) => m.role === 'user' && m.content.includes('Nueva instrucción')) ? l : null;
  }, 'mensaje tras la interrupción', 30_000);
  const done = await idle(convs.claudeRun.id);
  const statuses = done.filter((m) => m.role === 'assistant').map((m) => m.status);
  const queue = await invoke('message_queue', { conversationId: convs.claudeRun.id });
  const boot = await invoke('bootstrap');
  assert.equal(boot.activeRuns.filter((r) => r.conversationId === convs.claudeRun.id).length, 0);
  assert.deepEqual(statuses.slice(-2), ['cancelled', 'done']);
  assert.equal(queue.entries.length, 1, 'la cola conserva su encargo');
  await shot('10-interrumpir-y-continuar');
  return { steerDeshabilitado: steerDisabled, estados: statuses, cola: { encargos: queue.entries.length, pausa: queue.pauseReason, agente: queue.entries[0].input.request.agent, modelo: queue.entries[0].input.request.model }, mensajes: list.length };
});

await check('cola: editar, reordenar, eliminar, pausar y reanudar conservan la configuración', async () => {
  const cid = convs.claudeRun.id;
  await invoke('enqueue_message', { id: crypto.randomUUID(), request: request(convs.claudeRun, 'claude', 'Segundo encargo'), accountId: accounts.claude, defer: true });
  let q = await invoke('message_queue', { conversationId: cid });
  const [a, b] = q.entries;
  await invoke('update_message_queue', { conversationId: cid, action: { type: 'move', id: b.id, before: a.id } });
  q = await invoke('message_queue', { conversationId: cid });
  const reordered = q.entries[0].id === b.id;
  await invoke('edit_queued_message', { id: a.id, request: request(convs.claudeRun, 'claude', 'Encargo editado'), replaceTarget: false, accountId: accounts.claude });
  q = await invoke('message_queue', { conversationId: cid });
  const edited = q.entries.find((e) => e.id === a.id);
  await invoke('update_message_queue', { conversationId: cid, action: { type: 'remove', id: b.id } });
  // La cola quedó en pausa por la interrupción: no se reanuda sola (riesgo de repetir acciones).
  q = await invoke('message_queue', { conversationId: cid });
  await assert.rejects(invoke('edit_queued_message', { id: a.id, request: { ...request(convs.claudeRun, 'claude', 'x'), effort: 'high' }, replaceTarget: false, accountId: accounts.claude }));
  return { reordenado: reordered, editado: edited.input.request.text, esfuerzoConservado: edited.input.request.effort, encargosTrasEliminar: q.entries.length, pausa: q.pauseReason };
});

// ---------- Errores ----------
await check('error normalizado: límite de uso de Codex con acciones y el original en los detalles', async () => {
  await open(convs.errors);
  await typeComposer('QA-FAIL provoca un error de prueba');
  await input().press('Enter');
  const list = await idle(convs.errors.id);
  const failed = list.at(-1);
  await page.locator('.turn-error').waitFor();
  const actions = await page.locator('.turn-error-actions .btn').allTextContents();
  const hasDetail = await page.locator('.turn-error-detail').count();
  await page.locator('.turn-error-detail summary').click().catch(() => {});
  await shot('11-error-normalizado', page.locator('.turn-error'));
  // «Preparar de nuevo» deja el mensaje en el compositor sin enviarlo.
  const calls = mockLog().length;
  // «Elegir otro modelo» abre el selector del compositor; nada se envía.
  await page.locator('.turn-error-actions .btn', { hasText: /Elegir otro modelo|Choose another model/ }).click();
  await page.locator('.model-btn[aria-expanded="true"]').waitFor();
  await page.keyboard.press('Escape');
  return { estado: failed.status, error: failed.error?.slice(0, 160), acciones: actions, detalles: hasDetail, sinPeticiones: mockLog().length === calls };
});

// ---------- Indicador de pendientes ----------
await check('pendiente visible con el proyecto plegado y la barra contraída', async () => {
  await submit(request(convs.wait, 'claude', 'QA-WAIT pregunta pendiente de prueba'));
  await until(async () => (await invoke('pending_interactions')).some((r) => r.conversationId === convs.wait.id), 'pregunta pendiente', 60_000);
  await open(convs.menu);
  await page.locator('.tree-project', { hasText: 'QA · Agent Control Center' }).first().click();
  await page.locator('.tree-project .tree-wait').first().waitFor();
  const label = await page.locator('.tree-project .tree-wait').first().getAttribute('aria-label');
  await shot('12-proyecto-plegado', page.locator('aside').first());
  await invoke('set_setting', { key: 'ui.sidebarCollapsed', value: true });
  await page.reload();
  await page.locator('.rail-wait .tree-wait').waitFor();
  await shot('13-barra-contraida', page.locator('aside').first());
  await invoke('set_setting', { key: 'ui.sidebarCollapsed', value: false });
  await page.reload();
  return { etiqueta: label };
});

await check('ventana estrecha: menú y compositor sin desbordes', async () => {
  await open(convs.codexMenu);
  await page.setViewportSize({ width: 780, height: 640 }).catch(() => {});
  await sleep(500);
  await typeComposer('/');
  await popup().waitFor();
  const box = await popup().boundingBox();
  await shot('14-estrecha');
  await input().fill('');
  return { ancho: box?.width };
});

await check('sin errores de página', async () => {
  assert.deepEqual(pageErrors, []);
});

const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(out, 'control-webview.json'), JSON.stringify({ results, project: PROJECT, mockRequests: mockLog().length }, null, 2));
console.log(`\n${results.length - failed}/${results.length} comprobaciones · peticiones a las APIs simuladas: ${mockLog().length}`);
await browser.close().catch(() => {});
process.exit(failed ? 1 : 0);

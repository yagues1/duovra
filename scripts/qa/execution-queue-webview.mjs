// Pruebas de la build portable, con WebView2 real y dos proveedores locales.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { checkVisualPreviews } from './visual-previews-webview.mjs';
import { checkInteractiveViews } from './interactive-views-webview.mjs';
import { checkChatJump, checkSelectorCold } from './visual-previews-selector.mjs';
import { checkAgentInsights, checkInsightsRestart } from './agent-insights-webview.mjs';
import { beta } from '../personal-beta-config.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const insights = process.argv.includes('--agent-insights');
const visual = process.argv.includes('--visual-previews');
const interactive = process.argv.includes('--interactive-views');
const rc1 = process.argv.includes('--rc1');
const personalBeta = process.argv.includes('--personal-beta');
assert(!(rc1 && personalBeta));
const isolated = rc1 || personalBeta;
const gallery = interactive && process.argv.includes('--gallery');
const selectorOnly = process.argv.includes('--selector-only');
const queueRegression = (visual || interactive) && process.argv.includes('--regression-queue');
const variant = interactive ? 'interactive-views' : visual ? 'visual-previews' : insights ? 'agent-insights' : 'execution-queue';
const build = personalBeta ? beta.qa : join(root, 'output', 'qa', rc1 ? 'rc1' : variant);
const out = process.env.DUOVRA_QA_OUTPUT ? resolve(process.env.DUOVRA_QA_OUTPUT) : build;
const exe = personalBeta ? beta.executable : join(build, 'app', rc1 ? 'Duovra 0.6.0 RC1 QA.exe' : interactive ? 'Duovra Interactive Views QA.exe' : visual ? 'Duovra Visual Previews QA.exe' : insights ? 'Duovra Agent Insights QA.exe' : 'Duovra Execution Queue QA.exe');
const evidence = join(out, isolated ? 'evidencia-' + variant : gallery ? 'galeria' : queueRegression ? 'regresion-cola' : 'evidencia');
assert(existsSync(exe), 'Compila con node scripts/qa/execution-queue-build.mjs');
mkdirSync(evidence, { recursive: true });
const session = mkdtempSync(join(out, 'sesion-'));
const fixture = fileURLToPath(new URL('execution-queue-agent.mjs', import.meta.url));
const profiles = Object.fromEntries(['codex', 'claude', 'codex-alt'].map((agent) => [agent, join(session, 'perfil-' + agent)]));
for (const path of Object.values(profiles)) mkdirSync(path);
const executables = Object.fromEntries(['codex', 'claude'].map((agent) => {
  const path = join(session, agent + '.cmd');
  writeFileSync(path, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" ' + agent + ' %*\r\n');
  return [agent, path];
}));

const profileId = randomUUID();
const dbDir = isolated ? join(process.env.APPDATA, personalBeta ? beta.identifier : 'dev.duovra.studio.rc1.qa', 'fixtures', profileId)
  : join(process.env.APPDATA, interactive ? 'dev.duovra.interactiveviews.qa' : visual ? 'dev.duovra.visualpreviews.qa' : insights ? 'dev.duovra.agentinsights.qa' : 'dev.duovra.executionqueue.qa');
const dbPath = join(dbDir, 'studio.sqlite3');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(webview2_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home)$/i.test(name)) delete env[name];
}
Object.assign(env, {
  CODEX_HOME: profiles.codex,
  CLAUDE_CONFIG_DIR: profiles.claude,
  DUOVRA_QUEUE_FIXTURE: session,
  WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'),
});
if (rc1) env.DUOVRA_RC1_TEST_PROFILE = profileId;
if (personalBeta) env[beta.profileVariable] = profileId;
const keys = {
  'agents.codex.path': executables.codex,
  'agents.claude.path': executables.claude,
  'accounts.active.codex': null,
  'accounts.active.claude': null,
  'defaults.agent': 'codex',
  'defaults.model.codex': 'gpt-6-luna',
  'defaults.effort.codex': 'high',
  'defaults.model.claude': 'haiku',
  'defaults.effort.claude': 'medium',
  'startup.restoreConversation': true,
  'startup.view': 'last',
  'composer.enterToSend': true,
  'ui.lastConversationId': null,
  'ui.lastProjectId': null,
};

const checks = [];
const pageErrors = [];
const projects = [];
const accounts = [];
let processHandle, browser, page, capture, failure, webviewVersion;
const logFile = join(session, 'provider.ndjson');
const events = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const starts = (tag) => events().filter((entry) => entry.type === 'start' && entry.tag === tag);
const accepted = (tag) => events().find((entry) => entry.type === 'terminal' && entry.tag === tag);
const release = (tag) => writeFileSync(join(session, tag + '.release'), '');
const check = (label) => { checks.push(label); console.log('PASS', label); };
const controls = (profile, value) => writeFileSync(join(profiles[profile], 'controls.json'), JSON.stringify(value));

async function poll(fn, description, timeout = 15_000) {
  const start = Date.now();
  let lastError;
  do {
    try {
      const current = await fn();
      if (current) return current;
    } catch (err) { lastError = err; }
    await wait(80);
  } while (Date.now() - start < timeout);
  throw new Error(description, { cause: lastError });
}

async function boot() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  processHandle = spawn(exe, [], { cwd: dirname(exe), env: {
    ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
  }, stdio: 'ignore', windowsHide: true });
  const endpoint = 'http://127.0.0.1:' + port;
  await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'WebView2 no abrió su puerto local', 30_000);
  browser = await chromium.connectOverCDP(endpoint);
  webviewVersion = browser.version();
  page = await poll(() => browser.contexts()[0]?.pages()[0], 'No apareció la página de WebView2');
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  return await invoke('bootstrap');
}

const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const setting = (key, value) => invoke('set_setting', { key, value });
const draft = () => page.getByRole('textbox', { name: 'Mensaje', exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const queue = (conversationId) => invoke('message_queue', { conversationId });
const update = (conversationId, action) => invoke('update_message_queue', { conversationId, action });
const history = async (conversationId) => (await invoke('list_messages', { conversationId })).messages;
const stop = () => button('Detener la ejecución');
const steer = () => button('Intervenir en el turno activo de Codex');
const active = async (conversationId) => (await invoke('bootstrap')).activeRuns.find((run) => run.conversationId === conversationId);
const req = (conversationId, tag, agent = 'codex', model = agent === 'codex' ? 'gpt-6-luna' : 'haiku', effort = agent === 'codex' ? 'high' : 'medium') => ({
  conversationId, agent, model, effort, text: '[QA:' + tag + ']', attachments: [],
});
const direct = (id, tag, agent) => invoke('send_message', { request: req(id, tag, agent) });
const enqueue = (request, extras = {}) => invoke('enqueue_message', { id: randomUUID(), request, accountId: null, ...extras });
const finish = (id, tag, status = 'done') => poll(async () => {
  const list = await history(id);
  const index = list.findIndex((row) => row.role === 'user' && row.content.includes('[QA:' + tag + ']'));
  return index !== -1 && list[index + 1]?.status === status && list[index + 1];
}, 'El turno ' + tag + ' no terminó con estado ' + status, interactive ? 30_000 : 15_000);
const load = async (id, projectId) => {
  await setting('ui.lastConversationId', id);
  await setting('ui.lastProjectId', projectId);
  await page.reload();
  await draft().waitFor();
  await poll(async () => {
    const label = await page.getByRole('button', { name: /^Modelo:/ }).getAttribute('aria-label');
    return label && !/Cargando|no disponibles|Elige/.test(label);
  }, 'No se cargó el catálogo del compositor');
};
const switchView = async (project, conversation) => {
  const group = page.locator('.tree-group').filter({ has: page.getByText(project, { exact: true }) });
  const row = group.locator('button.tree-conv').filter({ hasText: conversation });
  const projectButton = group.locator('button.tree-project');
  if ((await projectButton.getAttribute('aria-expanded')) !== 'true') await projectButton.click();
  await row.press('Enter');
  await draft().waitFor();
};
const switchAgent = async (agent) => {
  const picker = page.getByRole('button', { name: /^Agente para el próximo mensaje/ });
  if (!(await picker.getAttribute('aria-label')).endsWith(agent)) {
    await picker.click();
    await page.getByRole('menuitemradio', { name: agent, exact: true }).click();
  }
  await poll(async () => (await picker.getAttribute('aria-label')).endsWith(agent), 'No se seleccionó ' + agent);
};
// Desde 1.0.0 Beta 2 solo existe Enviar: con un agente trabajando, el mensaje se encola solo.
const QUEUE_SEND = 'Enviar mensaje (se añadirá a la cola)';
const textToQueue = async (text, twice = false) => {
  await draft().fill(text);
  await poll(() => button(QUEUE_SEND).isEnabled(), 'Enviar sigue deshabilitado durante la ejecución');
  if (twice) await button(QUEUE_SEND).evaluate((element) => { element.click(); element.click(); });
  else await draft().press('Enter');
  await poll(async () => await draft().inputValue() === '', 'El compositor no liberó el borrador');
};
const remove = async (cid, tag) => {
  const row = (await queue(cid)).entries.find((row) => row.input.request.text.includes('[QA:' + tag + ']'));
  assert(row);
  await update(cid, { type: 'remove', id: row.id });
};
/** Despliega la bandeja compacta de la cola si está contraída. */
const openQueue = async () => {
  const head = page.locator('.queue-next');
  await head.waitFor();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await page.locator('.execution-queue-body:not([hidden])').waitFor();
};
const makeConversation = (projectId, title) => invoke('create_conversation', { projectId, title });
const checkNoSteer = async () => assert.equal(await steer().count(), 0);

async function crash() {
  const exited = once(processHandle, 'exit');
  // Termina el proceso que abrió el arnés. WebView2 protege algunos de sus
  // descendientes, que cierran su sesión al perder el proceso anfitrión.
  assert(processHandle.kill(), 'No se pudo terminar el proceso de QA');
  await exited;
  await browser.close().catch(() => {});
  processHandle = undefined;
  await wait(350);
}

async function close() {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = once(processHandle, 'exit');
  await button('Cerrar').click({ timeout: 2500 }).catch(() => {});
  if (!await Promise.race([exited.then(() => true), wait(3500).then(() => false)])) await crash();
  await browser?.close().catch(() => {});
  processHandle = undefined;
}

function startVideo(filename = visual ? 'vistas-webview2.mp4' : 'cola-webview2.mp4') {
  if (isolated) return async () => {};
  const frames = [];
  let running = true;
  const record = (async () => {
    while (running) {
      const name = 'fotograma-' + String(frames.length).padStart(4, '0') + '.jpg';
      const at = Date.now();
      await page.screenshot({ path: join(session, name), type: 'jpeg', quality: 83 });
      frames.push({ name, at });
      await wait(145);
    }
  })();
  return async () => {
    running = false;
    await record;
    assert(frames.length > 4);
    writeFileSync(join(session, 'video.ffconcat'), 'ffconcat version 1.0\n' + frames.map((frame, i) =>
      'file ' + frame.name + '\nduration ' + ((frames[i + 1]?.at ?? frame.at + 400) - frame.at) / 1000 + '\n').join('') + 'file ' + frames.at(-1).name + '\n');
    const filters = (visual || interactive ? 'setpts=2.4*PTS,' : '') + 'fps=24,pad=ceil(iw/2)*2:ceil(ih/2)*2';
    const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i',
      'video.ffconcat', '-vf', filters, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(evidence, filename)], { cwd: session, windowsHide: true });
    assert.equal(encoded.status, 0, encoded.stderr?.toString());
  };
}

mkdirSync(dbDir, { recursive: true });
const seed = new DatabaseSync(dbPath);
seed.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const savedSettings = Object.keys(keys).map((key) => [key, seed.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value]);
for (const [key, value] of Object.entries(keys)) seed.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, JSON.stringify(value));
seed.close();

try {
  const initial = await boot();
  if (isolated) {
    assert.equal(initial.appVersion, personalBeta ? beta.version : '0.6.0-rc.1');
    assert.equal(initial.qaMode, personalBeta ? null : 'fixture');
    assert.deepEqual(initial.projects, []);
  }
  if (isolated || insights || visual || interactive) {
    const distribution = await invoke('distribution_info');
    assert.equal(distribution.reportingEnabled, false);
    assert.equal(distribution.updaterEnabled, false);
  }
  const paths = [join(session, 'proyecto-orbita'), join(session, 'proyecto-norte')];
  for (const path of paths) {
    mkdirSync(path);
    const project = await invoke('create_project', { name: basename(path), path });
    projects.push(project.id);
  }
  const file = join(paths[0], 'notas.txt');
  writeFileSync(file, 'Archivo temporal para comprobar referencias y adjuntos.\n');
  let result = await invoke('add_account', { agent: 'codex', label: 'Codex · Perfil QA', configDir: profiles.codex });
  const accountC = result.accounts.find((a) => a.configDir === profiles.codex);
  result = await invoke('add_account', { agent: 'claude', label: 'Claude · Perfil QA', configDir: profiles.claude });
  const accountH = result.accounts.find((a) => a.configDir === profiles.claude);
  result = await invoke('add_account', { agent: 'codex', label: 'Codex · Perfil alternativo QA', configDir: profiles['codex-alt'] });
  const accountAlt = result.accounts.find((a) => a.configDir === profiles['codex-alt']);
  accounts.push(accountC.id, accountH.id, accountAlt.id);
  await setting('accounts.active.codex', accountC.id);
  await setting('accounts.active.claude', accountH.id);

  if (gallery) {
    const id = (await makeConversation(projects[0], 'Galería interactiva · QA')).id;
    const exited = once(processHandle, 'exit');
    await direct(id, 'WIDGET-CALCULATOR', 'codex');
    await finish(id, 'WIDGET-CALCULATOR');
    await direct(id, 'WIDGET-CLAUDE', 'claude');
    await finish(id, 'WIDGET-CLAUDE');
    await load(id, projects[0]);
    await page.locator('.widget-mount').first().waitFor({ state: 'attached' });
    check('Cinco ejemplos cargados en el historial de QA. Cierra la ventana para terminar.');
    await exited;
  } else if (interactive && !queueRegression) {
    const qa = { page, invoke, projectId: projects[0], projectPath: paths[0], session, makeConversation,
      load, direct, enqueue, req, finish, release, poll, evidence, check, startVideo, switchView, switchAgent };
    await checkInteractiveViews(qa);
    if (process.argv.includes('--regression-visual')) await checkVisualPreviews(qa);
  } else if (visual && !queueRegression) {
    await checkSelectorCold({
      boot, close, getPage: () => page, invoke, setting, controls, makeConversation,
      projectId: projects[0], poll, session, evidence, check, finish,
    });
    if (isolated) await checkChatJump({ page, setting, makeConversation, projectId: projects[0], load, release, finish, poll, evidence, check });
    if (!selectorOnly) await checkVisualPreviews({
      page, invoke, projectId: projects[0], projectPath: paths[0], session, makeConversation,
      load, direct, enqueue, req, finish, release, poll, evidence, check, startVideo,
    });
  } else {
  const main = (await makeConversation(projects[0], 'Cola multiagente')).id;
  const other = (await makeConversation(projects[1], 'Cola independiente')).id;
  await load(main, projects[0]);
  await switchAgent('Claude Code');
  await draft().fill('Preparar informe [QA:HOLD-MAIN]');
  await poll(() => button('Enviar mensaje').isEnabled(), 'Enviar sigue deshabilitado');
  await draft().press('Enter');
  await poll(() => starts('HOLD-MAIN').length === 1, 'Claude no inició el turno');
  await checkNoSteer();
  if (!insights && !queueRegression) capture = startVideo();
  await switchAgent('Codex');
  await textToQueue('Revisar las notas @"notas.txt" [QA:LUNA]', true);
  await switchAgent('Claude Code');
  await textToQueue('Encargo que se retirará [QA:DROP]');
  await textToQueue('Redactar resumen [QA:HAIKU]');
  await openQueue();
  await button('Editar encargo 3').click();
  const editor = page.getByRole('textbox', { name: 'Mensaje en cola' });
  assert(await editor.evaluate((element) => element === document.activeElement));
  await editor.fill('Redactar un resumen breve [QA:HAIKU]');
  await wait(400);
  await button('Guardar encargo').click();
  await button('Retirar encargo 2').click();
  await button('Subir encargo 2').click();
  await wait(450);
  await button('Bajar encargo 1').focus();
  await page.keyboard.press('Space');
  await poll(async () => {
    const rows = (await queue(main)).entries;
    return rows.length === 2 && rows[0].input.request.text.includes('[QA:LUNA]') && rows[1].input.request.text.includes('resumen breve');
  }, 'Edición, eliminación o reordenación no persistieron');
  check('Cola por teclado y ratón, edición con foco, retirada y doble clic');

  await switchAgent('Codex');
  await page.getByRole('button', { name: /^Modelo:/ }).click();
  let sol = page.getByRole('button', { name: 'gpt-6.2-sol', exact: true });
  if (!(await sol.isVisible())) await page.getByRole('button', { name: /^Más modelos/ }).click();
  await sol.click();
  await textToQueue('Comprobar la salida final [QA:SOL]');
  await switchAgent('Claude Code');
  await draft().fill('Borrador de la conversación principal');
  const before = await poll(async () => {
    const data = await queue(main);
    return data.entries.length === 3 && data.entries.every((row) => row.input.identity) && data;
  }, 'No se congelaron las tres configuraciones');
  assert.deepEqual(before.entries.map((row) => [row.input.request.agent, row.input.request.model, row.input.request.effort, row.input.target.accountId]),
    [['codex', 'gpt-6-luna', 'high', accountC.id], ['claude', 'haiku', 'medium', accountH.id], ['codex', 'gpt-6.2-sol', 'high', accountC.id]]);
  assert(before.entries[0].input.attachments.some((attachment) => attachment.projectReference && attachment.path === 'notas.txt'));
  await page.screenshot({ path: join(evidence, 'cola-alternada.png') });
  await wait(650);

  await switchView('proyecto-norte', 'Cola independiente');
  await switchAgent('Claude Code');
  // «Encolar para más tarde» ya no está en el compositor: el despacho diferido sigue en el backend.
  await enqueue(req(other, 'OTHER', 'claude'), { accountId: accountH.id, defer: true });
  await poll(async () => (await queue(other)).entries.length === 1, 'La segunda cola no se conservó');
  assert.equal((await queue(other)).pauseReason, 'manual');
  assert.equal(starts('OTHER').length, 0);
  assert.equal((await queue(main)).entries.length, 3);
  await setting('accounts.active.codex', accountAlt.id);
  await switchView('proyecto-orbita', 'Cola multiagente');
  assert.equal(await draft().inputValue(), 'Borrador de la conversación principal');
  await openQueue();
  await button('Pausar cola').click();
  release('HOLD-MAIN');
  await finish(main, 'HOLD-MAIN');
  assert.equal(starts('LUNA').length, 0);
  assert.equal((await queue(main)).pauseReason, 'manual');
  await wait(500);
  await button('Reanudar cola').click();
  await finish(main, 'SOL');
  assert.deepEqual(events().filter((event) => event.type === 'start' && ['LUNA', 'HAIKU', 'SOL'].includes(event.tag))
    .map(({ tag, account, model, effort }) => [tag, account, model, effort]), [
    ['LUNA', 'perfil-codex', 'gpt-6-luna', 'high'], ['HAIKU', 'perfil-claude', 'claude-haiku-5-5', 'medium'],
    ['SOL', 'perfil-codex', 'gpt-6.2-sol', 'high'],
  ]);
  assert.equal(starts('DROP').length, 0);
  assert(events().some((event) => event.type === 'duplicate' && event.tag === 'SOL'));
  assert.equal(await draft().inputValue(), 'Borrador de la conversación principal');
  assert.equal((await queue(main)).entries.length, 0);
  assert.equal(starts('OTHER').length, 0);
  await wait(800);
  if (capture) {
    await capture();
    capture = undefined;
  }
  check('Despacho Claude → Codex → Claude → Codex, sin duplicados y con cuenta, modelo y esfuerzo congelados');
  const reference = button('Abrir notas.txt en Workbench');
  await reference.click();
  await page.getByText('Archivo temporal para comprobar referencias y adjuntos.', { exact: true }).waitFor();
  check('Conversaciones y proyectos independientes, borrador separado y referencia abierta en Workbench');

  await setting('accounts.active.codex', accountC.id);
  const h = (await makeConversation(projects[0], 'Permisos y errores')).id;
  await load(h, projects[0]);
  await switchAgent('Claude Code');
  await draft().fill('[QA:PERMISSION-ONE]');
  await draft().press('Enter');
  await button('Rechazar').waitFor();
  await enqueue(req(h, 'AFTER-PERMISSION'));
  await checkNoSteer();
  await switchView('proyecto-norte', 'Cola independiente');
  assert.equal(starts('AFTER-PERMISSION').length, 0);
  await switchView('proyecto-orbita', 'Permisos y errores');
  await button('Rechazar').click();
  const declined = await finish(h, 'PERMISSION-ONE');
  assert(declined.items.some((item) => item.status === 'declined'));
  await finish(h, 'AFTER-PERMISSION');
  check('Autorización bloquea la cola, sobrevive al cambio de vista y el rechazo de Claude no es fallo');

  await draft().fill('[QA:HOLD-CLAUDE-CANCEL]');
  await draft().press('Enter');
  await poll(() => starts('HOLD-CLAUDE-CANCEL').length === 1, 'No se inició el turno de Claude para cancelarlo');
  await stop().click();
  await finish(h, 'HOLD-CLAUDE-CANCEL', 'cancelled');
  assert.equal((await queue(h)).pauseReason, 'cancelled');

  const auth = (await makeConversation(projects[0], 'Permisos de Codex')).id;
  await load(auth, projects[0]);
  const permission = (name) => events().find((event) => event.type === 'codex-permission' && event.name === 'approval-' + name);
  await enqueue(req(auth, 'HOLD-APPROVAL'), { accountId: accountC.id });
  await button('Rechazar').waitFor();
  assert.equal(await button('Rechazar').count(), 1);
  const oldDecision = await poll(() => permission('old'), 'Codex no contestó al turno anterior');
  assert.equal(oldDecision.decision, 'decline');
  assert.equal(await button('Aprobar en esta sesión').count(), 0);
  await button('Aprobar').click();
  const approval = await poll(() => permission('current'), 'Codex no contestó al turno activo');
  assert.equal(approval.decision, 'accept');
  release('HOLD-APPROVAL');
  await finish(auth, 'HOLD-APPROVAL');
  check('Permisos Codex ligados al turno exacto y limitados a las opciones que ofrece el proveedor');
  if (isolated) {
    await setting('codex.sandbox', 'read-only');
    try {
      await direct(auth, 'SANDBOX-REJECT', 'codex');
      const failed = await finish(auth, 'SANDBOX-REJECT', 'failed');
      assert.match(failed.error, /vuelve a iniciar sesión/);
      assert.doesNotMatch(failed.error, /qa-canario/);
      await direct(auth, 'SANDBOX-INCOMPLETE', 'codex');
      assert.match((await finish(auth, 'SANDBOX-INCOMPLETE', 'failed')).error, /no confirmó el inicio/);
      await direct(auth, 'SANDBOX-VERIFY', 'codex');
      await finish(auth, 'SANDBOX-VERIFY');
      const attempts = events().filter((event) => event.type === 'policy');
      assert.equal(new Set(attempts.map((event) => event.threadId)).size, 1);
      assert.deepEqual(attempts.map((event) => event.policy), ['readOnly', 'readOnly', 'readOnly']);
      check('Codex vuelve a enviar la política restrictiva tras un rechazo o respuesta incompleta, con diagnóstico sin datos crudos');
    } finally { await setting('codex.sandbox', null); }
  }
  const f = (await makeConversation(projects[0], 'Fallo y cancelación')).id;
  await load(f, projects[0]);
  await enqueue(req(f, 'HOLD-CANCEL'));
  await enqueue(req(f, 'FAIL'));
  await poll(() => starts('HOLD-CANCEL').length === 1, 'No arrancó la ejecución para cancelar');
  await stop().click();
  await finish(f, 'HOLD-CANCEL', 'cancelled');
  assert.equal((await poll(() => permission('late'), 'Codex no respondió al permiso durante la cancelación')).decision, 'cancel');
  assert.equal(starts('FAIL').length, 0);
  assert.equal((await queue(f)).pauseReason, 'cancelled');
  await enqueue(req(f, 'AFTER-FAIL'));
  await remove(f, 'HOLD-CANCEL');
  await update(f, { type: 'resume' });
  await finish(f, 'FAIL', 'failed');
  assert.equal((await queue(f)).pauseReason, 'failed');
  assert.equal(starts('AFTER-FAIL').length, 0);
  check('Detener Claude y Codex o fallar pausa la cola y requiere una decisión');

  const config = (await makeConversation(projects[0], 'Configuración congelada')).id;
  const blocked = (tag) => poll(async () => {
    const row = (await queue(config)).entries.find((entry) => entry.state === 'blocked' && entry.input.request.text.includes(tag));
    return row || false;
  }, 'El proveedor no bloqueó ' + tag);
  const frozen = (tag) => poll(async () => {
    const row = (await queue(config)).entries.find((entry) => entry.input.request.text.includes(tag));
    return row?.input.identity;
  }, 'No se verificó la identidad de ' + tag);
  await enqueue(req(config, 'RETIRED', 'codex', 'gpt-6.2-sol'), { defer: true, accountId: accountC.id });
  await frozen('RETIRED');
  controls('codex', { retired: 'gpt-6.2-sol' });
  await update(config, { type: 'resume' });
  assert.match((await blocked('RETIRED')).detail, /modelo/i);
  assert.equal(starts('RETIRED').length, 0);
  await remove(config, 'RETIRED');
  controls('codex', {});
  await enqueue(req(config, 'ACCOUNT-CHANGED'), { defer: true, accountId: accountAlt.id });
  await frozen('ACCOUNT-CHANGED');
  controls('codex-alt', { identity: 'otro-usuario' });
  await update(config, { type: 'resume' });
  assert.match((await blocked('ACCOUNT-CHANGED')).detail, /identidad/i);
  await remove(config, 'ACCOUNT-CHANGED');
  controls('codex-alt', {});
  await enqueue(req(config, 'ACCOUNT-GONE'), { defer: true, accountId: accountAlt.id });
  await frozen('ACCOUNT-GONE');
  await invoke('remove_account', { id: accountAlt.id });
  await update(config, { type: 'resume' });
  assert.match((await blocked('ACCOUNT-GONE')).detail, /cuenta/i);
  await remove(config, 'ACCOUNT-GONE');
  // Un override inexistente hace que la detección normal busque la CLI instalada. Un
  // binario de QA que sale al invocarlo evita acceso accidental a la CLI real.
  const unavailable = join(session, 'offline.cmd');
  writeFileSync(unavailable, '@exit /b 1\r\n');
  await setting('agents.codex.path', unavailable);
  await enqueue(req(config, 'PROVIDER-GONE'), { defer: true, accountId: accountC.id });
  await update(config, { type: 'resume' });
  await blocked('PROVIDER-GONE');
  await setting('agents.codex.path', executables.codex);
  assert.equal(events().filter((entry) => ['ACCOUNT-GONE', 'ACCOUNT-CHANGED', 'PROVIDER-GONE'].includes(entry.tag)).length, 0);
  check('Modelo retirado, identidad cambiada, cuenta eliminada y proveedor no disponible bloquean sin sustituciones');

  const steerConversation = (await makeConversation(projects[0], 'Intervención en Codex')).id;
  await load(steerConversation, projects[0]);
  await enqueue(req(steerConversation, 'HOLD-STEER'));
  await steer().waitFor();
  await draft().fill('QA-REJECT');
  await steer().click();
  await page.getByText(/Codex rechazó la operación/).waitFor();
  assert.equal(await draft().inputValue(), 'QA-REJECT');
  await draft().fill('Entrega la clave CONTROLADO-7');
  await steer().click();
  await page.getByText('Intervención aceptada por Codex', { exact: true }).waitFor();
  const steered = await poll(async () => (await history(steerConversation)).find((message) =>
    message.role === 'assistant' && message.status === 'done' && message.content.includes('CONTROLADO-7')), 'No se vio el efecto de Steer en el turno simulado');
  const start = starts('HOLD-STEER')[0];
  const steerEvent = events().find((event) => event.type === 'steer' && event.tag === 'HOLD-STEER');
  assert.deepEqual([steerEvent.threadId, steerEvent.turnId], [start.threadId, start.turnId]);
  assert.equal((await history(steerConversation)).find((row) => row.contextNote?.steer === 'accepted').contextNote.parentMessageId, steered.id);
  assert.equal(starts('HOLD-STEER').length, 1);
  await page.screenshot({ path: join(evidence, 'steer-webview2.png') });
  check('Steer simulado rechaza sin perder borrador y acepta en threadId/turnId activos, con historial');
  let insightState;
  if (insights) {
    const rows = await invoke('insights_usage', { scope: { conversationId: steerConversation, projectId: null, days: null } });
    assert.equal(rows.reduce((total, row) => total + row.runs, 0), 1);
    assert.equal(rows[0].inputTokens, 1000);
    const cancelRows = await invoke('insights_usage', { scope: { conversationId: f, projectId: null, days: null } });
    assert.equal(cancelRows[0].cancelled, 1);
    assert.equal(cancelRows[0].failed, 1);
    assert.equal(cancelRows[0].inputTokens, 500);
    assert.equal(cancelRows[0].inputCount, 1);
    const cancelled = await finish(f, 'HOLD-CANCEL', 'cancelled');
    const cancelInsight = await invoke('run_insights', { messageId: cancelled.id });
    assert.equal(cancelInsight.details.plans[0].tasks[0].status, 'running');
    check('Steer aporta solicitudes al mismo turno, y fallos y cancelaciones conservan cobertura');
    insightState = await checkAgentInsights({
      page, invoke, makeConversation, projectId: projects[0], accountId: accountC.id,
      direct, finish, load, enqueue, req, history, poll, evidence, check,
    });
  }

  const interrupted = (await makeConversation(projects[0], 'Cierre con ejecución activa')).id;
  const durable = (await makeConversation(projects[1], 'Cierre con resultado en proveedor')).id;
  await load(interrupted, projects[0]);
  await enqueue(req(interrupted, 'HOLD-CRASH'), { accountId: accountC.id });
  await enqueue({ ...req(interrupted, 'PENDING-CRASH', 'claude'), attachments: [file] }, { accountId: accountH.id });
  await enqueue(req(interrupted, 'PENDING-SECOND'), { accountId: accountC.id });
  await enqueue(req(durable, 'DURABLE-CRASH'), { accountId: accountC.id });
  await poll(() => starts('HOLD-CRASH').length === 1 && starts('DURABLE-CRASH').length === 1, 'Faltan los turnos de cierre');
  await button('Rechazar').waitFor();
  await draft().fill('Borrador recuperable después del cierre');
  await invoke('set_draft_attachments', { conversationId: interrupted, paths: [file] });
  await wait(600);
  release('DURABLE-CRASH');
  await poll(() => accepted('DURABLE-CRASH')?.silent, 'No se guardó el estado del proveedor simulado');
  assert(await active(interrupted));
  assert(await active(durable));
  await crash();

  const restored = await boot();
  const last = restored.conversations.find((c) => c.id === interrupted);
  assert.equal(last.draft, 'Borrador recuperable después del cierre');
  assert.deepEqual(last.draftAttachments, [file]);
  const pending = await queue(interrupted);
  assert.equal(pending.pauseReason, 'restart');
  assert.deepEqual(pending.entries.map((row) => row.state), ['review', 'pending', 'pending']);
  assert.deepEqual(pending.entries.map((row) => row.input.request.agent), ['codex', 'claude', 'codex']);
  assert.equal(pending.entries[1].input.target.accountId, accountH.id);
  assert.deepEqual(pending.entries[1].input.request.attachments, [file]);
  assert.equal((await history(interrupted)).at(-1).status, 'interrupted');
  assert.equal(permission('crash'), undefined);
  if (insightState) {
    await checkInsightsRestart(invoke, insightState, direct, finish);
    const crashed = (await history(interrupted)).at(-1);
    assert.equal((await invoke('run_insights', { messageId: crashed.id })).metrics.inputTokens, 500);
    const rows = await invoke('insights_usage', { scope: { conversationId: interrupted, projectId: null, days: null } });
    assert.equal(rows[0].runs, 1);
    assert.equal(rows[0].interrupted, 1);
    assert.equal(rows[0].durationCount, 0);
    assert.equal(rows[0].partial, 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    } finally {
      db.close();
    }
    check('Planes, delegaciones y estadísticas tras reinicio, snapshots parciales y comprobaciones SQLite');
  }
  assert.equal((await queue(other)).pauseReason, 'manual');
  assert.equal((await queue(other)).entries.length, 1);
  assert.equal(starts('OTHER').length, 0);
  assert.equal(starts('HOLD-CRASH').length, 1);
  assert.equal(readFileSync(join(session, 'efecto-antes-del-cierre.txt'), 'utf8').trim().split('\n').length, 1);
  assert.equal(starts('PENDING-CRASH').length, 0);
  await assert.rejects(update(interrupted, { type: 'resume' }));
  const durableRow = (await queue(durable)).entries[0];
  assert.match(await invoke('reconcile_queued_message', { conversationId: durable, id: durableRow.id }), /confirmó que el turno terminó/);
  assert.equal((await history(durable)).at(-1).status, 'done');
  assert.equal((await queue(durable)).pauseReason, 'restart');
  await load(interrupted, projects[0]);
  await openQueue();
  await page.screenshot({ path: join(evidence, 'recuperacion-sqlite.png') });
  await button('Vaciar cola').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal((await queue(interrupted)).entries.length, 3);
  await button('Vaciar cola').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Vaciar cola', exact: true }).click();
  await poll(async () => (await queue(interrupted)).entries.length === 0, 'No se vació la cola confirmada');
  assert.equal(starts('HOLD-CRASH').length, 1);
  assert.equal(starts('PENDING-CRASH').length, 0);
  check('Cierre forzado con dos ejecuciones, SQLite, borradores y adjuntos recuperados sin repetir efectos');
  check('Reconciliación de un turno exacto por thread/read, conservación de la pausa y vaciado confirmado');
  assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  assert.equal(await page.locator('.execution-queue').evaluate((node) => getComputedStyle(node).animationName), 'none');
  check('WebView2 con preferencia de movimiento reducido');
  if (insightState) {
    assert(insightState.focusReturned, 'Estadísticas debe devolver el foco a la conversación');
    check('Estadísticas devuelve el foco a la conversación al navegar por teclado');
  }
  }
  assert.deepEqual(pageErrors, []);
} catch (err) {
  failure = err;
  console.error(err);
  await page?.screenshot({ path: join(evidence, 'fallo-webview2.png') }).catch(() => {});
} finally {
  if (capture) await capture().catch((err) => console.error(err));
  await close().catch((err) => console.error(err));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON');
  for (const id of projects) db.prepare('DELETE FROM projects WHERE id=?').run(id);
  for (const id of accounts) db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  for (const [key, value] of savedSettings) {
    if (value === undefined) db.prepare('DELETE FROM settings WHERE key=?').run(key);
    else db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, value);
  }
  db.close();
  writeFileSync(join(evidence, 'verificacion-webview2.json'), JSON.stringify({
    ok: !failure, checks, pageErrors, failure: failure ? String(failure.stack ?? failure) : null,
    session: basename(session), webviewVersion, mockProviders: ['Claude Code', 'Codex'],
  }, null, 2));
}
if (failure) process.exitCode = 1;

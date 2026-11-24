// Validación de Duovra 1.0.0 Beta 2 en WebView2 real con proveedores simulados.
// Uso habitual: node scripts/qa/beta2-build.mjs && node scripts/qa/beta2-webview.mjs
// --personal-beta usa el perfil desechable de la candidata. --no-capture reutiliza la evidencia anterior.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { beta } from '../personal-beta-config.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const personalBeta = process.argv.includes('--personal-beta');
const capture = !process.argv.includes('--no-capture');
const qaBuild = join(root, 'output', 'qa', 'beta2');
const out = resolve(process.env.DUOVRA_QA_OUTPUT ?? (personalBeta ? beta.qa : qaBuild));
const exe = personalBeta ? beta.executable : join(qaBuild, 'app', 'Duovra Beta 2 QA.exe');
assert(existsSync(exe), 'Compila con node scripts/qa/beta2-build.mjs');
const shots = join(out, 'capturas');
mkdirSync(shots, { recursive: true });
const session = mkdtempSync(join(out, 'sesion-'));
const fixture = fileURLToPath(new URL('execution-queue-agent.mjs', import.meta.url));
const profiles = Object.fromEntries(['codex', 'claude'].map((agent) => [agent, join(session, 'perfil-' + agent)]));
for (const path of Object.values(profiles)) mkdirSync(path);
const executables = Object.fromEntries(['codex', 'claude'].map((agent) => {
  const path = join(session, agent + '.cmd');
  writeFileSync(path, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" ' + agent + ' %*\r\n');
  return [agent, path];
}));
const project = join(session, 'proyecto');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(join(project, 'src', 'math.js'), 'export function suma(a, b) {\n  return a + b;\n}\n');
const profileId = personalBeta ? randomUUID() : null;
const dbDir = personalBeta ? join(process.env.APPDATA, beta.identifier, 'fixtures', profileId)
  : join(process.env.APPDATA, 'dev.duovra.studio.qa.beta2');
if (!personalBeta) rmSync(dbDir, { recursive: true, force: true });
mkdirSync(dbDir, { recursive: true });
const fixtureDb = new DatabaseSync(join(dbDir, 'studio.sqlite3'));
try {
  fixtureDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const set = fixtureDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [agent, path] of Object.entries(executables)) set.run('agents.' + agent + '.path', JSON.stringify(path));
} finally {
  fixtureDb.close();
}

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(webview2_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home)$/i.test(name)) delete env[name];
}
Object.assign(env, {
  CODEX_HOME: profiles.codex, CLAUDE_CONFIG_DIR: profiles.claude,
  DUOVRA_QUEUE_FIXTURE: session, WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'),
});
if (personalBeta) env[beta.profileVariable] = profileId;

const checks = [];
const pageErrors = [];
let processHandle, browser, page, webviewVersion;
const logFile = join(session, 'provider.ndjson');
const events = () => existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const starts = (tag) => events().filter((e) => e.type === 'start' && e.tag === tag);
const check = (label) => { checks.push(label); console.log('PASS', label); };

async function poll(fn, description, timeout = 15_000) {
  const start = Date.now();
  let lastError;
  do {
    try { const v = await fn(); if (v) return v; } catch (err) { lastError = err; }
    await wait(80);
  } while (Date.now() - start < timeout);
  throw new Error(description, { cause: lastError });
}

async function boot() {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  processHandle = spawn(exe, [], { cwd: dirname(exe), env: {
    ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
  }, stdio: 'ignore', windowsHide: false });
  const endpoint = 'http://127.0.0.1:' + port;
  await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'WebView2 no abrió su puerto local', 30_000);
  browser = await chromium.connectOverCDP(endpoint);
  webviewVersion = browser.version();
  page = await poll(() => browser.contexts()[0]?.pages()[0], 'No apareció la página de WebView2');
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const boot = await invoke('bootstrap');
  assert.equal(boot.settings['agents.codex.path'], executables.codex, 'No se abrió el perfil SQLite de QA');
  assert.equal(boot.settings['agents.claude.path'], executables.claude, 'No se abrió el perfil SQLite de QA');
  await page.bringToFront();
}

async function shutdown() {
  await browser?.close().catch(() => undefined);
  if (processHandle && processHandle.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true });
    await wait(600);
  }
}

const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const setting = (key, value) => invoke('set_setting', { key, value });
const input = () => page.getByRole('textbox', { name: 'Mensaje', exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const shot = async (name, clip) => {
  if (!capture) return;
  await wait(220);
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 7000 }).catch(() => undefined);
  await page.screenshot({ path: join(shots, name + '.png'), ...(clip ? { clip } : {}) });
  console.log('Captura', name);
};
const resize = (width, height) => page.evaluate(([w, h]) => window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', {
  label: 'main', value: { Logical: { width: w, height: h } },
}), [width, height]).catch(() => page.setViewportSize({ width, height }));
const messages = (conversationId) => invoke('list_messages', { conversationId }).then((r) => r.messages);
const queue = (conversationId) => invoke('message_queue', { conversationId });
async function sendText(text) {
  await input().fill(text);
  await input().press('Enter');
  await poll(async () => (await input().inputValue()) === '', 'El compositor no se vació tras enviar');
}
const assistantDone = (cid, count) => poll(async () => (await messages(cid)).filter((m) => m.role === 'assistant' && m.status !== 'running').length >= count,
  'El turno no terminó', 20_000);

async function recordScreencast(name, action) {
  if (!capture) {
    await action();
    return null;
  }
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', ({ sessionId, data, metadata }) => {
    frames.push({ data, time: metadata.timestamp });
    void client.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  await action();
  await client.send('Page.stopScreencast');
  await client.detach();
  const dir = mkdtempSync(join(session, 'fotogramas-'));
  const list = ['ffconcat version 1.0'];
  for (const [i, frame] of frames.entries()) {
    const file = i.toString().padStart(4, '0') + '.jpg';
    writeFileSync(join(dir, file), frame.data, 'base64');
    list.push("file '" + file + "'");
    const interval = frames[i + 1] ? frames[i + 1].time - frame.time : 0.5;
    list.push('duration ' + Math.max(1 / 60, Math.min(2, interval)).toFixed(4));
  }
  list.push("file '" + (frames.length - 1).toString().padStart(4, '0') + ".jpg'");
  writeFileSync(join(dir, 'video.ffconcat'), list.join('\n'));
  const video = join(out, name + '.mp4');
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'video.ffconcat',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24', '-c:v', 'libx264', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video,
  ], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  rmSync(dir, { recursive: true, force: true });
  console.log('Vídeo', video, frames.length, 'fotogramas');
  return frames.length;
}

/** Comprueba que el título está centrado sobre la conversación y no pisa otros controles. */
async function checkTitle(label) {
  const geo = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    const title = r('.titlebar-title-text');
    const crumbs = r('.titlebar-crumbs');
    const trailing = r('.titlebar-trailing');
    const chat = r('.chat-stage');
    return { title: title && { left: title.left, right: title.right }, crumbs: crumbs?.right, trailing: trailing?.left,
      chat: chat && { left: chat.left, right: chat.right }, inThread: document.querySelectorAll('.thread-title').length,
      truncated: (() => { const el = document.querySelector('.titlebar-title-text'); return el ? el.scrollWidth > el.clientWidth : null; })() };
  });
  assert(geo.title && geo.chat, 'Falta el título o el área de conversación');
  assert.equal(geo.inThread, 0, 'El título grande sigue dentro de la conversación');
  assert(geo.title.left >= geo.crumbs + 4, 'El título pisa el selector de proyecto (' + label + ')');
  assert(geo.title.right <= geo.trailing - 4, 'El título pisa Workbench o los controles de ventana (' + label + ')');
  const center = (geo.title.left + geo.title.right) / 2;
  const chatCenter = (geo.chat.left + geo.chat.right) / 2;
  return { offset: Math.round(center - chatCenter), truncated: geo.truncated };
}

let failure;
try {
  await boot();
  await page.evaluate(() => localStorage.clear());
  for (const [key, value] of Object.entries({
    'agents.codex.path': executables.codex, 'agents.claude.path': executables.claude,
    'defaults.agent': 'codex', 'defaults.model.codex': 'gpt-6-luna', 'defaults.effort.codex': 'high',
    'defaults.model.claude': 'haiku', 'defaults.effort.claude': 'medium', 'composer.enterToSend': true,
    'startup.view': 'last', 'startup.restoreConversation': true,
  })) await setting(key, value);
  const created = await invoke('create_project', { name: 'Proyecto Beta 2', path: project });
  const conv = await invoke('create_conversation', { projectId: created.id, title: 'Revisión de la experiencia de Duovra Beta 2 con un título largo para comprobar la elipsis' });
  await setting('ui.lastProjectId', created.id);
  await setting('ui.lastConversationId', conv.id);
  await page.reload();
  await input().waitFor();
  await page.locator('.studio-intro').waitFor({ state: 'hidden' }).catch(() => undefined);

  // ---------- Estadísticas vacías y Apariencia ----------
  await page.getByRole('button', { name: 'Ajustes' }).first().click();
  await page.locator('.settings-nav', { hasText: 'Estadísticas' }).click();
  await page.getByText('Sin actividad en los últimos 7 días').waitFor();
  check('Estadísticas sin datos: estado vacío explícito y periodo predeterminado de 7 días');
  await shot('08b-estadisticas-vacias');
  await page.locator('.settings-nav', { hasText: 'Apariencia' }).click();
  await page.getByRole('heading', { name: 'Apariencia' }).waitFor();
  await shot('09-ajustes-apariencia');
  await page.locator('.setting-row', { hasText: 'Espacio entre mensajes' }).getByRole('radio', { name: 'Compacta', exact: true }).click();
  await poll(() => page.evaluate(() => document.documentElement.dataset.density === 'compact'), 'La densidad no se aplicó');
  await page.locator('.setting-row', { hasText: 'Texto de la conversación' }).getByRole('radio', { name: 'Grande', exact: true }).click();
  await poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-reading').trim() === '15.5px'), 'El texto de lectura no se aplicó');
  await page.locator('.setting-row', { hasText: 'Animaciones de las mascotas' }).getByRole('radio', { name: 'Discretas', exact: true }).click();
  await poll(() => page.evaluate(() => document.documentElement.dataset.mascots === 'subtle'), 'El ajuste de mascotas no se aplicó');
  check('Apariencia: densidad, texto de lectura y mascotas modifican variables reales al instante');
  await page.locator('.settings-nav', { hasText: 'Agentes y modelos' }).click();
  await page.getByRole('heading', { name: 'Agentes y modelos' }).waitFor();
  // Beta 2: vista completa con «Volver a la conversación». En la versión estable, diálogo superpuesto con «Cerrar Ajustes».
  await page.getByRole('button', { name: /^(Volver a la conversación|Cerrar Ajustes)$/ }).click();
  await input().waitFor();

  // ---------- Cabecera: 1440 y 960, Workbench abierto y cerrado ----------
  await resize(1440, 900);
  await wait(400);
  const t1 = await checkTitle('1440 sin Workbench');
  assert(Math.abs(t1.offset) <= 2, 'El título no está centrado sobre la conversación (' + t1.offset + ' px)');
  await shot('01-cabecera-1440');
  await button('Mostrar Workbench').click();
  await page.locator('#workbench').waitFor();
  await wait(300);
  const t2 = await checkTitle('1440 con Workbench');
  await button('Ocultar Workbench').click();
  await resize(960, 800);
  await wait(500);
  const t3 = await checkTitle('960');
  await resize(1440, 900);
  await wait(400);
  check(`Cabecera: título único, centrado sobre la conversación (desvío ${t1.offset} / ${t2.offset} / ${t3.offset} px) y sin solaparse a 1440 y 960`);

  // ---------- Actividad compacta de Codex y razonamiento ----------
  await sendText('Añade resta(a, b) [QA:ACTIVITY-CODEX]');
  await assistantDone(conv.id, 1);
  const head = page.locator('.activity-head').last();
  await poll(async () => /operaciones realizadas · 1 archivo modificado/.test(await head.innerText()), 'La actividad de Codex no se resumió');
  assert.equal(await page.getByText('El proveedor no comparte el contenido del razonamiento').count(), 0);
  await head.click();
  await poll(async () => (await page.locator('.activity[data-open] .step-title', { hasText: 'Resumen del razonamiento' }).count()) === 1, 'El resumen de razonamiento no aparece una sola vez');
  assert.equal(await page.locator('.activity[data-open] .step-title', { hasText: 'Leyó' }).count(), 1);
  assert.equal(await page.locator('.activity[data-open] .step-title', { hasText: 'Buscó' }).count(), 1);
  check('Codex: una tarjeta compacta, razonamientos vacíos ocultos, un resumen legible y lecturas/búsquedas clasificadas por commandActions');
  await shot('02-actividad-codex');
  await head.click();

  // ---------- Selector de esfuerzo ----------
  await page.locator('.effort-btn').click();
  const options = page.getByRole('menuitemradio');
  await poll(async () => (await options.count()) === 2, 'El menú de esfuerzo no muestra solo los niveles del modelo');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-checked')), 'true');
  await shot('03-selector-esfuerzo');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await poll(async () => (await page.locator('.effort-btn').getAttribute('aria-label')) === 'Esfuerzo: Medio', 'El teclado no eligió el esfuerzo');
  assert.equal(await page.locator('.popover[data-state="open"]').count(), 0, 'El menú no se cerró al elegir');
  await page.locator('.effort-btn').click();
  await page.getByRole('menuitemradio', { name: 'Alto' }).click();
  check('Esfuerzo: menú con filas, check, foco en el actual, teclado y cierre al elegir');

  // ---------- Modo rápido antes de enviar y durante la ejecución ----------
  const fast = page.locator('.fast-btn');
  await fast.waitFor();
  assert.equal(await fast.getAttribute('aria-pressed'), 'false');
  await fast.click();
  await poll(async () => (await fast.getAttribute('aria-pressed')) === 'true', 'El modo rápido no se activó');
  await shot('04-modo-rapido', { x: 0, y: 700, width: 1440, height: 200 });
  await sendText('Trabajo largo [QA:ACTIVITY-HOLD-F1]');
  await poll(() => starts('ACTIVITY-HOLD-F1').length === 1, 'El turno rápido no empezó');
  assert.equal(starts('ACTIVITY-HOLD-F1')[0].speed, 'priority');
  await fast.click();
  await poll(async () => (await fast.getAttribute('aria-pressed')) === 'false', 'El modo rápido no se desactivó durante la ejecución');
  check('Modo rápido: elegido antes de enviar llega como serviceTierForTurn=priority; cambiarlo durante la ejecución no altera el turno en curso');
  await button('Intervenir en el turno activo de Codex').waitFor();
  check('Steer de Codex sigue disponible como acción explícita separada de Enviar');

  // ---------- Envío automático a la cola: tres envíos rápidos ----------
  for (const tag of ['HOLD-Q1', 'HOLD-Q2', 'HOLD-Q3']) await sendText('Encargo ' + tag + ' [QA:' + tag + ']');
  let view = await queue(conv.id);
  assert.equal(view.entries.length, 3, 'Los envíos durante la ejecución no se encolaron');
  assert.deepEqual(view.entries.map((e) => e.input.request.speed), ['default', 'default', 'default']);
  assert.equal(starts('HOLD-Q1').length + starts('HOLD-Q2').length + starts('HOLD-Q3').length, 0, 'Un mensaje encolado empezó en paralelo');
  assert.equal(await page.locator('.composer-defer').count(), 0, 'Sigue el botón específico de encolar');
  check('Enviar durante una ejecución encola automáticamente (3 envíos seguidos, ninguno en paralelo) y conserva el modo elegido al enviar');
  // Carrera en el backend: tres submit_message simultáneos en otra conversación libre.
  const race = await invoke('create_conversation', { projectId: created.id, title: 'Carrera' });
  const req = (n) => ({ conversationId: race.id, agent: 'codex', model: 'gpt-6-luna', effort: 'high', text: 'Carrera [QA:HOLD-R' + n + ']', attachments: [], speed: 'default' });
  const results = await page.evaluate((reqs) => Promise.all(reqs.map((r) => window.__TAURI_INTERNALS__.invoke('submit_message', { id: crypto.randomUUID(), request: r, accountId: null })
    .then((x) => x.mode))), [req(1), req(2), req(3)]);
  assert.deepEqual([...results].sort(), ['queued', 'queued', 'started'], 'La carrera inició más de una ejecución: ' + results.join(','));
  await poll(() => ['HOLD-R1', 'HOLD-R2', 'HOLD-R3'].reduce((n, t) => n + starts(t).length, 0) === 1, 'La carrera no dejó una sola ejecución');
  check('Carrera: tres submit_message simultáneos sobre una conversación libre producen una ejecución y dos encargos en cola');

  // Dos agentes y modelos distintos en la cola.
  await page.locator('.agent-btn').click();
  await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click();
  await sendText('Revisión de Claude [QA:HOLD-QC]');
  view = await queue(conv.id);
  assert.equal(view.entries.at(-1).input.request.agent, 'claude');
  assert.equal(view.entries.at(-1).input.request.model, 'haiku');
  check('Cola con dos agentes y modelos distintos (Codex gpt-6-luna/Alto y Claude Code haiku/Medio)');
  for (let i = 0; i < 6; i++) await invoke('enqueue_message', { id: crypto.randomUUID(), request: { conversationId: conv.id, agent: 'codex', model: 'gpt-6-luna', effort: 'medium', text: 'Encargo adicional ' + (i + 1) + ' [QA:HOLD-X' + i + ']', attachments: [], speed: 'default' }, accountId: null, defer: false });
  await page.waitForFunction(() => document.querySelector('.queue-more')?.textContent?.includes('+9'));
  await shot('05-cola-contraida');
  await page.locator('.queue-next').click();
  await page.locator('.execution-queue-body:not([hidden])').waitFor();
  const body = await page.locator('.execution-queue-body').evaluate((el) => ({ h: el.getBoundingClientRect().height, scroll: el.querySelector('.queue-entries').scrollHeight > el.querySelector('.queue-entries').clientHeight }));
  assert(body.h <= 342, 'La cola desplegada supera su altura máxima');
  assert(body.scroll, 'La cola de diez encargos no tiene desplazamiento propio');
  assert(await input().isVisible(), 'El compositor no sigue visible con la cola desplegada');
  await shot('06-cola-expandida');
  check('Cola: contraída en una fila con «Siguiente» y «+9 pendientes»; desplegada con altura máxima, scroll propio y compositor visible');
  // Pausar, reanudar, reordenar y editar.
  await button('Pausar cola').click();
  await poll(async () => (await queue(conv.id)).pauseReason === 'manual', 'La cola no se pausó');
  const before = (await queue(conv.id)).entries.map((e) => e.id);
  await button('Bajar encargo 1').click();
  await poll(async () => (await queue(conv.id)).entries[1].id === before[0], 'No se reordenó');
  await button('Editar encargo 1').click();
  await page.getByRole('textbox', { name: 'Mensaje en cola' }).fill('Encargo HOLD-Q2 editado [QA:HOLD-Q2]');
  await button('Guardar encargo').click();
  await poll(async () => (await queue(conv.id)).entries[0].input.request.text.includes('editado'), 'No se guardó la edición');
  await button('Reanudar cola').click();
  await poll(async () => (await queue(conv.id)).pauseReason === null, 'La cola no se reanudó');
  await page.locator('.queue-next').click();
  check('Cola: pausa, reanudación, reordenación y edición desde la bandeja');

  // ---------- Workbench y mascotas durante la ejecución ----------
  await button('Mostrar Workbench').click();
  await page.locator('.activity-panel').waitFor();
  await page.locator('.ap-status', { hasText: 'En curso' }).waitFor();
  await shot('07-workbench');
  check('Workbench abre en Actividad con el turno en curso del mismo proveedor (Codex)');
  await button('Ocultar Workbench').click();

  // ---------- campo de luz y mascotas: reposo, trabajo, finalización ----------
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setting('appearance.mascots', 'full');
  await page.locator('.stage-mascot .mascot').waitFor();
  await shot('11-campo-trabajando');
  const stageClip = await page.locator('.composer-wrap').boundingBox();
  await shot('12-mascota-trabajando', { x: stageClip.x, y: stageClip.y - 20, width: stageClip.width, height: Math.min(260, stageClip.height + 20) });
  const workRunning = await page.locator('[data-activity][aria-hidden="true"]').getAttribute('data-running');
  assert.equal(workRunning, 'true', 'campo de luz debe animarse durante el turno');
  // Cancelar la ejecución activa: la cola queda pausada y no arranca el siguiente.
  await page.getByRole('button', { name: 'Cancelar ejecución' }).click();
  await poll(async () => (await queue(conv.id)).pauseReason === 'cancelled', 'Cancelar no pausó la cola');
  assert.equal(starts('HOLD-Q2').length, 0, 'Tras cancelar empezó otro encargo');
  check('Cancelar la ejecución pausa la cola y no despacha el siguiente');

  // ---------- Reinicio con cola pendiente ----------
  const pending = (await queue(conv.id)).entries.length;
  await shutdown();
  await boot();
  await input().waitFor();
  const restored = await queue(conv.id);
  assert.equal(restored.entries.length, pending, 'La cola pendiente no sobrevivió al reinicio');
  assert(restored.pauseReason, 'La cola recuperada no quedó pausada para revisión');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.density), 'compact', 'La densidad no se conservó al reiniciar');
  check(`Reinicio: ${pending} encargos conservados en orden y pausados; Apariencia persistente`);
  await page.locator('.queue-next').click();
  await button('Vaciar cola').click();
  await page.getByRole('button', { name: 'Vaciar cola' }).last().click();
  await poll(async () => (await queue(conv.id)).entries.length === 0, 'No se vació la cola');
  await page.locator('.queue-next').click().catch(() => undefined);

  const pickAgent = async (name) => {
    if ((await page.locator('.agent-btn').getAttribute('aria-label')).includes(name)) return;
    await page.locator('.agent-btn').click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  await pickAgent('Codex');
  // Reposo con el campo vivo y vídeo breve reposo → trabajo → finalización.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('Escape');
  await poll(async () => await page.locator('[data-activity][aria-hidden="true"]').getAttribute('data-running') === 'true',
    'campo de luz debe mantener la deriva en reposo');
  const idleRunning = await page.locator('[data-activity][aria-hidden="true"]').getAttribute('data-running');
  await shot('10-campo-reposo');
  const frames = await recordScreencast('animaciones-beta2', async () => {
    await wait(2500);
    await page.mouse.move(500, 650);
    await page.mouse.move(1100, 700, { steps: 12 });
    await sendText('Turno breve [QA:ACTIVITY-VIDEO]');
    await poll(() => starts('ACTIVITY-VIDEO').length === 1, 'Enviar con la cola vacía y pausada no inició el turno');
    await wait(2600);
    await assistantDone(conv.id, 3).catch(() => undefined);
    await wait(2200);
  });
  check('Con la cola vacía tras revisar una pausa, Enviar inicia el turno (levanta la pausa con las comprobaciones de Reanudar)');
  check(`campo de luz: en reposo data-running=${idleRunning} (deriva ambiental), trabajando data-running=${workRunning}`
    + (frames ? `; vídeo de ${frames} fotogramas` : ''));
  await shot('12b-mascota-completado');

  // ---------- Mascotas: estados reales del turno (Codex) y error (Claude) ----------
  const stateShots = [];
  const stageShot = async (state) => {
    await page.locator('.agent-activity[data-s="' + state + '"]').waitFor({ timeout: 15000 });
    if (!capture) return;
    await wait(900);
    const box = await page.locator('.agent-activity').boundingBox();
    const file = join(session, 'mascota-' + state + '.png');
    await page.screenshot({ path: file, clip: { x: box.x, y: box.y - 16, width: box.width, height: box.height + 16 } });
    stateShots.push(file);
  };
  const step = (n) => writeFileSync(join(session, 'MASCOT-STEP-' + n + '.release'), '');
  await sendText('Estados de la mascota [QA:MASCOT-CODEX]');
  step(0); await stageShot('thinking');
  step(1); await stageShot('reading');
  step(2); await stageShot('coding');
  step(3); await stageShot('tools');
  step(4); await stageShot('waiting');
  await button('Aprobar').click();
  writeFileSync(join(session, 'MASCOT-CODEX.release'), '');
  await stageShot('done');
  await pickAgent('Claude Code');
  await sendText('Error simulado [QA:FAIL-MASCOT]');
  await stageShot('error');
  if (capture) {
    const sheet = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...stateShots.flatMap((f) => ['-i', f]),
      '-filter_complex', stateShots.map((_, i) => '[' + i + ']scale=720:-2[s' + i + ']').join(';') + ';' + stateShots.map((_, i) => '[s' + i + ']').join('') + 'vstack=inputs=' + stateShots.length,
      join(shots, '12-mascotas-estados.png')], { encoding: 'utf8' });
    assert.equal(sheet.status, 0, sheet.stderr);
  }
  check('Mascotas: pensando, leyendo, editando, herramientas, esperando permiso, completado (Codex) y error (Claude) a partir de eventos reales del turno');

  // ---------- Claude: resúmenes por --settings, sin bloques vacíos y cuota oficial ----------
  await sendText('Pregunta a Claude [QA:CLAUDE-B2]');
  await poll(() => starts('CLAUDE-B2').length === 1, 'Claude no empezó');
  const settingsArg = JSON.parse(starts('CLAUDE-B2')[0].settings ?? '{}');
  assert.equal(settingsArg.showThinkingSummaries, true);
  assert.equal(settingsArg.fastMode, undefined, 'Haiku no publica modo rápido: no se debe enviar fastMode');
  await poll(async () => (await messages(conv.id)).filter((m) => m.role === 'assistant' && m.agent === 'claude' && m.status !== 'running').length >= 1, 'Claude no terminó', 20_000);
  assert.equal(await page.getByText('El proveedor no comparte el contenido del razonamiento').count(), 0);
  const quota = await invoke('bootstrap').then((b) => b.settings['quota.claude']?.default);
  assert.equal(quota?.windows?.five_hour?.usedPercent, 42);
  check('Claude Code: showThinkingSummaries solo por --settings de la sesión, pensamiento vacío oculto y cuota guardada desde rate_limit_event (42 % en 5 h)');

  // ---------- Estadísticas con datos ----------
  await page.getByRole('button', { name: 'Ajustes' }).first().click();
  await page.locator('.settings-nav', { hasText: 'Estadísticas' }).click();
  await page.locator('.stats-tiles').waitFor();
  for (const period of ['24 horas', 'Último mes', 'Todo el historial', '7 días']) {
    await page.locator('.stats-toolbar').getByRole('radio', { name: period, exact: true }).first().click();
    await page.locator('.stats-chart, .stats-empty').first().waitFor();
  }
  await shot('08-estadisticas');
  check('Estadísticas: cuatro periodos en un control segmentado y gráficos con datos reales del perfil QA');
  await page.locator('.settings-nav', { hasText: 'Cuentas y uso' }).click();
  await page.getByText('Fuente: rate_limit_event de Claude Code', { exact: false }).waitFor();
  await shot('09b-cuota-claude');
  check('Cuentas y uso: cuota de Claude Code con porcentaje, renovación, cuenta y fuente');

  assert.deepEqual(pageErrors, [], 'Errores en la página: ' + pageErrors.join(' | '));
  check('Sin errores de página en WebView2');
} catch (error) {
  failure = error;
  console.error(error);
  await page?.screenshot({ path: join(shots, 'fallo.png') }).catch(() => undefined);
} finally {
  await shutdown();
  writeFileSync(join(out, 'resultado.json'), JSON.stringify({
    webview: webviewVersion, ...(profileId ? { profileId } : {}), checks,
    failure: failure ? String(failure.stack ?? failure) : null,
  }, null, 2));
  rmSync(session, { recursive: true, force: true, maxRetries: 5 });
}
if (failure) process.exit(1);
console.log(checks.length, 'comprobaciones aprobadas en WebView2', webviewVersion);

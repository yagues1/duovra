// Validación en WebView2 real con adaptadores de protocolo locales (sin proveedores externos).
// node scripts/qa/background-webview.mjs --baseline  captura la referencia del portable Beta 2 QA.
// node scripts/qa/background-build.mjs && node scripts/qa/background-webview.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { landscape, oversizedImage } from './background-fixture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const baseline = process.argv.includes('--baseline');
const reference = join(root, 'output', 'qa', 'background');
const out = baseline ? reference : join(root, 'output', 'qa', 'background-polish');
const shots = join(out, 'capturas');
const restoreOnly = process.argv.includes('--restore-only');
const capture = !process.argv.includes('--no-capture');
const exe = baseline ? join(out, '..', 'beta2', 'app', 'Duovra Beta 2 QA.exe')
  : join(out, 'app', 'Duovra Fondos QA.exe');
assert(existsSync(exe), baseline ? 'Falta el portable de referencia de Beta 2 QA' : 'Compila con node scripts/qa/background-build.mjs');
assert(process.env.APPDATA, 'La prueba requiere Windows');
const id = randomUUID();
const identifier = baseline ? 'dev.duovra.studio.qa.beta2' : 'dev.duovra.studio.qa.background';
const appData = realpathSync(process.env.APPDATA);
const dbDir = baseline ? join(appData, identifier) : join(appData, identifier, 'fixtures', id);
if (baseline) assert(!existsSync(dbDir), 'El perfil de referencia de Beta 2 QA ya existe y se deja intacto');
mkdirSync(shots, { recursive: true });
const session = mkdtempSync(join(out, 'sesion-'));
const fixture = fileURLToPath(new URL('execution-queue-agent.mjs', import.meta.url));
const profiles = {};
const executables = {};
for (const agent of ['codex', 'claude']) {
  profiles[agent] = join(session, 'perfil-' + agent);
  executables[agent] = join(session, agent + '.cmd');
  mkdirSync(profiles[agent]);
  writeFileSync(executables[agent], `@echo off\r\n"${process.execPath}" "${fixture}" ${agent} %*\r\n`);
}

const project = join(session, 'proyecto');
mkdirSync(join(project, 'src'), { recursive: true });
writeFileSync(join(project, 'src', 'math.js'), 'export function suma(a, b) { return a + b; }\n');
const stateKey = 'appearance.background.v1';
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(webview2_|anthropic_|openai_|claude_|codex_)/i.test(name)) delete env[name];
}
Object.assign(env, {
  CODEX_HOME: profiles.codex, CLAUDE_CONFIG_DIR: profiles.claude,
  DUOVRA_QUEUE_FIXTURE: session, WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'),
  DUOVRA_BACKGROUND_TEST_PROFILE: id,
});

const checks = [];
const pageErrors = [];
const stats = {};
const providerLog = join(session, 'provider.ndjson');
const events = () => existsSync(providerLog) ? readFileSync(providerLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const providerStarts = () => events().filter((entry) => entry.type === 'start');
const pass = (label) => { checks.push(label); console.log('PASS', label); };
const release = (tag) => writeFileSync(join(session, tag + '.release'), '');
let processHandle, browser, page, webviewVersion;
let fixtureOwned = false;

async function poll(read, description, timeout = 12_000) {
  const start = Date.now();
  let cause;
  do {
    try { const result = await read(); if (result) return result; } catch (error) { cause = error; }
    await wait(90);
  } while (Date.now() - start < timeout);
  throw new Error(description, { cause });
}

function seedFixture() {
  mkdirSync(dbDir, { recursive: !baseline });
  fixtureOwned = true;
  const db = new DatabaseSync(join(dbDir, 'studio.sqlite3'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const write = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({
      'agents.codex.path': executables.codex, 'agents.claude.path': executables.claude,
      'defaults.agent': 'codex', 'defaults.model.codex': 'gpt-6-luna', 'defaults.effort.codex': 'high',
      'defaults.model.claude': 'haiku', 'defaults.effort.claude': 'medium', 'composer.enterToSend': true,
      'startup.view': 'last', 'startup.restoreConversation': true,
    })) write.run(key, JSON.stringify(value));
  } finally { db.close(); }
}

const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const setting = (key, value) => invoke('set_setting', { key, value });
const getSettings = () => invoke('bootstrap').then((boot) => boot.settings);
const getState = async () => (await getSettings())[stateKey] ?? null;

async function boot() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  processHandle = spawn(exe, [], { cwd: dirname(exe), env: {
    ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
  }, stdio: 'ignore', windowsHide: false });
  processHandle.on('error', (error) => pageErrors.push(error.message));
  const endpoint = `http://127.0.0.1:${port}`;
  await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'WebView2 no abrió su puerto local', 30_000);
  browser = await chromium.connectOverCDP(endpoint);
  webviewVersion = browser.version();
  page = await poll(() => browser.contexts()[0]?.pages()[0], 'WebView2 no abrió la página');
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__));
  const settings = await getSettings();
  assert.equal(settings['agents.codex.path'], executables.codex, 'El binario no abrió el SQLite de QA');
  assert.equal(settings['agents.claude.path'], executables.claude, 'El binario no abrió el SQLite de QA');
  await page.bringToFront();
}

async function shutdown() {
  if (processHandle && processHandle.exitCode === null && processHandle.pid) {
    if (page) await Promise.race([invoke('plugin:window|close', { label: 'main' }).catch(() => undefined), wait(900)]);
    for (let i = 0; i < 7 && processHandle.exitCode === null; i++) await wait(100);
    if (processHandle.exitCode === null) {
      spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true });
      await wait(600);
    }
  }
  await browser?.close().catch(() => undefined);
  browser = null;
  processHandle = null;
}

const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
const composer = () => page.getByRole('textbox', { name: 'Mensaje', exact: true });
const field = (scope = page) => scope.locator('[data-activity][aria-hidden="true"]');
const editor = () => page.locator('[data-background-editor]');
const preview = () => page.locator('[data-background-preview]');
const card = (id) => editor().locator(`[data-background-preset="${id}"]`);
const imageInput = () => editor().locator('input[type="file"]');
const chatImage = (scope = page) => scope.locator('.chat-backdrop-image img');
const readyField = async (scope = page) => {
  const canvas = field(scope).locator('canvas');
  await canvas.waitFor();
  await poll(async () => (await field(scope).getAttribute('data-ready')) === 'true', 'El campo no llegó a dibujar');
  return canvas;
};

async function seedConversation() {
  const created = await invoke('create_project', { name: 'Proyecto QA de fondos', path: project });
  const conv = await invoke('create_conversation', { projectId: created.id, title: 'Informe de revisión del proyecto' });
  let secondaryConversationId;
  if (!baseline) {
    const alternativePath = join(session, 'segundo-proyecto');
    mkdirSync(alternativePath);
    const other = await invoke('create_project', { name: 'Segundo proyecto QA', path: alternativePath });
    secondaryConversationId = (await invoke('create_conversation', { projectId: other.id, title: 'Conversación secundaria QA' })).id;
    await wait(12);
    await invoke('create_conversation', { projectId: other.id, title: 'Conversación alternativa QA' });
  }
  await setting('ui.lastProjectId', created.id);
  await setting('ui.lastConversationId', conv.id);
  await page.reload();
  await composer().waitFor();
  await page.locator('.studio-intro').waitFor({ state: 'hidden' }).catch(() => undefined);
  return { conversationId: conv.id, secondaryConversationId };
}

async function openEditor() {
  await page.getByRole('button', { name: 'Ajustes' }).first().click();
  await page.locator('.settings-nav', { hasText: 'Apariencia' }).click();
  await editor().waitFor();
}

async function closeEditor() {
  await button('Volver a la conversación').click();
  await composer().waitFor();
  await editor().waitFor({ state: 'detached' });
}

async function renderShot(name) {
  if (!capture) return;
  await wait(350);
  await page.screenshot({ path: join(shots, name + '.png') });
  console.log('Captura', name);
}

function ffmpeg(args, options = {}) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rgb = (png) => ffmpeg(['-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png });

function distance(first, second) {
  assert.equal(first.length, second.length, 'Cambió el tamaño de la muestra');
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < first.length; i += 3) {
    const r = Math.abs(first[i] - second[i]);
    const g = Math.abs(first[i + 1] - second[i + 1]);
    const b = Math.abs(first[i + 2] - second[i + 2]);
    sum += r + g + b;
    if (Math.max(r, g, b) >= 3) changed++;
  }
  return { mean: Number((sum / first.length).toFixed(4)), percent: Number((100 * changed * 3 / first.length).toFixed(3)) };
}

async function previewPixels() {
  await preview().scrollIntoViewIfNeeded();
  const box = await preview().boundingBox();
  assert(box && box.width > 150 && box.height > 100, 'La vista previa no tiene espacio suficiente');
  return rgb(await page.screenshot({ style: '.background-preview-chat { visibility: hidden !important }', clip: {
    x: Math.round(box.x + box.width * 0.1), y: Math.round(box.y + box.height * 0.11),
    width: Math.round(box.width * 0.8), height: Math.round(box.height * 0.76),
  } }));
}

async function referencePixels() {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await readyField();
  await poll(async () => (await field().getAttribute('data-running')) === 'false', 'Movimiento reducido no detuvo el fondo');
  await wait(650);
  const box = await field().boundingBox();
  assert(box && box.width > 100 && box.height > 90, 'Falta superficie de referencia');
  return page.screenshot({ style: '.chat-stage > [data-activity][aria-hidden="true"] ~ * { visibility: hidden !important }', clip: {
    x: Math.round(box.x + box.width * 0.21), y: Math.round(box.y + 16),
    width: Math.round(box.width * 0.58), height: Math.round(box.height - 55),
  } });
}

  const baselinePng = join(reference, 'capturas', '00-beta2-original-referencia.png');

async function checkReference() {
  const current = await referencePixels();
  const pixels = rgb(current);
  if (baseline) {
    writeFileSync(baselinePng, current);
    stats.original = { rgbSha256: hash(pixels), executableBytes: statSync(exe).size };
    pass('Original en Beta 2 QA capturado con el movimiento reducido');
    return;
  }
  assert(existsSync(baselinePng), 'Ejecuta --baseline con el portable de Beta 2 QA para comparar el fondo original');
  const reference = rgb(readFileSync(baselinePng));
  stats.original = { ...distance(reference, pixels), exact: hash(reference) === hash(pixels) };
  assert(stats.original.mean < 0.12 && stats.original.percent < 2, 'El Original por defecto difiere de Beta 2: ' + JSON.stringify(stats.original));
  if (capture) writeFileSync(join(shots, '00-fondo-original.png'), current);
  assert.equal(await getState(), null, 'El primer uso no debe reescribir el perfil');
  pass(`Original de Beta 2 con movimiento reducido (${stats.original.exact ? 'píxeles idénticos' : JSON.stringify(stats.original)}) y preferencias sin reescritura`);
}

const previewState = () => editor().getByLabel('Estado de vista previa');
const applyButton = () => button('Aplicar', editor());
const cancelButton = () => button('Cancelar', editor());
const range = (label) => editor().getByRole('slider', { name: label, exact: true });
const checkedField = (label) => editor().getByRole('checkbox', { name: label, exact: true });

async function tab(label) {
  const radio = editor().getByRole('radio', { name: label, exact: true });
  await radio.focus();
  await radio.press('Space');
  assert(await radio.isChecked(), `No se activó el panel ${label} por teclado`);
}

async function slider(label, value) {
  await range(label).fill(String(value));
  await wait(120);
}

async function changedPixels(label, previous, measure = previewPixels, minPercent = 0.25) {
  const delta = distance(previous, await measure());
  stats.pixelDifferences ??= {};
  stats.pixelDifferences[label] = delta;
  assert(delta.percent >= minPercent, `${label} no cambió el resultado visible: ${JSON.stringify(delta)}`);
  return delta;
}

async function waitBackdrop(id, scope = preview()) {
  await scope.locator(`[data-background="${id}"]`).first().waitFor();
  if (['original', 'waves', 'particles', 'ambient'].includes(id)) await readyField(scope);
}

async function choose(id) {
  await card(id).click();
  const discard = button('Cambiar fondo', page.getByRole('dialog'));
  if (await discard.isVisible()) await discard.click();
  await waitBackdrop(id);
}

async function apply(kind) {
  await applyButton().click();
  await poll(async () => (await getState())?.active.config.kind === kind && !(await applyButton().isEnabled()), 'El fondo no se aplicó: ' + kind);
  await editor().getByRole('status').filter({ hasText: 'Fondo aplicado' }).waitFor();
  return (await getState()).active.config;
}

async function savePreset(name) {
  await button('Guardar como preset', editor()).click();
  const input = editor().getByRole('textbox', { name: 'Nombre del preset' });
  await input.waitFor();
  await poll(() => input.evaluate((el) => document.activeElement === el), 'El nombre del preset debe recibir foco');
  await input.fill(name);
  if (name === 'Partículas de prueba') await renderShot('05-acciones-de-guardado');
  await button('Guardar preset', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Preset guardado' }).waitFor();
  const preset = (await getState()).presets.find((item) => item.name === name);
  assert(preset, 'Faltó el preset guardado en la configuración');
  return preset;
}

function storedImages() {
  const db = new DatabaseSync(join(dbDir, 'studio.sqlite3'), { readOnly: true });
  try { return db.prepare('SELECT id FROM background_images ORDER BY id').all().map(({ id: imageId }) => imageId); }
  finally { db.close(); }
}

async function upload(name, type, buffer) {
  await imageInput().setInputFiles({ name, mimeType: type, buffer });
  await editor().getByRole('status').filter({ hasText: 'Imagen lista' }).waitFor();
  const img = chatImage(preview());
  await poll(async () => await img.evaluate((el) => el.src.startsWith('blob:') && el.complete && el.naturalWidth > 0), 'No se decodificó la vista previa');
  return img;
}

async function rejectImage(name, type, buffer, message) {
  const before = storedImages();
  await imageInput().setInputFiles({ name, mimeType: type, buffer });
  const error = editor().getByRole('alert').filter({ hasText: message });
  await error.waitFor();
  assert.equal(await imageInput().getAttribute('aria-invalid'), 'true');
  const ids = (await imageInput().getAttribute('aria-describedby')).split(' ');
  assert(ids.includes(await error.getAttribute('id')), 'El error de imagen debe estar asociado al selector');
  assert.deepEqual(storedImages(), before, 'Se almacenó un archivo rechazado');
}

async function sendText(text) {
  await composer().fill(text);
  await composer().press('Enter');
  await poll(async () => (await composer().inputValue()) === '', 'El compositor no vació el mensaje');
}

async function waitProvider(tag) {
  return poll(() => providerStarts().find((run) => run.tag === tag), 'No empezó el turno local ' + tag);
}

async function waitReply(convId, count) {
  return poll(async () => {
    const { messages } = await invoke('list_messages', { conversationId: convId });
    return messages.filter((message) => message.role === 'assistant' && message.status !== 'running').length >= count;
  }, 'No apareció la respuesta en la conversación', 20_000);
}

async function recordScreencast(name, action) {
  if (!capture || name !== 'personalizacion-en-directo') return action();
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ sessionId, data, metadata }) => {
    frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 });
  try { await action(); }
  finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
  assert(frames.length >= 5, `Grabación incompleta (${frames.length} fotogramas)`);
  const dir = mkdtempSync(join(session, 'fotogramas-'));
  const concat = ['ffconcat version 1.0'];
  let lastFile;
  for (const [index, frame] of frames.entries()) {
    lastFile = index.toString().padStart(4, '0') + '.jpg';
    writeFileSync(join(dir, lastFile), frame.data, 'base64');
    concat.push(`file '${lastFile}'`);
    const interval = frames[index + 1] ? frames[index + 1].time - frame.time : 0.85;
    concat.push('duration ' + Math.max(1 / 90, Math.min(2, interval || 1 / 24)).toFixed(4));
  }
  concat.push(`file '${lastFile}'`);
  writeFileSync(join(dir, 'frames.ffconcat'), concat.join('\n'));
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24',
    '-c:v', 'libx264', '-threads', '2', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, name + '.mp4')], { cwd: dir });
  (stats.videos ??= {})[name] = frames.length;
  console.log('Vídeo', name, frames.length, 'fotogramas');
}

async function workerCount() {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'worker' && target.url.includes('field.worker')).length;
  } finally { await cdp.detach(); }
}

async function memory() {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.filter(({ name }) => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(name)).map(({ name, value }) => [name, value]));
  } finally { await cdp.detach(); }
}

async function animationSample(ms = 1300) {
  const cdp = await browser.newBrowserCDPSession();
  const snapshot = () => cdp.send('SystemInfo.getProcessInfo').then(({ processInfo }) => processInfo, () => []);
  try {
    const first = await snapshot();
    const started = Date.now();
    const frameTimes = await page.evaluate((duration) => new Promise((done) => {
      const gaps = [];
      const started = performance.now();
      const timer = setTimeout(() => done(gaps), duration + 1200);
      let previous;
      function frame(now) {
        if (previous !== undefined) gaps.push(now - previous);
        previous = now;
        if (now - started < duration) requestAnimationFrame(frame);
        else { clearTimeout(timer); done(gaps); }
      }
      requestAnimationFrame(frame);
    }), ms);
    const last = await snapshot();
    const elapsed = (Date.now() - started) / 1000;
    const initial = new Map(first.map(({ id, cpuTime }) => [id, cpuTime]));
    const cpu = last.reduce((seconds, { id, cpuTime }) => seconds + (initial.has(id) ? cpuTime - initial.get(id) : 0), 0);
    const percentile = [...frameTimes].sort((a, b) => a - b).at(Math.floor(frameTimes.length * 0.95));
    return { samples: frameTimes.length, pageFrameP95Ms: percentile === undefined ? null : Number(percentile.toFixed(2)),
      webviewCpuEquivalentPercentOfOneCore: first.length ? Number((100 * cpu / elapsed).toFixed(1)) : null };
  } finally { await cdp.detach(); }
}

async function verifyGallery() {
  await openEditor();
  const cards = editor().getByRole('group', { name: 'Fondos integrados' }).locator('[data-background-preset]');
  assert.equal(await cards.count(), 6);
  await poll(() => cards.locator('img').evaluateAll((images) => images.length === 5 && images.every((img) => img.complete && img.naturalWidth > 0)), 'Faltan miniaturas renderizadas');
  assert.equal(await card('original').getAttribute('aria-pressed'), 'true');
  await renderShot('01-galeria-de-fondos');
  await card('waves').focus();
  await page.keyboard.press('Space');
  await waitBackdrop('waves');
  assert.equal(await card('waves').getAttribute('aria-pressed'), 'true');
  assert.match(await card('original').innerText(), /Activo/);
  assert.match(await editor().locator('.background-preview-head h4').innerText(), /Ondas/);
  await editor().getByRole('status').filter({ hasText: 'cambios por aplicar' }).waitFor();
  const images = new Map();
  for (const id of ['minimal', 'original', 'waves', 'particles', 'ambient']) {
    await choose(id);
    images.set(id, await previewPixels());
    if (id !== 'minimal') await changedPixels(`Preset ${id}`, images.get('minimal'));
  }
  for (const [first, second] of [['waves', 'particles'], ['waves', 'ambient'], ['particles', 'ambient']]) {
    assert(distance(images.get(first), images.get(second)).percent >= 0.25, `Se confunden los fondos ${first} y ${second}`);
  }
  assert.equal(await getState(), null, 'La galería guardó una prueba antes de Aplicar');
  assert.equal(providerStarts().length, 0);
  pass('Galería con cinco miniaturas renderizadas y entrada de imagen, selección por teclado, activo distinguible y presets visualmente distintos');
}

async function verifyPendingChanges() {
  await cancelButton().click();
  assert(!(await applyButton().isEnabled()), 'Aplicar está habilitado sin cambios');
  await choose('waves');
  await range('Intensidad').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await range('Intensidad').inputValue(), '69');
  assert.equal(await range('Intensidad').getAttribute('aria-valuetext'), '69 %');
  const dialog = page.getByRole('dialog');
  await card('particles').click();
  await button('Cancelar', dialog).click();
  assert.equal(await range('Intensidad').inputValue(), '69');
  await choose('particles');
  await waitBackdrop('particles');
  const conversations = page.locator('.settings-nav', { hasText: 'Conversaciones' });
  await conversations.click();
  await button('Cancelar', dialog).click();
  assert.equal(await card('particles').getAttribute('aria-pressed'), 'true');
  await button('Cerrar', page).click();
  await button('Cancelar', dialog).click();
  assert.equal(await card('particles').getAttribute('aria-pressed'), 'true');
  await conversations.click();
  await button('Salir de Apariencia', dialog).click();
  await editor().waitFor({ state: 'detached' });
  await page.locator('.settings-nav', { hasText: 'Apariencia' }).click();
  await waitBackdrop('original');
  assert(!(await applyButton().isEnabled()));
  assert.equal(await getState(), null, 'Salir guardó un cambio descartado');
  pass('Aplicar inactivo sin cambios, slider por teclado, confirmación y descarte al cambiar de fondo o de sección y confirmación al cerrar la ventana');
}

async function verifyEditorSizes() {
  stats.editorSizes = [];
  for (const [width, height] of [[1440, 900], [1366, 768], [960, 800]]) {
    await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width, height } } });
    await poll(() => page.evaluate(([w, h]) => Math.abs(innerWidth - w) <= 2 && Math.abs(innerHeight - h) <= 2, [width, height]),
      `La ventana no llegó a ${width}×${height}`);
    await editor().locator('h3').scrollIntoViewIfNeeded();
    const layout = await editor().evaluate((el) => {
      const preview = el.querySelector('[data-background-preview]').getBoundingClientRect();
      const controls = el.querySelector('.background-controls').getBoundingClientRect();
      const footer = el.querySelector('.background-footer').getBoundingClientRect();
      const scroll = el.closest('.settings-scroll');
      const stacked = controls.top >= preview.bottom;
      return {
        window: [innerWidth, innerHeight], preview: [Math.round(preview.width), Math.round(preview.height)],
        stacked, overflow: scroll.scrollWidth > scroll.clientWidth,
        footerVisible: footer.top >= scroll.getBoundingClientRect().top && footer.bottom <= scroll.getBoundingClientRect().bottom,
      };
    });
    assert(layout.preview[0] >= 420 && layout.preview[1] >= 305, JSON.stringify(layout));
    assert(!layout.overflow && layout.footerVisible, JSON.stringify(layout));
    assert.equal(layout.stacked, width === 960, JSON.stringify(layout));
    stats.editorSizes.push(layout);
    if (width === 960) {
      await preview().scrollIntoViewIfNeeded();
      await renderShot('06-vista-previa-960x800');
    }
  }
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 1440, height: 900 } } });
  await poll(() => page.evaluate(() => innerWidth >= 1438), 'No se restauró la ventana de QA');
  pass('Galería, vista previa amplia y footer accesible a 1440×900, 1366×768 y 960×800');
}

async function verifyLegacyProfile() {
  const legacy = { 'appearance.backdrop': 'off', 'appearance.background': false, 'appearance.fieldIntensity': 'soft', 'appearance.ambient': 'off' };
  for (const [key, value] of Object.entries(legacy)) await setting(key, value);
  await page.reload();
  await composer().waitFor();
  assert.equal(await field().count(), 0, 'El fondo desactivado de Beta 2 volvió a dibujarse');
  await openEditor();
  assert.match(await card('minimal').innerText(), /Activo/);
  assert.equal(await field().count(), 0);
  await closeEditor();
  const after = await getSettings();
  for (const [key, value] of Object.entries(legacy)) assert.equal(after[key], value);
  assert.equal(await getState(), null, 'La consulta reescribió preferencias anteriores');
  for (const key of Object.keys(legacy)) await setting(key, null);
  await page.reload();
  await composer().waitFor();
  await readyField();
  pass('Perfil Beta 2 simulado: fondo apagado, intensidad, reactividad y deriva anteriores conservados sin escritura automática');
}

async function verifyAdvanced() {
  await choose('original');
  await button('Editar fondo', editor()).click();
  const customOriginal = await previewPixels();
  await slider('Intensidad', 100);
  await changedPixels('Intensidad del campo Original editado', customOriginal, previewPixels, 0.08);
  await cancelButton().click();
  await choose('waves');
  const beforeWaves = await previewPixels();
  await tab('Composición');
  await slider('Posición horizontal', 32);
  await slider('Distribución', 79);
  await changedPixels('Composición de ondas', beforeWaves);
  await tab('Movimiento');
  const waveBeforeAmplitude = await previewPixels();
  await slider('Amplitud', 86);
  await changedPixels('Amplitud de ondas', waveBeforeAmplitude);
  await tab('Apariencia');
  await editor().getByLabel('Paleta').selectOption('fixed');
  const beforeColor = await previewPixels();
  await editor().getByLabel('Color fijo').fill('#de86ff');
  await changedPixels('Color fijo', beforeColor);
  await renderShot('03-editor-de-ondas');
  const wave = await apply('waves');
  assert.equal(wave.field.color, '#de86ff');
  await closeEditor();
  await waitBackdrop('waves', page.locator('.chat-stage'));
  assert.equal(await preview().count(), 0);
  pass('Ondas: composición, amplitud y color fijo cambian píxeles. Aplicar actualiza la conversación');

  await openEditor();
  await choose('particles');
  const particles = await previewPixels();
  await slider('Densidad', 22);
  await changedPixels('Densidad de partículas', particles);
  await renderShot('05-particulas');
  const saved = await savePreset('Partículas de prueba');
  assert.equal(saved.config.field.density, 22);
  assert.equal((await getState()).active.config.kind, 'waves', 'Guardar preset sustituyó el fondo aplicado');
  await cancelButton().click();
  await waitBackdrop('waves');
  await editor().getByRole('status').filter({ hasText: 'cancelada' }).waitFor();
  assert.equal((await getState()).active.config.kind, 'waves');
  await card(saved.id).click();
  await waitBackdrop('particles');
  assert.equal(await range('Densidad').inputValue(), '22');
  await slider('Densidad', 40);
  await button('Editar preset', editor()).click();
  await editor().getByRole('textbox', { name: 'Nombre del preset' }).fill('Partículas de prueba editadas');
  await button('Actualizar preset', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Preset guardado' }).waitFor();
  assert.equal((await getState()).presets.find(({ id }) => id === saved.id).config.field.density, 40);
  await button('Eliminar preset', editor()).click();
  await button('Eliminar preset', page.getByRole('dialog')).click();
  await poll(async () => !(await getState()).presets.some(({ id }) => id === saved.id), 'No se eliminó el preset personal');
  assert.equal(await card('particles').count(), 1);
  assert.equal((await getState()).active.config.kind, 'waves');
  pass('Partículas: Densidad modifica píxeles, Cancelar mantiene Ondas. Preset personal guardado, recuperado, editado y eliminado');
}

async function verifyPreviewMotion() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await choose('waves');
  const running = (value) => poll(async () => (await field(preview()).getAttribute('data-running')) === value, `Campo de vista previa: running=${value}`);
  await running('true');
  const idle = await previewPixels();
  await wait(600);
  await changedPixels('Deriva en reposo', idle);
  await tab('Movimiento');
  await checkedField('Movimiento en reposo').uncheck();
  await running('false');
  const stopped = await previewPixels();
  await wait(650);
  assert.equal(distance(stopped, await previewPixels()).mean, 0);
  const scene = await preview().boundingBox();
  await page.mouse.move(scene.x + scene.width * 0.17, scene.y + scene.height * 0.35);
  await running('true');
  await wait(420);
  const pointerLeft = await previewPixels();
  await page.mouse.move(scene.x + scene.width * 0.83, scene.y + scene.height * 0.73, { steps: 7 });
  await wait(460);
  await changedPixels('Puntero con ambiente apagado', pointerLeft, previewPixels, 0.1);
  await checkedField('Reacción al puntero').uncheck();
  await running('false');
  await page.mouse.move(scene.x + scene.width * 0.45, scene.y + scene.height * 0.5);
  await wait(300);
  assert.equal(await field(preview()).getAttribute('data-running'), 'false');
  await recordScreencast('personalizacion-en-directo', async () => {
    await editor().locator('h3').scrollIntoViewIfNeeded();
    await wait(900);
    await previewState().selectOption('claude');
    await running('true');
    await renderShot('02-vista-previa');
    await wait(750);
    const claude = await previewPixels();
    await previewState().selectOption('codex');
    await wait(730);
    await changedPixels('Claude y Codex simulados', claude);
    const codex = await previewPixels();
    await slider('Velocidad', 89);
    await wait(550);
    await changedPixels('Movimiento en ejecución simulada', codex);
    await previewState().selectOption('waiting');
    await wait(850);
    const waiting = await previewPixels();
    await previewState().selectOption('done');
    await wait(870);
    await changedPixels('Espera y tarea completada simuladas', waiting);
    await previewState().selectOption('idle');
    await choose('particles');
    await slider('Densidad', 90);
    await wait(720);
    await button('Guardar como preset', editor()).click();
    await wait(650);
    await button('Cerrar nombre', editor()).click();
    await choose('ambient');
    await wait(720);
    await cancelButton().click();
    await wait(570);
    await slider('Intensidad', 76);
    await apply('waves');
    await wait(720);
  });
  assert.equal(providerStarts().length, 0, 'La vista previa invocó un proveedor');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await previewState().selectOption('claude');
  await running('false');
  const reduced = await previewPixels();
  await wait(600);
  assert.equal(distance(reduced, await previewPixels()).mean, 0);
  pass('Reposo y trabajo cambian píxeles, estados simulados sin ejecuciones, y movimiento reducido fija el fotograma incluso al simular trabajo');
}

async function verifyImages() {
  await choose('image');
  assert(!(await applyButton().isEnabled()), 'Aplicar admitió un fondo de imagen sin archivo');
  await rejectImage('maliciosa.png', 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%"/></svg>'), /PNG, JPEG o WebP/);
  await rejectImage('grande.png', 'image/png', Buffer.alloc(8 * 1024 * 1024 + 1), /8 MB/);
  await rejectImage('dimensiones.png', 'image/png', await oversizedImage(page), /4096 px/);
  for (const [name, type] of [['prueba.jpg', 'image/jpeg'], ['prueba.webp', 'image/webp']]) {
    await upload(name, type, await landscape(page, type));
    assert.equal(storedImages().length, 1);
    await cancelButton().click();
    await waitBackdrop('waves');
    await poll(() => storedImages().length === 0, 'Cancelar dejó una imagen temporal en el perfil');
    await choose('image');
  }
  pass('JPEG y WebP se ven y se liberan al cancelar. SVG camuflado, límite de bytes y de dimensiones rechazados con error accesible');

  const originalPath = join(session, 'aurora.png');
  writeFileSync(originalPath, await landscape(page));
  const initialFile = hash(readFileSync(originalPath));
  await imageInput().setInputFiles(originalPath);
  await poll(() => chatImage(preview()).evaluate((el) => el.complete && el.naturalWidth === 1280), 'La imagen PNG no apareció en la vista previa');
  assert.equal(hash(readFileSync(originalPath)), initialFile, 'Se tocó el archivo original');
  unlinkSync(originalPath);
  const first = await previewPixels();
  await editor().getByLabel('Modo de encuadre').selectOption('contain');
  await slider('Oscurecimiento', 56);
  await slider('Desenfoque', 24);
  await changedPixels('Encuadre, oscurecimiento y desenfoque', first);
  await button('Restablecer imagen', editor()).click();
  assert.equal(await editor().getByLabel('Modo de encuadre').inputValue(), 'cover');
  assert.equal(await range('Oscurecimiento').inputValue(), '36');
  assert.equal(await range('Desenfoque').inputValue(), '0');
  await slider('Oscurecimiento', 8);
  await slider('Opacidad', 100);
  await previewState().selectOption('idle');
  await editor().evaluate((el) => {
    const scroller = el.closest('.settings-scroll');
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  });
  await renderShot('04-editor-de-imagen');
  const config = await apply('image');
  assert.match(config.image.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(storedImages(), [config.image.id]);
  const personal = await savePreset('Aurora local');
  assert.equal(personal.config.image.id, config.image.id);
  await poll(() => card(personal.id).locator('img').evaluate((img) => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 192),
    'La galería no mostró la miniatura local del preset de imagen');
  await cancelButton().click();
  await closeEditor();
  await chatImage().waitFor();
  await shutdown();
  await boot();
  await composer().waitFor();
  await poll(() => chatImage().evaluate((el) => el.src.startsWith('blob:') && el.complete && el.naturalWidth === 1280), 'El reinicio no recuperó la imagen copiada');
  assert.equal((await getState()).active.config.image.id, config.image.id);
  assert.equal((await getState()).presets.find(({ id }) => id === personal.id).config.image.id, config.image.id);
  pass('PNG importado sin modificar el original, borrado el archivo fuente, imagen y preset recuperados al reiniciar el ejecutable');
  return personal;
}

async function verifyChat({ conversationId }) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await recordScreencast('conversacion-qa-con-fondo', async () => {
    await wait(700);
    await sendText('Revisa el módulo de cálculo y comprueba si podemos añadir una resta. [QA:ACTIVITY-HOLD-BACKGROUND]');
    const codex = await waitProvider('ACTIVITY-HOLD-BACKGROUND');
    assert.equal(codex.agent, 'codex');
    await wait(950);
    await button('Mostrar Workbench').click();
    await page.locator('#workbench').waitFor();
    await chatImage().waitFor();
    release('ACTIVITY-HOLD-BACKGROUND');
    await waitReply(conversationId, 1);
    await button('Ocultar Workbench').click();
    await wait(740);
    await sendText('Ahora verifica la lectura del informe extenso en esta conversación. [QA:HOLD-CHAT-JUMP]');
    await waitProvider('HOLD-CHAT-JUMP');
    await page.getByText('Párrafo largo de comprobación 70.', { exact: true }).waitFor();
    await sendText('Verifica el siguiente punto cuando termine la respuesta. [QA:HOLD-IMAGE-QUEUE]');
    await poll(async () => (await invoke('message_queue', { conversationId })).entries.length === 1, 'El mensaje no quedó en cola');
    await chatImage().waitFor();
    release('HOLD-CHAT-JUMP-MORE');
    await page.getByText('Último fragmento de la respuesta.', { exact: true }).waitFor();
    release('HOLD-CHAT-JUMP');
    await waitProvider('HOLD-IMAGE-QUEUE');
    release('HOLD-IMAGE-QUEUE');
    await waitReply(conversationId, 3);
    await wait(700);
  });
  await page.locator('.agent-btn').click();
  await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click();
  await sendText('Verifica la persistencia local. [QA:HOLD-IMAGE-CLAUDE]');
  const claude = await waitProvider('HOLD-IMAGE-CLAUDE');
  assert.equal(claude.agent, 'claude');
  await chatImage().waitFor();
  release('HOLD-IMAGE-CLAUDE');
  await waitReply(conversationId, 4);
  assert(await composer().isVisible());
  await page.locator('.project-capsule').click();
  await page.getByRole('menuitemradio', { name: /Segundo proyecto QA/ }).click();
  await page.locator('.titlebar-title-text').filter({ hasText: 'Conversación alternativa QA' }).waitFor();
  await chatImage().waitFor();
  await page.locator('.tree-conv').filter({ hasText: 'Conversación secundaria QA' }).click();
  await page.locator('.titlebar-title-text').filter({ hasText: 'Conversación secundaria QA' }).waitFor();
  await chatImage().waitFor();
  pass('Imagen en conversación QA con Codex y Claude Code simulados, streaming, historial largo, cola, Workbench y cambio de proyecto/conversación');
}

async function verifyCleanup(imagePreset) {
  await openEditor();
  await choose('image');
  const savedId = imagePreset.config.image.id;
  const lists = await landscape(page, 'image/webp');
  await upload('sustituta.webp', 'image/webp', lists);
  const replacement = await apply('image');
  assert.notEqual(replacement.image.id, savedId);
  assert.deepEqual(storedImages().sort(), [savedId, replacement.image.id].sort());
  await button('Eliminar imagen', editor()).click();
  await waitBackdrop('minimal');
  await apply('minimal');
  await poll(() => storedImages().length === 1 && storedImages()[0] === savedId, 'La imagen retirada de la conversación no se liberó o el preset perdió su imagen');
  await card(imagePreset.id).click();
  await chatImage(preview()).waitFor();
  await button('Eliminar preset', editor()).click();
  await button('Eliminar preset', page.getByRole('dialog')).click();
  await poll(() => storedImages().length === 0, 'No se liberó la última referencia a la imagen');
  await assert.rejects(invoke('background_image_read', { id: '../fuera-del-perfil' }));
  await button('Restablecer fondo', editor()).click();
  await waitBackdrop('original');
  await apply('original');
  await closeEditor();
  await waitBackdrop('original', page.locator('.chat-stage'));
  pass('Sustituir, eliminar y recuperar imagen respetan referencias de presets; restablecer vuelve a Duovra Original');
}

async function verifyStability() {
  await openEditor();
  await choose('waves');
  const thread = await field(preview()).getAttribute('data-thread');
  assert.equal(thread, 'worker', 'La máquina de prueba no usa OffscreenCanvas');
  await poll(async () => (await workerCount()) === 1, 'Debe existir un solo worker del campo');
  const before = await memory();
  for (let i = 0; i < 6; i++) {
    for (const id of ['particles', 'ambient', 'minimal', 'waves']) {
      await choose(id);
      const expected = id === 'minimal' ? 0 : 1;
      assert.equal(await field().locator('canvas').count(), expected, `Lienzos tras ${id}`);
      await poll(async () => (await workerCount()) === expected, `Workers tras ${id}`);
    }
  }
  const after = await memory();
  stats.stability = { switches: 24, before, after, fieldThread: thread };
  assert(after.Nodes <= before.Nodes + 100, 'Los nodos de la UI crecen al alternar presets');
  assert(after.JSEventListeners <= before.JSEventListeners + 30, 'Los escuchadores crecen al alternar presets');
  if (await applyButton().isEnabled()) await apply('waves');
  await closeEditor();
  await waitBackdrop('waves', page.locator('.chat-stage'));
  assert.equal(await preview().count(), 0);
  await poll(async () => (await workerCount()) === 1, 'Debe quedar solo el worker de la conversación');

  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 820, height: 650 } } }));
  await poll(() => page.evaluate(() => innerWidth <= 830), 'No se pudo comprobar la ventana estrecha');
  assert(await composer().isVisible());
  await field().waitFor();
  await openEditor();
  await waitBackdrop('waves');
  assert(await preview().evaluate((el) => Math.round(el.clientWidth) > 150));
  await closeEditor();
  await verifyMinimize();
  stats.stability.wavesNarrow = await animationSample();
  pass('24 cambios sin acumular lienzos o workers, preview descargada al cerrar, ventana 820 px y pausa/reanudación al minimizar');
}

async function verifyMinimize() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await poll(async () => (await field().getAttribute('data-running')) === 'true', 'El fondo no empezó a animarse antes de minimizar');
  const windowState = async () => ({
    minimized: await invoke('plugin:window|is_minimized', { label: 'main' }),
    nativeFocus: await invoke('plugin:window|is_focused', { label: 'main' }),
    ...(await page.evaluate(() => ({ visible: document.visibilityState, domFocus: document.hasFocus() }))),
    running: await field().getAttribute('data-running'),
  });
  stats.restore = { before: await windowState() };
  await invoke('plugin:window|minimize', { label: 'main' });
  await poll(async () => (await field().getAttribute('data-running')) === 'false', 'El fondo se siguió animando minimizado');
  stats.restore.minimized = await windowState();
  await invoke('plugin:window|unminimize', { label: 'main' });
  await invoke('plugin:window|set_focus', { label: 'main' });
  await page.bringToFront();
  try {
    await poll(async () => (await field().getAttribute('data-running')) === 'true', 'El fondo no reanudó al restaurar');
  } finally {
    stats.restore.after = await windowState();
    console.log('Estado de restauración', stats.restore);
  }
}

async function verifyActualMotion({ secondaryConversationId }) {
  const activity = async () => field().getAttribute('data-activity');
  assert.equal(await activity(), 'idle');
  await sendText('Confirma el fondo activo durante la ejecución. [QA:ACTIVITY-HOLD-FIELD]');
  const run = await waitProvider('ACTIVITY-HOLD-FIELD');
  assert.equal(run.agent, 'codex');
  await poll(async () => (await activity()) !== 'idle' && (await field().getAttribute('data-running')) === 'true', 'El fondo no siguió la actividad real del turno');
  stats.stability.wavesDuringRun = await animationSample(950);
  release('ACTIVITY-HOLD-FIELD');
  await waitReply(secondaryConversationId, 1);
  await poll(async () => (await activity()) === 'idle', 'El fondo no volvió a reposo', 15_000);
  pass('Ondas en conversación: deriva en reposo, reactividad con el turno Codex local y vuelta al reposo');
}

async function verify() {
  seedFixture();
  await boot();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const conversation = await seedConversation();
  if (restoreOnly) {
    await openEditor();
    await choose('waves');
    await apply('waves');
    await closeEditor();
    await verifyMinimize();
    pass('Pausa y reanudación del fondo al minimizar y restaurar');
    return;
  }
  await checkReference();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await poll(async () => (await field().getAttribute('data-running')) === 'true', 'El Original no animó en reposo');
  stats.original.defaultMotion = await animationSample();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (baseline) {
    writeFileSync(join(out, 'aurora-fixture.png'), await landscape(page));
    return;
  }
  await verifyLegacyProfile();
  await verifyGallery();
  await verifyPendingChanges();
  await verifyEditorSizes();
  await verifyAdvanced();
  await verifyPreviewMotion();
  const imagePreset = await verifyImages();
  await verifyChat(conversation);
  await verifyCleanup(imagePreset);
  await verifyStability();
  await verifyActualMotion(conversation);
  const before = JSON.parse(readFileSync(join(reference, 'referencia.json'), 'utf8')).stats.original.executableBytes;
  const after = statSync(exe).size;
  stats.executableBytes = { before, after, delta: after - before };
}

let failure = null;
try {
  await verify();
  assert.deepEqual(pageErrors, [], 'Errores de página en WebView2');
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(error);
  await page?.screenshot({ path: join(shots, baseline ? 'fallo-referencia.png' : 'fallo.png') }).catch(() => undefined);
} finally {
  await shutdown();
  writeFileSync(join(out, baseline ? 'referencia.json' : restoreOnly ? 'restauracion.json' : 'resultado.json'), JSON.stringify({
    webview: webviewVersion, checks, stats, listedProvidersSimulated: true, failure,
  }, null, 2));
  // Solo los directorios recién creados por esta ejecución y validados dentro de sus raíces.
  const parent = baseline ? appData : join(appData, identifier, 'fixtures');
  const owned = [[session, out, basename(session)]];
  if (fixtureOwned) owned.push([dbDir, parent, baseline ? identifier : id]);
  for (const [path, expectedParent, expectedName] of owned) {
    if (existsSync(path) && dirname(realpathSync(path)) === realpathSync(expectedParent) && basename(path) === expectedName) {
      for (let retry = 0; retry < 4; retry++) {
        try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); break; }
        catch (error) {
          if (retry === 3) console.warn('WebView2 mantiene abierto el directorio temporal de QA', error.message);
          else await wait(450);
        }
      }
    }
  }
}
if (failure) process.exitCode = 1;

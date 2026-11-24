// Validación en WebView2 real de la integración visual de fondos (Ajustes superpuestos, fondos de
// patrón y compositor de cristal). Usa adaptadores de protocolo locales: no invoca proveedores.
//   node scripts/qa/pattern-build.mjs && node scripts/qa/pattern-webview.mjs
//   node scripts/qa/pattern-webview.mjs --baseline-old   (rendimiento del portable anterior)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { landscape } from './background-fixture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const old = process.argv.includes('--baseline-old');
const perfOnly = process.argv.includes('--perf-only');
const probe = process.argv.includes('--probe');
const refinement = process.argv.includes('--refinement-before') ? 'antes'
  : process.argv.includes('--refinement-after') ? 'despues' : null;
const integration = join(root, 'output', 'qa', 'pattern-visual');
const refinementOutput = join(root, 'output', 'qa', 'pattern-refinement');
// --refinement-after sobre otra build (la revisión de Claude): ejecutable, identidad y salida propios.
const reviewExe = refinement === 'despues' ? process.env.DUOVRA_PATTERN_QA_EXE : undefined;
const out = reviewExe ? resolve(process.env.DUOVRA_PATTERN_QA_OUTPUT) : refinement ? join(refinementOutput, refinement) : integration;
const shots = join(out, 'capturas');
const baselineApp = join(root, 'output', 'qa', 'background-polish', 'app');
const baselineExe = old && (readdirSync(baselineApp, { throwIfNoEntry: false }) ?? []).find((name) => name.endsWith('.exe'));
const exe = old ? join(baselineApp, baselineExe ?? 'duovra.exe')
  : reviewExe ? resolve(reviewExe)
  : refinement === 'despues' ? join(refinementOutput, 'app', 'Duovra Fondos QA.exe')
  : join(integration, 'app', 'Duovra Patrones QA.exe');
assert(existsSync(exe), old ? 'Falta el portable anterior (Fondos QA)'
  : 'Compila con node scripts/qa/pattern-build.mjs' + (refinement === 'despues' ? ' --refinement' : ''));
assert(process.env.APPDATA, 'La prueba requiere Windows');
const id = randomUUID();
const identifier = old ? 'dev.duovra.studio.qa.background'
  : reviewExe ? process.env.DUOVRA_PATTERN_QA_IDENTIFIER
  : refinement === 'despues' ? 'dev.duovra.studio.qa.pattern-refinement' : 'dev.duovra.studio.qa.pattern';
const appData = realpathSync(process.env.APPDATA);
const dbDir = join(appData, identifier, 'fixtures', id);
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
writeFileSync(join(project, 'notas.txt'), 'Notas del proyecto QA.\n');
const stateKey = 'appearance.background.v1';
const legacyPreset = { id: '6b6f2f53-3a7e-4b8e-9d8e-5f1f0a0c2b11', name: 'Ondas de la beta', config: { kind: 'waves', field: {
  color: '#847cff', palette: 'fixed', intensity: 68, contrast: 50, brightness: 50, size: 50, density: 50, speed: 45, amplitude: 50,
  ambient: true, activity: 60, pointer: true, reach: 94, x: 62, y: 74, distribution: 50, softness: 50,
} } };
const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(webview2_|anthropic_|openai_|claude_|codex_)/i.test(name)) delete env[name];
Object.assign(env, {
  CODEX_HOME: profiles.codex, CLAUDE_CONFIG_DIR: profiles.claude, DUOVRA_QUEUE_FIXTURE: session,
  WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'),
  [old ? 'DUOVRA_BACKGROUND_TEST_PROFILE' : 'DUOVRA_PATTERN_TEST_PROFILE']: id,
});

const checks = [];
const pageErrors = [];
const stats = {};
const providerLog = join(session, 'provider.ndjson');
const events = () => existsSync(providerLog) ? readFileSync(providerLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
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
  mkdirSync(dbDir, { recursive: true });
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
      // Un preset personal de la beta anterior: debe seguir leyéndose y pintándose.
      [stateKey]: { active: { presetId: 'original', config: { kind: 'original' } }, presets: [legacyPreset] },
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
const chatField = () => page.locator('.chat-stage > [data-activity][aria-hidden="true"]').first();
const dialog = () => page.locator('dialog.settings-dialog');
const editor = () => page.locator('[data-background-editor]');
const preset = (presetId) => editor().locator(`[data-background-preset="${presetId}"]`);
const radio = (name) => editor().getByRole('radio', { name, exact: true });

async function shot(name, options = {}) {
  await wait(380);
  await page.screenshot({ path: join(shots, name + '.png'), ...options });
  console.log('Captura', name);
}

async function clipShot(name, locator, pad = 24) {
  const box = await locator.boundingBox();
  assert(box, 'Falta el elemento para ' + name);
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad - 40);
  await shot(name, { clip: { x, y, width: Math.min(viewport.w - x, box.width + pad * 2), height: Math.min(viewport.h - y, box.height + pad * 2 + 40) } });
}

function ffmpeg(args, options = {}) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
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
    if (Math.max(r, g, b) >= 6) changed++;
  }
  return { mean: Number((sum / first.length).toFixed(3)), percent: Number((100 * changed * 3 / first.length).toFixed(2)) };
}

function lowestBackdropContrast(pixels, tones) {
  const linear = Array.from({ length: 256 }, (_, n) => {
    const s = n / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = (r, g, b) => 0.2126 * linear[r] + 0.7152 * linear[g] + 0.0722 * linear[b];
  let brightest = 0;
  for (let i = 0; i < pixels.length; i += 3) brightest = Math.max(brightest, luminance(pixels[i], pixels[i + 1], pixels[i + 2]));
  const contrast = (r, g, b) => Number(((luminance(r, g, b) + 0.05) / (brightest + 0.05)).toFixed(2));
  return { secondary: contrast(...tones.secondary), tertiary: contrast(...tones.tertiary) };
}

function readingTones() {
  return page.locator('.chat-scroll').evaluate((el) => {
    const style = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = (token) => {
      ctx.fillStyle = style.getPropertyValue(token).trim();
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    return { secondary: sample('--text-secondary'), tertiary: sample('--text-tertiary') };
  });
}

/** Píxeles del fondo de la conversación sin el texto ni el compositor (para comparar fondos). */
async function stagePixels(readingOnly = false) {
  const box = await page.locator('.chat-stage').boundingBox();
  const reading = readingOnly && await page.locator('.chat-column').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { x: rect.x + left, width: rect.width - left - right };
  });
  return rgb(await page.screenshot({
    style: '.chat-scroll, .composer-wrap, .chat-reading-veil, .jump-btn, dialog.settings-dialog { visibility: hidden !important } dialog.settings-dialog::backdrop { background: transparent !important }',
    clip: { x: Math.round(reading ? reading.x : box.x), y: Math.round(box.y), width: Math.round(reading ? reading.width : box.width), height: Math.round(box.height) },
  }));
}

async function sendText(text) {
  await composer().fill(text);
  await composer().press('Enter');
  await poll(async () => (await composer().inputValue()) === '', 'El compositor no vació el mensaje');
}
const waitProvider = (tag) => poll(() => events().find((run) => run.type === 'start' && run.tag === tag), 'No empezó el turno local ' + tag);
async function waitReply(convId, count) {
  return poll(async () => {
    const { messages } = await invoke('list_messages', { conversationId: convId });
    return messages.filter((message) => message.role === 'assistant' && message.status !== 'running').length >= count;
  }, 'No apareció la respuesta', 25_000);
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
    return Object.fromEntries(metrics.filter(({ name }) => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(name)).map(({ name, value }) => [name, Math.round(value)]));
  } finally { await cdp.detach(); }
}

/** CPU de todos los procesos de WebView2 (equivalente en % de un núcleo) y p95 de los fotogramas de la página. */
async function animationSample(ms = 3000) {
  const cdp = await browser.newBrowserCDPSession();
  const snapshot = () => cdp.send('SystemInfo.getProcessInfo').then(({ processInfo }) => processInfo, () => []);
  try {
    const first = await snapshot();
    const started = Date.now();
    const frameTimes = await page.evaluate((duration) => new Promise((done) => {
      const gaps = [];
      const begin = performance.now();
      const timer = setTimeout(() => done(gaps), duration + 1200);
      let previous;
      function frame(now) {
        if (previous !== undefined) gaps.push(now - previous);
        previous = now;
        if (now - begin < duration) requestAnimationFrame(frame);
        else { clearTimeout(timer); done(gaps); }
      }
      requestAnimationFrame(frame);
    }), ms);
    const last = await snapshot();
    const elapsed = (Date.now() - started) / 1000;
    const initial = new Map(first.map(({ id: pid, cpuTime }) => [pid, cpuTime]));
    const cpu = last.reduce((seconds, { id: pid, cpuTime }) => seconds + (initial.has(pid) ? cpuTime - initial.get(pid) : 0), 0);
    const p95 = [...frameTimes].sort((a, b) => a - b).at(Math.floor(frameTimes.length * 0.95));
    return { pageFrameP95Ms: p95 === undefined ? null : Number(p95.toFixed(1)), cpuPercentOfOneCore: first.length ? Number((100 * cpu / elapsed).toFixed(1)) : null };
  } finally { await cdp.detach(); }
}

async function recordScreencast(name, action) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ sessionId, data, metadata }) => {
    frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 84, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  try { await action(); }
  finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
  assert(frames.length >= 10, `Grabación incompleta (${frames.length} fotogramas)`);
  const dir = mkdtempSync(join(session, 'fotogramas-'));
  const concat = ['ffconcat version 1.0'];
  let lastFile;
  for (const [index, frame] of frames.entries()) {
    lastFile = index.toString().padStart(4, '0') + '.jpg';
    writeFileSync(join(dir, lastFile), frame.data, 'base64');
    concat.push(`file '${lastFile}'`);
    const interval = frames[index + 1] ? frames[index + 1].time - frame.time : 0.6;
    concat.push('duration ' + Math.max(1 / 90, Math.min(1.5, interval || 1 / 24)).toFixed(4));
  }
  concat.push(`file '${lastFile}'`);
  writeFileSync(join(dir, 'frames.ffconcat'), concat.join('\n'));
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
    '-c:v', 'libx264', '-threads', '2', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, name + '.mp4')], { cwd: dir });
  (stats.videos ??= {})[name] = frames.length;
  console.log('Vídeo', name, frames.length, 'fotogramas');
}

// ── escenario ──

async function seedConversations() {
  const created = await invoke('create_project', { name: 'Proyecto QA de patrones', path: project });
  const codex = await invoke('create_conversation', { projectId: created.id, title: 'Revisión del módulo de cálculo' });
  await wait(15);
  const claude = await invoke('create_conversation', { projectId: created.id, title: 'Documentación con Claude Code' });
  await setting('ui.lastProjectId', created.id);
  await setting('ui.lastConversationId', codex.id);
  await page.reload();
  await composer().waitFor();
  await page.locator('.studio-intro').waitFor({ state: 'hidden' }).catch(() => undefined);
  return { projectId: created.id, codex: codex.id, claude: claude.id };
}

async function openSettings(via = 'shortcut') {
  if (via === 'shortcut') await page.keyboard.press('Control+,');
  else await page.locator('.side-link', { hasText: 'Ajustes' }).click();
  await dialog().waitFor();
  await poll(async () => (await dialog().getAttribute('data-state')) === 'open', 'Ajustes no se abrió');
}

async function closeSettings(how = 'escape') {
  if (how === 'escape') await page.keyboard.press('Escape');
  else await button('Cerrar Ajustes').click();
  const confirm = page.locator('.request-dialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.locator('.btn-danger').click();
  await dialog().waitFor({ state: 'detached' });
}

async function appearance() {
  await page.getByRole('tab', { name: 'Apariencia' }).click();
  await editor().waitFor();
}

async function applyDraft() {
  await button('Aplicar', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Fondo aplicado' }).waitFor();
}

async function waitPattern() {
  await poll(async () => (await chatField().getAttribute('data-background')) === 'pattern' && (await chatField().getAttribute('data-ready')) === 'true', 'El patrón no se pintó en la conversación');
  // El patrón aparece con un fundido de 900 ms (shell.css).
  await wait(1100);
}

async function peek(action) {
  const peekButton = editor().getByRole('button', { name: 'Mirar el fondo (mantén pulsado)' });
  await peekButton.scrollIntoViewIfNeeded();
  const box = await peekButton.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await poll(async () => (await dialog().getAttribute('data-peek')) !== null, 'Mirar el fondo no apartó el diálogo');
  await wait(260);
  try { return await action(); } finally {
    await page.mouse.up();
    await poll(async () => (await dialog().getAttribute('data-peek')) === null, 'El diálogo no volvió tras mirar el fondo');
  }
}

async function verifyOverlay(ids) {
  // Contenido desplazable y un borrador en el compositor: deben sobrevivir a Ajustes.
  for (let i = 2; i <= 5; i++) {
    await sendText(`Revisa la parte ${i} del módulo de cálculo y resume los cambios. [QA:ACTIVITY-${i}]`);
    await waitReply(ids.codex, i);
  }
  const scroller = page.locator('.chat-scroll');
  await scroller.evaluate((el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.45); });
  await wait(250);
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  assert(scrollBefore > 80, 'La conversación no tiene desplazamiento suficiente');
  await composer().fill('Borrador que debe conservarse');
  const opener = page.locator('.side-link', { hasText: 'Ajustes' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await dialog().waitFor();
  assert(await page.locator('.chat-scroll').isVisible(), 'La conversación debe seguir montada detrás de Ajustes');
  assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollBefore, 'Abrir Ajustes movió la conversación');
  assert(await composer().isVisible(), 'El compositor debe seguir visible detrás');
  assert(await page.evaluate(() => document.querySelector('.composer')?.closest('[inert]') !== null || document.querySelector('dialog.settings-dialog')?.matches(':modal')), 'El compositor no debe ser interactivo con Ajustes abierto');
  await shot('01-conversacion-con-ajustes-superpuestos');
  // Teclado: flechas en la navegación y trampa de foco.
  const active = () => page.evaluate(() => document.activeElement?.closest('dialog.settings-dialog') ? document.activeElement.getAttribute('role') + ':' + (document.activeElement.textContent ?? '').trim().slice(0, 24) : 'FUERA');
  assert.match(await active(), /^tab:Apariencia/);
  await page.keyboard.press('ArrowDown');
  await poll(async () => (await active()).startsWith('tab:Conversaciones'), 'Flecha abajo no movió la sección');
  await page.getByRole('tabpanel').getByText('Al abrir Duovra').waitFor();
  await page.keyboard.press('End');
  await poll(async () => (await active()).startsWith('tab:Datos'), 'Fin no llevó a la última sección');
  await page.keyboard.press('Home');
  await poll(async () => (await active()).startsWith('tab:Apariencia'), 'Inicio no volvió a Apariencia');
  const seen = new Set();
  let previous = '';
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    let where = await active();
    // Si el control enfocado acaba de desmontarse, Duovra devuelve el foco al panel en el siguiente fotograma.
    if (where === 'FUERA') { await wait(120); where = await active(); }
    const detail = where === 'FUERA' ? await page.evaluate(() => (document.activeElement?.outerHTML ?? 'null').slice(0, 200)) : '';
    assert.notEqual(where, 'FUERA', `El foco salió del diálogo con Tab tras «${previous}» hacia ${detail}`);
    seen.add(where);
    previous = where;
  }
  pass(`Ajustes superpuestos: conversación montada, desplazamiento intacto, navegación con flechas/Inicio/Fin y foco atrapado (${seen.size} paradas con Tab)`);
  await closeSettings('escape');
  assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollBefore, 'Cerrar Ajustes no restauró la posición');
  assert.equal(await composer().inputValue(), 'Borrador que debe conservarse');
  assert(await opener.evaluate((el) => el === document.activeElement), 'El foco no volvió al botón que abrió Ajustes');
  // Botón de cierre y clic fuera.
  await openSettings();
  await closeSettings('button');
  await openSettings();
  await page.mouse.click(8, 450);
  await dialog().waitFor({ state: 'detached' });
  await composer().fill('');
  pass('Escape, botón Cerrar y clic fuera cierran; posición, borrador y foco del disparador se restauran');
}

async function verifyLivePreview() {
  await openSettings();
  await appearance();
  const before = await stagePixels();
  const writes = JSON.stringify(await getState());
  await preset('streaks').click();
  await waitPattern();
  const streaks = await stagePixels();
  const delta = distance(before, streaks);
  stats.livePreview = delta;
  assert(delta.percent > 8, 'El fondo de detrás no cambió al elegir un preset: ' + JSON.stringify(delta));
  // Ajustes continuos: sin escrituras en SQLite.
  const amount = editor().getByRole('slider', { name: 'Intensidad' });
  await amount.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await amount.getAttribute('aria-valuenow'), '34');
  assert.equal(JSON.stringify(await getState()), writes, 'La vista previa escribió en SQLite');
  const brighter = distance(streaks, await stagePixels());
  assert(brighter.percent > 2, 'La intensidad no cambió el fondo real');
  await shot('02-galeria-de-fondos');
  // Cancelar restaura por completo.
  await button('Cancelar', editor()).click();
  await poll(async () => (await chatField().getAttribute('data-background')) !== 'pattern', 'Cancelar no restauró el fondo');
  await poll(async () => (await chatField().getAttribute('data-background')) === 'original', 'Cancelar no devolvió el fondo Original');
  assert.equal(await page.locator('.chat-reading-veil').count(), 0, 'Quedó el velo del patrón tras cancelar');
  assert.equal(JSON.stringify(await getState()), writes);
  // Cerrar con cambios pendientes pide confirmación; rechazarla conserva la vista previa.
  await preset('vivid').click();
  await waitPattern();
  await page.keyboard.press('Escape');
  const confirm = page.locator('.request-dialog');
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  assert(await dialog().isVisible(), 'Rechazar la confirmación cerró Ajustes');
  assert.equal(await chatField().getAttribute('data-background'), 'pattern');
  await page.keyboard.press('Escape');
  await confirm.waitFor();
  await confirm.locator('.btn-danger').click();
  await dialog().waitFor({ state: 'detached' });
  await poll(async () => (await chatField().getAttribute('data-background')) === 'original', 'Cerrar descartando no restauró el fondo');
  assert.equal(JSON.stringify(await getState()), writes);
  pass(`Vista previa en la conversación real (${delta.percent} % de píxeles cambian), sin escrituras al arrastrar; Cancelar y cerrar descartando restauran el fondo`);
}

async function verifyPatterns() {
  await openSettings();
  await appearance();
  await preset('vivid').click();
  await waitPattern();
  const samples = {};
  const names = { streaks: 'Streaks', tubes: 'Tubes', tiles: 'Tiles', aurora: 'Aurora' };
  for (const [index, [pattern, label]] of Object.entries(names).entries()) {
    await radio(label).click();
    await waitPattern();
    await applyDraft();
    const state = await getState();
    assert.equal(state.active.config.pattern.pattern, pattern);
    await closeSettings();
    await waitPattern();
    samples[pattern] = await stagePixels();
    await shot(`0${3 + index}-fondo-${pattern}`);
    await openSettings();
    await appearance();
  }
  const keys = Object.keys(samples);
  stats.patterns = {};
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const d = distance(samples[keys[i]], samples[keys[j]]);
    stats.patterns[`${keys[i]}-${keys[j]}`] = d;
    assert(d.percent > 10, `${keys[i]} y ${keys[j]} se parecen demasiado: ${JSON.stringify(d)}`);
  }
  pass('Cuatro patrones aplicados, persistidos y visualmente distintos en la conversación: ' + JSON.stringify(stats.patterns));

  // Tratamientos sobre Aurora (vista previa con el diálogo apartado).
  const treatments = {};
  for (const label of ['Dither', 'ASCII', 'Halftone', 'Soft']) {
    await radio(label).click();
    await poll(async () => (await chatField().getAttribute('data-texture')) === label.toLowerCase(), 'No cambió el tratamiento ' + label);
    await wait(900);
    treatments[label] = await peek(() => stagePixels());
  }
  stats.treatments = {};
  const tk = Object.keys(treatments);
  for (let i = 0; i < tk.length; i++) for (let j = i + 1; j < tk.length; j++) {
    const d = distance(treatments[tk[i]], treatments[tk[j]]);
    stats.treatments[`${tk[i]}-${tk[j]}`] = d;
    assert(d.percent > 5, `${tk[i]} y ${tk[j]} no se distinguen: ${JSON.stringify(d)}`);
  }
  pass('Cuatro tratamientos (Dither, ASCII, Halftone, Soft) distintos sobre el fondo real');

  // Presets: las ocho miniaturas son fotogramas distintos del motor.
  const thumbs = {};
  for (const presetId of ['quiet', 'streaks', 'corner', 'ascii', 'halftone', 'still', 'mono', 'vivid']) {
    const thumb = preset(presetId).locator('.background-preset-thumb');
    await poll(async () => (await thumb.locator('[data-activity][aria-hidden="true"]').getAttribute('data-ready')) === 'true', 'Miniatura sin dibujar: ' + presetId);
    thumbs[presetId] = rgb(await thumb.screenshot());
  }
  let minimum = Infinity;
  const ids = Object.keys(thumbs);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) minimum = Math.min(minimum, distance(thumbs[ids[i]], thumbs[ids[j]]).percent);
  stats.presetMinimumDifference = minimum;
  assert(minimum > 2, 'Hay presets casi idénticos: ' + minimum);
  // Con Ajustes abierto: un solo worker para la conversación y las ocho miniaturas.
  if (!old) {
    stats.workersSettingsOpen = await workerCount();
    assert.equal(stats.workersSettingsOpen, 1, 'Ajustes no debe arrancar workers adicionales');
  }
  pass(`Ocho presets con miniaturas reales y distintas (diferencia mínima ${minimum} %), un único worker con Ajustes abierto`);

  // Color y movimiento.
  await preset('streaks').click();
  await waitPattern();
  const agentColour = await peek(() => stagePixels());
  await radio('Mono').click();
  await wait(900);
  const mono = await peek(() => stagePixels());
  await radio('Propio').click();
  const hue = editor().getByRole('slider', { name: 'Matiz' });
  await hue.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('PageUp');
  await wait(900);
  const custom = await peek(() => stagePixels());
  stats.colour = { agentMono: distance(agentColour, mono), monoCustom: distance(mono, custom) };
  assert(stats.colour.agentMono.mean > 1 && stats.colour.monoCustom.mean > 1, 'El color no cambió: ' + JSON.stringify(stats.colour));
  const speed = editor().getByRole('slider', { name: 'Movimiento' });
  await speed.focus();
  await page.keyboard.press('Home');
  await poll(async () => (await chatField().getAttribute('data-running')) === 'false', 'Movimiento 0 no detuvo el fondo');
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');
  await poll(async () => (await chatField().getAttribute('data-running')) === 'true', 'Con movimiento el fondo no se animó');
  pass('Color de agente, Mono y Propio cambian el fondo; Movimiento 0 lo deja quieto y al subirlo vuelve a animarse');
  await button('Cancelar', editor()).click();
  await closeSettings();
}

async function verifyImageAndPresets() {
  await openSettings();
  await appearance();
  // El preset de la beta sigue en «Mis presets» y se pinta con su motor original.
  await preset(legacyPreset.id).click();
  await poll(async () => (await chatField().getAttribute('data-background')) === 'waves', 'El preset antiguo no se pintó');
  await button('Editar como patrón', editor()).click();
  await waitPattern();
  assert.equal((await getState()).presets[0].config.kind, 'waves', 'Convertir no debe tocar el preset guardado');
  // Imagen personal: validación y copia en Rust, ajustes visuales, aplicar.
  await preset('image').click();
  await editor().locator('input[type="file"]').setInputFiles({ name: 'paisaje.png', mimeType: 'image/png', buffer: await landscape(page) });
  await editor().getByRole('status').filter({ hasText: 'Imagen lista' }).waitFor();
  await page.locator('.chat-backdrop-image img').waitFor();
  const dim = editor().getByRole('slider', { name: 'Oscurecer' });
  await dim.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageDown');
  await applyDraft();
  const state = await getState();
  assert.equal(state.active.config.kind, 'image');
  assert(state.active.config.image.dim < 36, 'Oscurecer no se guardó');
  await closeSettings();
  await page.locator('.chat-backdrop-image img').waitFor();
  await shot('11-imagen-personal-con-compositor');
  pass('Preset personal de la beta conservado y convertible sin tocarlo; imagen importada, oscurecida y aplicada');
  // Guardar un preset propio de patrón.
  await openSettings();
  await appearance();
  await preset('halftone').click();
  await waitPattern();
  await button('Guardar como preset', editor()).click();
  await editor().getByRole('textbox', { name: 'Nombre del preset' }).fill('Halftone propio');
  await button('Guardar', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Preset guardado' }).waitFor();
  await applyDraft();
  const saved = await getState();
  assert(saved.presets.some((item) => item.name === 'Halftone propio' && item.config.kind === 'pattern'));
  assert(saved.presets.some((item) => item.id === legacyPreset.id && item.config.kind === 'waves'));
  await closeSettings();
  pass('Preset propio de patrón guardado junto al preset antiguo');
}

async function verifyComposer(ids) {
  await openSettings();
  await appearance();
  await preset('vivid').click();
  await waitPattern();
  await applyDraft();
  await closeSettings();
  await page.mouse.click(1000, 300);
  await wait(300);
  const card = page.locator('.composer');
  await clipShot('07-compositor-reposo', card);
  await card.hover();
  await clipShot('07b-compositor-hover', card);
  await composer().click();
  await wait(450);
  const lift = await card.evaluate((el) => getComputedStyle(el, '::after').opacity);
  assert.equal(lift, '1', 'El foco no elevó el cristal');
  const filter = await card.evaluate((el) => getComputedStyle(el).backdropFilter);
  assert.match(filter, /blur/, 'El compositor no desenfoca el fondo');
  await clipShot('08-compositor-con-foco', card);
  await composer().fill('Primera línea del mensaje\nSegunda línea con más detalle\nTercera línea\nCuarta línea\nQuinta línea');
  await clipShot('12-compositor-multilinea', card);
  await composer().fill('');
  // Menús: no los recortan el desenfoque ni las máscaras del cristal.
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  for (const [trigger, name] of [[/^Agente para el próximo mensaje/, 'agente'], [/^Modelo:/, 'modelo'], [/^Esfuerzo:/, 'esfuerzo']]) {
    await page.getByRole('button', { name: trigger }).click();
    const menu = page.locator('.popover').last();
    await menu.waitFor();
    await wait(260);
    const box = await menu.boundingBox();
    assert(box && box.y >= 0 && box.x >= 0 && box.x + box.width <= viewport.w && box.y + box.height <= viewport.h, 'Menú recortado: ' + name);
    const outside = await menu.evaluate((el) => !el.closest('.composer'));
    assert(outside, 'El menú vive dentro del cristal: ' + name);
    await shot('13-menu-' + name);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' }).catch(() => undefined);
  }
  pass('Compositor de cristal: desenfoque, elevación con foco, texto multilínea y menús de agente, modelo y esfuerzo sin recortes');
  // Adjuntos.
  await invoke('set_draft_attachments', { conversationId: ids.codex, paths: [join(project, 'notas.txt'), join(project, 'src', 'math.js')] });
  await page.reload();
  await composer().waitFor();
  await page.locator('.attach-chip').first().waitFor();
  await clipShot('14-compositor-adjuntos', page.locator('.composer-wrap'));
  await invoke('set_draft_attachments', { conversationId: ids.codex, paths: [] });
  await page.reload();
  await composer().waitFor();
  // Ejecución, cola contraída y desplegada, autorización y Ajustes durante el streaming.
  await sendText('Revisa el módulo con calma. [QA:ACTIVITY-HOLD-PATTERN]');
  await waitProvider('ACTIVITY-HOLD-PATTERN');
  await poll(async () => !['idle', null].includes(await chatField().getAttribute('data-activity')), 'El fondo no reaccionó al turno');
  stats.heavyLoad = await animationSample(2500);
  await sendText('Después añade pruebas. [QA:QUEUE-ONE]');
  await sendText('Y actualiza la documentación. [QA:QUEUE-TWO]');
  const head = page.locator('.queue-next');
  await head.waitFor();
  await clipShot('15-cola-contraida', page.locator('.composer-wrap'));
  await head.click();
  await page.locator('.execution-queue-body').waitFor();
  await clipShot('16-cola-desplegada', page.locator('.composer-wrap'), 16);
  await head.click();
  await openSettings();
  await page.locator('.settings-activity').filter({ hasText: 'trabajando' }).waitFor();
  assert(await chatField().getAttribute('data-activity') !== 'idle');
  await shot('17-ajustes-durante-ejecucion');
  release('ACTIVITY-HOLD-PATTERN');
  await waitReply(ids.codex, 6);
  await closeSettings();
  await poll(async () => (await page.locator('.queue-next').count()) === 0, 'La cola no se vació tras el turno', 30_000);
  pass('Ajustes abierto durante un turno: el agente siguió, la respuesta llegó y la cola se procesó; carga visual alta medida');
  // Autorización con Ajustes abierto.
  await sendText('Ejecuta el comando de prueba. [QA:HOLD-APPROVAL]');
  await waitProvider('HOLD-APPROVAL');
  await openSettings();
  await page.locator('.settings-activity[data-waiting]').waitFor();
  await shot('18-ajustes-con-autorizacion-pendiente');
  await page.locator('.settings-activity').getByRole('button', { name: 'Revisar' }).click();
  await dialog().waitFor({ state: 'detached' });
  await page.locator('.composer[data-waiting]').waitFor();
  const approve = page.getByRole('button', { name: /Permitir|Aprobar|Aceptar/ }).first();
  assert(await approve.isEnabled(), 'Los controles de permiso deben seguir disponibles');
  await clipShot('19-autorizacion-con-cristal', page.locator('.composer-wrap'), 16);
  await button('Cancelar ejecución').click();
  await poll(async () => (await chatField().getAttribute('data-activity')) !== 'waiting', 'No se detuvo la ejecución', 15_000);
  pass('Autorización pendiente avisada en Ajustes, acceso directo a la conversación y controles de permiso visibles');
  // Workbench abierto y cerrado.
  await button('Mostrar Workbench').click();
  await page.locator('#workbench, .right-panel').first().waitFor().catch(() => undefined);
  await wait(500);
  await shot('20-workbench-abierto');
  await button('Ocultar Workbench').click();
  await wait(400);
}

async function verifyAgents(ids) {
  await shot('10-conversacion-con-codex');
  await page.locator('.tree-conv', { hasText: 'Documentación con Claude Code' }).click();
  await composer().waitFor();
  await page.getByRole('button', { name: /^Agente para el próximo mensaje/ }).click();
  await page.getByRole('menuitemradio', { name: /Claude Code/ }).click();
  await wait(900);
  const claudeIdle = await stagePixels();
  await page.getByRole('button', { name: /^Agente para el próximo mensaje/ }).click();
  await page.getByRole('menuitemradio', { name: /Codex/ }).click();
  await wait(900);
  const codexIdle = await stagePixels();
  stats.agentColour = distance(claudeIdle, codexIdle);
  assert(stats.agentColour.mean > 1, 'Cambiar de agente no cambió el color del fondo');
  await page.getByRole('button', { name: /^Agente para el próximo mensaje/ }).click();
  await page.getByRole('menuitemradio', { name: /Claude Code/ }).click();
  await sendText('Resume el propósito del proyecto en dos frases. [QA:CLAUDE-PATTERN]');
  await waitReply(ids.claude, 1);
  await wait(600);
  await shot('09-conversacion-con-claude-code');
  pass('Conversación con Claude Code y con Codex; el color del fondo sigue al agente elegido (' + JSON.stringify(stats.agentColour) + ')');
}

async function verifyMotionAndWindow() {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await poll(async () => (await chatField().getAttribute('data-running')) === 'false', 'Movimiento reducido no detuvo el patrón');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await poll(async () => (await chatField().getAttribute('data-running')) === 'true', 'El patrón no volvió a animarse');
  await invoke('plugin:window|minimize', { label: 'main' });
  await poll(async () => (await chatField().getAttribute('data-running')) === 'false', 'El patrón siguió animándose minimizado');
  await invoke('plugin:window|unminimize', { label: 'main' });
  await invoke('plugin:window|set_focus', { label: 'main' });
  await page.bringToFront();
  await poll(async () => (await chatField().getAttribute('data-running')) === 'true', 'El patrón no reanudó al restaurar');
  pass('Movimiento reducido detiene el patrón; minimizar lo pausa y restaurar lo reanuda');
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 820, height: 700 } } }).catch(() => undefined);
  await wait(700);
  await shot('21-ventana-estrecha');
  await openSettings();
  await shot('22-ajustes-ventana-estrecha');
  await closeSettings();
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 1440, height: 900 } } }).catch(() => undefined);
  await wait(700);
}

async function verifyRestart() {
  const before = await getState();
  await shutdown();
  await boot();
  await composer().waitFor();
  const after = await getState();
  assert.deepEqual(after, before, 'El fondo o los presets cambiaron al reiniciar');
  await poll(async () => (await chatField().getAttribute('data-background')) === 'pattern', 'El fondo aplicado no se recuperó');
  pass('Reinicio: fondo aplicado, preset propio y preset de la beta recuperados');
}

async function video() {
  await recordScreencast('patrones-en-duovra', async () => {
    await wait(700);
    await openSettings();
    await appearance();
    await wait(700);
    for (const presetId of ['streaks', 'ascii', 'halftone', 'corner', 'vivid']) {
      await preset(presetId).click();
      await wait(1300);
    }
    await peek(() => wait(1100));
    await closeSettings();
    await wait(500);
    await composer().click();
    await page.keyboard.type('Revisa el diff y prepara las pruebas', { delay: 28 });
    await wait(900);
    await composer().fill('');
  });
}

async function performance(label, expectRunning = true) {
  await page.mouse.move(1000, 300);
  if (expectRunning) await poll(async () => (await chatField().getAttribute('data-running')) === 'true', 'El fondo no animó en reposo para medir');
  const sample = { ...(await animationSample(3500)), running: await chatField().getAttribute('data-running'), workers: await workerCount(), memory: await memory() };
  ((stats.performance ??= {})[label] ??= []).push(sample);
  console.log('Rendimiento', label, sample.cpuPercentOfOneCore, sample.running);
}

/**
 * Comparación breve y alternada (tres rondas) con el portable anterior: suelo con todo quieto
 * (movimiento reducido), Original, un fondo a pantalla completa y Ajustes → Apariencia.
 */
async function perfRounds(fullStage) {
  for (let round = 0; round < 3; round++) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await wait(900);
    await performance('suelo-todo-quieto', false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await setting(stateKey, { active: { presetId: 'original', config: { kind: 'original' } }, presets: [] });
    await page.reload();
    await composer().waitFor();
    await wait(1500);
    await performance('original-reposo');
    if (!old) {
      const noBlur = await page.addStyleTag({ content: '.composer, .stage, .execution-queue { backdrop-filter: none !important }' });
      await performance('original-sin-desenfoque');
      await noBlur.evaluate((el) => el.remove());
    }
    await setting(stateKey, { active: fullStage, presets: [] });
    await page.reload();
    await composer().waitFor();
    await wait(1500);
    await performance('pantalla-completa-reposo');
    if (old) {
      await page.getByRole('button', { name: 'Ajustes' }).first().click();
      await page.locator('.settings-nav', { hasText: 'Apariencia' }).click();
      await page.locator('[data-background-editor]').waitFor();
    } else {
      await openSettings();
      await appearance();
    }
    await wait(5000);
    await performance('ajustes-apariencia', false);
    if (old) await page.getByRole('button', { name: 'Volver a la conversación' }).click().catch(() => undefined);
    else await closeSettings();
  }
  const summary = {};
  for (const [label, samples] of Object.entries(stats.performance)) {
    const cpu = samples.map((sample) => sample.cpuPercentOfOneCore).sort((a, b) => a - b);
    summary[label] = { cpuMedian: cpu[Math.floor(cpu.length / 2)], cpu, p95: samples.map((sample) => sample.pageFrameP95Ms), running: samples.map((sample) => sample.running) };
  }
  stats.performanceSummary = summary;
  console.log(JSON.stringify(summary, null, 1));
}

async function verifyOld() {
  seedFixture();
  await boot();
  const ids = await seedConversations();
  await sendText('Revisa la parte 1. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  // El fondo a pantalla completa más parecido del editor anterior: Ondas.
  await perfRounds({ presetId: 'waves', config: legacyPreset.config });
}

async function counters(ms = 2000) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const a = await read();
    await wait(ms);
    const b = await read();
    const keys = ['LayoutCount', 'RecalcStyleCount', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
    return Object.fromEntries(keys.map((key) => [key, Number((b[key] - a[key]).toFixed(3))]));
  } finally { await cdp.detach(); }
}

async function verifyProbe() {
  seedFixture();
  await boot();
  await seedConversations();
  await setting(stateKey, { active: { presetId: 'original', config: { kind: 'original' } }, presets: [] });
  await page.reload();
  await composer().waitFor();
  await openSettings();
  await appearance();
  await wait(5000);
  const report = async (label) => {
    const info = await page.evaluate(() => ({
      animations: document.getAnimations().map((a) => (a.animationName ?? a.constructor.name) + ':' + (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '')).slice(0, 12),
      running: [...document.querySelectorAll('[data-activity][aria-hidden="true"]')].map((el) => el.dataset.running),
    }));
    console.log(label, JSON.stringify(info), JSON.stringify(await counters()), JSON.stringify(await animationSample(2500)));
  };
  await report('ajustes');
  const hide = await page.addStyleTag({ content: '.background-preset-thumb { visibility: hidden !important }' });
  await report('sin-miniaturas');
  await hide.evaluate((el) => el.remove());
  const noBlur = await page.addStyleTag({ content: '.composer, .stage, .execution-queue { backdrop-filter: none !important }' });
  await report('sin-desenfoque-compositor');
  await noBlur.evaluate((el) => el.remove());
  await page.getByRole('tab', { name: 'Conversaciones' }).click();
  await wait(3000);
  await report('otra-seccion');
  await closeSettings();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await wait(2000);
  await report('sin-ajustes-quieto');
}

async function verifyPerf() {
  seedFixture();
  await boot();
  const ids = await seedConversations();
  await sendText('Revisa la parte 1. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  await perfRounds({ presetId: 'streaks', config: { kind: 'pattern', pattern: { pattern: 'streaks', style: 'dither', amount: 22, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 86, speed: 40, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true } } });
}

async function verifyRefinement() {
  seedFixture();
  await boot();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const after = refinement === 'despues';
  const selectCategory = (name) => button(name, editor()).click();
  const changeOption = async (label, option) => {
    await editor().getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const cdp = await page.context().newCDPSession(page);
  const size = async (width, height, deviceScaleFactor = 1) => {
    await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width, height } } });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: width - 1, height, deviceScaleFactor, mobile: false });
    await wait(100);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    await wait(250);
  };
  await size(1440, 900);
  if (after) {
    await page.locator('.studio-intro').waitFor({ state: 'hidden' });
    await shot('00-aplicacion-recien-abierta');
  }
  const ids = await seedConversations();
  const ready = () => poll(async () => (await chatField().getAttribute('data-ready')) === 'true', 'Falta el primer fotograma');
  async function measure(label) {
    await ready();
    stats[label] = await page.evaluate(() => {
      const rect = (node) => node?.getBoundingClientRect().toJSON();
      const field = document.querySelector('.chat-stage > [data-activity][aria-hidden="true"]');
      const canvas = field?.querySelector('canvas');
      const veil = document.querySelector('.chat-reading-veil');
      return {
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        stage: rect(field?.parentElement), field: rect(field), canvas: rect(canvas),
        texture: field?.dataset.texture, quality: field?.dataset.quality ?? '0', thread: field?.dataset.thread,
        opacity: getComputedStyle(field).opacity, mask: getComputedStyle(field).maskImage,
        cell: Number.parseFloat(field.style.getPropertyValue('--cell')),
        veil: veil && { gradient: getComputedStyle(veil).backgroundImage, mask: getComputedStyle(veil).maskImage },
      };
    });
    if (after) {
      const { field, stage, canvas } = stats[label];
      assert.deepEqual(field, stage, label + ': la superficie difiere del escenario');
      assert(canvas.right >= field.right - .03 && canvas.bottom >= field.bottom - .03, label + ': lienzo cortado');
    }
  }
  await measure('original-vacio');
  await shot('01-original-vacio');
  const initial = await stagePixels();
  await sendText('Revisa el cálculo y explica los cambios con ejemplos y un diff. [QA:ACTIVITY-REFINEMENT-1]');
  if (after) {
    await waitProvider('ACTIVITY-REFINEMENT-1');
    await poll(async () => !['idle', 'done'].includes(await chatField().getAttribute('data-activity')), 'Falta el estado de ejecución del primer turno');
    await measure('original-primer-turno');
  }
  await waitReply(ids.codex, 1);
  await composer().blur();
  // Original brilla 2,5 s al completar el turno (reactividad histórica): la composición se compara en reposo.
  if (after) await poll(async () => (await chatField().getAttribute('data-activity')) === 'idle', 'Original no volvió al reposo', 8000);
  await measure('original-con-mensajes');
  await shot('02-original-con-mensajes');
  stats.originalDifference = distance(initial, await stagePixels());
  if (after) assert(stats.originalDifference.percent < 0.05, 'Original cambió con el primer mensaje');
  for (let i = 2; i <= 4; i++) {
    await sendText(`Revisa el caso ${i} y documenta la solución. [QA:ACTIVITY-REFINEMENT-${i}]`);
    await waitReply(ids.codex, i);
  }
  await invoke('set_setting', {
    key: stateKey, value: { ...(await getState()), active: { presetId: 'vivid', config: { kind: 'pattern', pattern: {
      pattern: 'streaks', style: 'dither', amount: 54, focus: { x: 0.72, y: 0.78 }, reach: 100,
      detail: 82, speed: 50, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true,
    } } } },
  });
  await page.reload();
  await composer().waitFor();
  const scroll = page.locator('.chat-scroll');
  await scroll.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.43; });
  await page.mouse.move(1260, 218);
  await measure('vivid-con-texto');
  await shot('03-vivid-con-texto');
  await openSettings();
  await appearance();
  if (after) await selectCategory('Patrones');
  await preset('ascii').click();
  await measure('ascii');
  await shot('04-galeria-y-ascii');
  await applyDraft();
  await closeSettings();
  await shot('05-ascii-aplicado');
  const appliedAscii = await getState();
  if (after) {
    // La comparación geométrica usa los mismos parámetros que el preset de la integración.
    const ascii = appliedAscii.active.config.pattern;
    await setting(stateKey, { ...appliedAscii, active: {
      presetId: 'ascii', config: { kind: 'pattern', pattern: { ...ascii, amount: 36, detail: 76, speed: 30 } },
    } });
    await page.reload();
    await composer().waitFor();
    await scroll.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.43; });
  }
  await size(1440, 900, 1.1);
  await measure('ascii-dpr-fraccionario');
  await shot('05b-ascii-dpr-fraccionario', { scale: 'css' });
  await size(1366, 768, 1.25);
  await button('Mostrar Workbench').click();
  await measure('ascii-workbench-dpr');
  await shot('06-ascii-workbench-dpr', { scale: 'css' });
  await button('Ocultar Workbench').click();
  pass('Comparación visual aislada de Original, composición bajo texto, ASCII y escala con Workbench');
  if (after) {
    await setting(stateKey, appliedAscii);
    await page.reload();
    await composer().waitFor();
    await verifyRefinementGallery({ measure, size, selectCategory, changeOption });
    await verifyRefinementConversation({ ids, measure, size, selectCategory });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const normalDpr = await page.evaluate(() => devicePixelRatio);
    await setting('ui.textScale', 1.1);
    await page.reload();
    await composer().waitFor();
    await poll(() => page.evaluate((normal) => devicePixelRatio > normal + 0.05, normalDpr), 'No cambió el zoom nativo');
    await measure('zoom-real');
    await setting('ui.textScale', 1);
  }
  await cdp.detach();
  if (after) await verifyRefinementPersistence({ selectCategory });
}

async function verifyRefinementGallery({ measure, size, selectCategory, changeOption }) {
  const initialState = await getState();
  await size(1440, 900);
  await openSettings();
  await appearance();
  await selectCategory('Recomendados');
  assert.equal(await editor().locator('[data-background-preset]').count(), 4);
  await selectCategory('Duovra');
  assert.equal(await editor().locator('[data-background-preset]').count(), 5);
  await selectCategory('Patrones');
  assert.equal(await editor().locator('[data-background-preset]').count(), 8);
  assert.equal(await editor().locator('.bg-controls details').getAttribute('open'), null);
  assert.equal(await editor().locator('.bg-preset-management').getAttribute('open'), null);
  await page.getByRole('tab', { name: 'Apariencia' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Cerrar Ajustes');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
  await shot('07-ajustes-simplificados');
  await chatField().locator('canvas').evaluate((canvas) => { window.qaFieldCanvas = canvas; });
  const textureOf = { ascii: 'ascii', halftone: 'halftone' };
  const display = { streaks: 'streaks', corner: 'aurora', still: 'tiles', mono: 'tubes', halftone: 'halftone', vivid: 'vivid' };
  const preview = button('Ver en la conversación', editor());
  for (const id of ['quiet', 'streaks', 'corner', 'ascii', 'halftone', 'still', 'mono', 'vivid']) {
    await preset(id).click();
    const thumb = preset(id).locator('[data-activity][aria-hidden="true"]');
    await poll(async () => (await thumb.getAttribute('data-ready')) === 'true', 'Miniatura sin dibujar: ' + id);
    await poll(async () => (await chatField().getAttribute('data-texture')) === (textureOf[id] ?? 'dither'), 'Textura sin aplicar: ' + id);
    await preview.press('Enter');
    const back = button('Volver a Ajustes', dialog());
    await back.waitFor();
    assert(await back.evaluate((el) => el === document.activeElement), 'Foco fuera del modo de vista previa');
    const [backBox, dialogBox] = await Promise.all([back.boundingBox(), dialog().boundingBox()]);
    assert(backBox && dialogBox && backBox.x + backBox.width <= dialogBox.x + dialogBox.width, 'El diálogo recortó el botón de volver');
    await wait(430);
    await measure('preset-' + id);
    const thumbOpacity = await thumb.evaluate((el) => Number(el.style.getPropertyValue('--field-opacity')));
    assert(Math.abs(Number(stats['preset-' + id].opacity) - thumbOpacity) < 0.001, 'La miniatura cambió la intensidad de ' + id);
    assert(await chatField().locator('canvas').evaluate((canvas) => canvas === window.qaFieldCanvas), 'Se reemplazó el canvas al cambiar el preset');
    if (['mono', 'halftone', 'vivid'].includes(id)) {
      const contrast = lowestBackdropContrast(await stagePixels(true), await readingTones());
      (stats.textContrast ??= {})[id] = contrast;
      assert(contrast.secondary >= 4.5 && contrast.tertiary >= 4.5, 'Contraste de texto insuficiente sobre ' + id);
    }
    if (display[id]) await shot('08-' + display[id]);
    if (id === 'quiet') await back.press('Escape');
    else if (id === 'streaks') await back.click();
    else await back.press('Enter');
    await preview.waitFor();
    assert(await preview.evaluate((el) => el === document.activeElement), 'La vista previa no devolvió el foco');
  }
  await selectCategory('Mis fondos');
  assert.equal(await preset(legacyPreset.id).count(), 1);
  await selectCategory('Patrones');
  assert.equal(await preset('vivid').getAttribute('aria-pressed'), 'true');
  assert.equal(await preset('ascii').locator('.background-preset-tick').count(), 1);
  assert.deepEqual(await getState(), initialState);
  await editor().getByText('Ajustes avanzados', { exact: true }).click();
  assert.equal(await editor().getByRole('slider', { name: 'Foco horizontal' }).count(), 0);
  await changeOption('Patrón', 'Aurora');
  assert.equal(await editor().getByRole('slider', { name: 'Dirección' }).count(), 0);
  await changeOption('Tratamiento', 'Soft');
  await poll(async () => (await chatField().getAttribute('data-texture')) === 'soft', 'No se pintó Soft');
  await changeOption('Color', 'Propio');
  await editor().getByRole('slider', { name: 'Matiz' }).focus();
  await page.keyboard.press('End');
  assert.equal(await editor().getByRole('slider', { name: 'Matiz' }).getAttribute('aria-valuenow'), '360');
  await shot('09-soft-y-avanzados');
  await button('Restaurar valores del preset', editor()).click();
  await poll(async () => (await chatField().getAttribute('data-texture')) === 'dither', 'Restaurar no recuperó el tratamiento');
  await button('Cancelar', editor()).click();
  await poll(async () => (await chatField().getAttribute('data-texture')) === 'ascii', 'Cancelar no recuperó ASCII');
  assert.deepEqual(await getState(), initialState);
  assert.equal(await workerCount(), 1);
  await closeSettings();
  pass('Cuatro galerías y ocho presets con el mismo canvas y un worker; pausa visual, contraste uniforme, color contextual, Soft, Restaurar, Cancelar y teclado');
}

async function verifyRefinementConversation({ ids, measure, size, selectCategory }) {
  await size(960, 800);
  await openSettings();
  await appearance();
  await selectCategory('Patrones');
  await preset('vivid').click();
  await applyDraft();
  await shot('10-ajustes-960');
  await closeSettings();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const activity = () => chatField().getAttribute('data-activity');
  const running = (expected) => poll(async () => (await chatField().getAttribute('data-running')) === expected, 'Movimiento esperado: ' + expected);
  await running('true');
  await composer().focus();
  assert.match(await page.locator('.composer').evaluate((el) => getComputedStyle(el).backdropFilter), /blur/);
  await shot('11-cristal-vivid-960');
  const agentMenu = () => page.getByRole('button', { name: /^Agente para el próximo mensaje/ });
  await agentMenu().click();
  const popover = page.locator('.popover').last();
  const box = await popover.boundingBox();
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 800, 'Menú de agente recortado');
  await page.keyboard.press('Escape');
  await size(1366, 768);
  await sendText('Revisa las validaciones del módulo, presenta los casos con código y resume el diff. [QA:ACTIVITY-HOLD-REFINEMENT]');
  await waitProvider('ACTIVITY-HOLD-REFINEMENT');
  await poll(async () => (await activity()) !== 'idle', 'El fondo no reaccionó al turno');
  await sendText('Después revisa los casos con números negativos. [QA:QUEUE-REFINEMENT]');
  await page.locator('.queue-next').click();
  await page.locator('.execution-queue-body').waitFor();
  await shot('12-codex-actividad-y-cola');
  await openSettings();
  await page.locator('.settings-activity').filter({ hasText: 'trabajando' }).waitFor();
  await closeSettings();
  release('ACTIVITY-HOLD-REFINEMENT');
  await waitReply(ids.codex, 6);
  await page.locator('.code-block').last().scrollIntoViewIfNeeded();
  await page.locator('.code-block pre').last().waitFor();
  await shot('13-respuesta-larga-y-codigo');
  await poll(async () => (await page.locator('.queue-next').count()) === 0, 'La cola no se vació');
  await sendText('Confirma el cambio antes de ejecutar el comando de prueba. [QA:HOLD-APPROVAL]');
  await waitProvider('HOLD-APPROVAL');
  await poll(async () => (await activity()) === 'waiting', 'El fondo no reflejó la espera de permiso');
  await openSettings();
  await page.locator('.settings-activity[data-waiting]').waitFor();
  await page.locator('.settings-activity').getByRole('button', { name: 'Revisar' }).click();
  await dialog().waitFor({ state: 'detached' });
  await shot('14-espera-de-permiso');
  const approve = page.getByRole('button', { name: /Permitir|Aprobar|Aceptar/ }).first();
  await approve.click();
  await poll(async () => (await activity()) !== 'waiting', 'El turno no reanudó tras la autorización');
  release('HOLD-APPROVAL');
  await waitReply(ids.codex, 7);
  await page.locator('.tree-conv', { hasText: 'Documentación con Claude Code' }).click();
  await agentMenu().click();
  await page.getByRole('menuitemradio', { name: /Claude Code/ }).click();
  await sendText('Escribe un resumen breve de los casos de prueba. [QA:HOLD-CLAUDE-REFINEMENT]');
  await waitProvider('HOLD-CLAUDE-REFINEMENT');
  await shot('15-claude-en-ejecucion');
  release('HOLD-CLAUDE-REFINEMENT');
  await waitReply(ids.claude, 1);
  const anotherProject = await invoke('create_project', { name: 'Proyecto QA segundo', path: join(project, 'src') });
  await invoke('create_conversation', { projectId: anotherProject.id, title: 'Conversación alternativa' });
  await page.reload();
  await page.locator('.tree-project').filter({ hasText: 'Proyecto QA segundo' }).click();
  await page.locator('.tree-conv', { hasText: 'Conversación alternativa' }).click();
  await measure('proyecto-distinto');
  await page.locator('.tree-conv', { hasText: 'Revisión del módulo de cálculo' }).click();
  await page.locator('.code-block').last().waitFor({ state: 'attached' });
  await measure('historial-reabierto');
  await sendText('Repite la prueba con una entrada inválida. [QA:FAIL-VISUAL-REFINEMENT]');
  await poll(async () => (await activity()) === 'error', 'El fondo no reflejó el error simulado');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await running('false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await running('true');
  await invoke('plugin:window|minimize', { label: 'main' });
  await running('false');
  await invoke('plugin:window|unminimize', { label: 'main' });
  await invoke('plugin:window|set_focus', { label: 'main' });
  await page.bringToFront();
  await running('true');
  await measure('ventana-restaurada');
  pass('Cristal, menú de agente, texto y código durante una sesión con Codex/Claude, cola, permiso, proyecto, conversación, historial y pausa de ventana');
}

async function verifyRefinementPersistence({ selectCategory }) {
  await openSettings();
  await appearance();
  await selectCategory('Mis fondos');
  await preset(legacyPreset.id).click();
  await poll(async () => (await chatField().getAttribute('data-background')) === 'waves', 'El preset anterior no se pintó');
  await preset('image').click();
  await editor().locator('input[type="file"]').setInputFiles({ name: 'paisaje.png', mimeType: 'image/png', buffer: await landscape(page) });
  await page.locator('.chat-backdrop-image img').waitFor();
  await applyDraft();
  await editor().getByText('Gestionar presets', { exact: true }).click();
  await button('Guardar como preset', editor()).click();
  await editor().getByRole('textbox', { name: 'Nombre del preset' }).fill('Paisaje QA');
  await button('Guardar', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Preset guardado' }).waitFor();
  await applyDraft();
  await button('Renombrar o actualizar', editor()).click();
  await editor().getByRole('textbox', { name: 'Nombre del preset' }).fill('Paisaje QA renombrado');
  await button('Actualizar', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Preset guardado' }).waitFor();
  const saved = (await getState()).presets.find((item) => item.name === 'Paisaje QA renombrado');
  assert(saved?.config.image.id);
  await closeSettings();
  await shot('16-imagen-personal');
  await openSettings();
  await appearance();
  await selectCategory('Patrones');
  await preset('streaks').click();
  await applyDraft();
  await closeSettings();
  await verifyRestart();
  await openSettings();
  await appearance();
  await selectCategory('Mis fondos');
  await preset(saved.id).click();
  await page.locator('.chat-backdrop-image img').waitFor();
  await editor().getByText('Gestionar presets', { exact: true }).click();
  await button('Eliminar preset', editor()).click();
  await page.locator('.request-dialog').getByRole('button', { name: 'Eliminar preset' }).click();
  await editor().getByRole('status').filter({ hasText: 'Preset eliminado' }).waitFor();
  assert(!(await getState()).presets.some((item) => item.id === saved.id));
  assert((await getState()).presets.some((item) => item.id === legacyPreset.id && item.config.kind === 'waves'));
  await closeSettings();
  pass('Importación de imagen, guardado, renombrado, recuperación tras reiniciar y borrado de un preset de prueba; preset anterior conservado');
}

async function verify() {
  if (refinement) return verifyRefinement();
  if (old) return verifyOld();
  if (perfOnly) return verifyPerf();
  if (probe) return verifyProbe();
  seedFixture();
  await boot();
  const ids = await seedConversations();
  await sendText('Revisa la parte 1. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  await verifyOverlay(ids);
  await verifyLivePreview();
  await verifyPatterns();
  await verifyImageAndPresets();
  await verifyComposer(ids);
  await verifyAgents(ids);
  await openSettings();
  await appearance();
  await preset('streaks').click();
  await waitPattern();
  await applyDraft();
  await closeSettings();
  // Detrás de Ajustes, sin cambios recientes, el fondo queda quieto (no consume por estar detrás del modal).
  await openSettings();
  await appearance();
  await poll(async () => (await chatField().getAttribute('data-running')) === 'false', 'El fondo siguió animándose detrás de Ajustes sin cambios', 8000);
  await radio('Tiles').click();
  await poll(async () => (await chatField().getAttribute('data-running')) === 'true', 'El fondo no se animó tras un cambio');
  await poll(async () => (await chatField().getAttribute('data-running')) === 'false', 'El fondo no volvió a quedarse quieto', 8000);
  await button('Cancelar', editor()).click();
  await closeSettings();
  pass('Detrás de Ajustes el fondo queda quieto; tras un cambio se anima unos segundos y vuelve a detenerse');
  await verifyMotionAndWindow();
  await video();
  await verifyRestart();
}

let failure = null;
try {
  await verify();
  assert.deepEqual(pageErrors, [], 'Errores de página en WebView2');
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(error);
  await page?.screenshot({ path: join(shots, old ? 'fallo-anterior.png' : 'fallo.png') }).catch(() => undefined);
} finally {
  await shutdown();
  writeFileSync(join(out, old ? 'rendimiento-anterior.json' : perfOnly ? 'rendimiento.json' : 'resultado.json'), JSON.stringify({
    webview: webviewVersion, exe: basename(exe), checks, stats, pageErrors, providersSimulated: true, failure,
  }, null, 2));
  // Solo los directorios creados por esta ejecución y validados dentro de sus raíces.
  const owned = [[session, out, basename(session)]];
  if (fixtureOwned) owned.push([dbDir, join(appData, identifier, 'fixtures'), id]);
  for (const [path, expectedParent, expectedName] of owned) {
    if (existsSync(path) && dirname(realpathSync(path)) === realpathSync(expectedParent) && basename(path) === expectedName) {
      for (let retry = 0; retry < 4; retry++) {
        try { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); break; }
        catch (error) { if (retry === 3) console.warn('Directorio temporal en uso', error.message); else await wait(450); }
      }
    }
  }
}
if (failure) process.exitCode = 1;

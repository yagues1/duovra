// Revisión independiente (Claude) de la integración visual de fondos en WebView2 real.
// Usa los adaptadores de protocolo locales (execution-queue-agent.mjs): no invoca proveedores.
// Cada ejecución usa un SQLite y un perfil de WebView2 desechables bajo la identidad QA indicada.
//
//   node scripts/qa/pattern-review.mjs --exe <portable.exe> --identifier <id> --label <nombre> --scenario <escenario>
//
// Escenarios: original (Original en reposo, trabajando y esperando, perfil por filas), continuity (vídeo
// continuo reposo → ejecución → permiso → ejecución → completado → reposo y cambio de agente),
// presets (presets intensos en conversación larga), switching (cambios rápidos de preset y tratamiento),
// coverage (cobertura con DPR y tamaños), settings (Ajustes y vista previa), composer (compositor),
// resources (workers, minimizado y movimiento reducido). En producción se ejecuta al final.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const exe = resolve(arg('--exe', join(root, 'output', 'qa', 'pattern-review', 'app', 'Duovra Revision QA.exe')));
const identifier = arg('--identifier', 'dev.duovra.studio.qa.pattern-review');
const label = arg('--label', 'revision');
const scenarios = arg('--scenario', 'original').split(',');
const stableProfile = identifier === 'dev.duovra.studio.beta';
const profileEnv = stableProfile ? 'DUOVRA_BETA_TEST_PROFILE'
  : identifier === 'dev.duovra.studio.qa.background' ? 'DUOVRA_BACKGROUND_TEST_PROFILE' : 'DUOVRA_PATTERN_TEST_PROFILE';
assert(existsSync(exe), 'Falta el ejecutable ' + exe);
assert(process.env.APPDATA, 'La prueba requiere Windows');

const out = join(root, 'output', 'qa', 'pattern-review', label);
const shots = join(out, 'capturas');
mkdirSync(shots, { recursive: true });
const id = randomUUID();
const appData = realpathSync(process.env.APPDATA);
const dbDir = join(appData, identifier, 'fixtures', id);
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
for (const name of Object.keys(env)) if (/^(webview2_|anthropic_|openai_|claude_|codex_)/i.test(name)) delete env[name];
Object.assign(env, {
  CODEX_HOME: profiles.codex, CLAUDE_CONFIG_DIR: profiles.claude, DUOVRA_QUEUE_FIXTURE: session,
  WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'), [profileEnv]: id,
});

const results = { exe, identifier, label, scenarios, started: new Date().toISOString(), checks: [], findings: [], stats: {} };
const pageErrors = [];
const providerLog = join(session, 'provider.ndjson');
const events = () => existsSync(providerLog) ? readFileSync(providerLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const pass = (text) => { results.checks.push(text); console.log('PASS', text); };
const note = (text) => { results.findings.push(text); console.log('NOTA', text); };
const release = (tag) => writeFileSync(join(session, tag + '.release'), '');
let processHandle, browser, page;

async function poll(read, description, timeout = 12_000) {
  const start = Date.now();
  let cause;
  do {
    try { const result = await read(); if (result) return result; } catch (error) { cause = error; }
    await wait(90);
  } while (Date.now() - start < timeout);
  throw new Error(description, { cause });
}

function seedFixture(background = { active: { presetId: 'original', config: { kind: 'original' } }, presets: [] }) {
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, 'studio.sqlite3'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const write = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({
      'agents.codex.path': executables.codex, 'agents.claude.path': executables.claude,
      'defaults.agent': 'codex', 'defaults.model.codex': 'gpt-6-luna', 'defaults.effort.codex': 'high',
      'defaults.model.claude': 'haiku', 'defaults.effort.claude': 'medium', 'composer.enterToSend': true,
      'startup.view': 'last', 'startup.restoreConversation': true, [stateKey]: background,
    })) write.run(key, JSON.stringify(value));
  } finally { db.close(); }
}

const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const setting = (key, value) => invoke('set_setting', { key, value });
const getSettings = () => invoke('bootstrap').then((boot) => boot.settings);

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
  results.webview = browser.version();
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
const chatField = () => page.locator('.chat-stage > .background-field').first();
const dialog = () => page.locator('dialog.settings-dialog');
const editor = () => page.locator('[data-background-editor]');
const preset = (presetId) => editor().locator(`[data-background-preset="${presetId}"]`);

async function shot(name, options = {}) {
  await wait(300);
  await page.screenshot({ path: join(shots, name + '.png'), ...options });
  console.log('Captura', name);
}

function ffmpeg(args, options = {}) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
const rgb = (png) => ffmpeg(['-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: png });

/** Fondo de la conversación sin texto, compositor ni diálogo: los píxeles que pinta el campo. */
async function stage() {
  const box = await page.locator('.chat-stage').boundingBox();
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  const pixels = rgb(await page.screenshot({
    style: '.chat-scroll, .composer-wrap, .chat-reading-veil, .jump-btn, dialog.settings-dialog { visibility: hidden !important } dialog.settings-dialog::backdrop { background: transparent !important }',
    clip, scale: 'css',
  }));
  return { pixels, width: clip.width, height: clip.height };
}

/** Luminancia media (0-255) por fila, de abajo arriba: describe la forma vertical del horizonte. */
function rowProfile({ pixels, width, height }, rows = 320) {
  const profile = [];
  for (let y = height - 1; y >= Math.max(0, height - rows); y--) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    }
    profile.push(Number((sum / width).toFixed(2)));
  }
  return profile;
}

/** Salto vertical máximo entre bandas de 4 filas (una frontera dura se ve como un salto). */
function maxStep(profile) {
  const bands = [];
  for (let i = 0; i + 4 <= profile.length; i += 4) bands.push(profile.slice(i, i + 4).reduce((a, b) => a + b, 0) / 4);
  let step = 0;
  let at = 0;
  for (let i = 1; i < bands.length; i++) {
    const d = Math.abs(bands[i] - bands[i - 1]);
    if (d > step) { step = d; at = i * 4; }
  }
  return { step: Number(step.toFixed(2)), rowFromBottom: at };
}

function summary(sample) {
  const profile = rowProfile(sample);
  const avg = (from, to) => Number((profile.slice(from, to).reduce((a, b) => a + b, 0) / (to - from)).toFixed(2));
  return {
    bottom0to40: avg(0, 40), rows40to120: avg(40, 120), rows120to200: avg(120, 200), rows200to240: avg(200, 240), rows240to320: avg(240, 320),
    ...maxStep(profile), profile,
  };
}

async function sendText(text) {
  await composer().fill(text);
  await composer().press('Enter');
  await poll(async () => (await composer().inputValue()) === '', 'El compositor no vació el mensaje');
}
const waitProvider = (tag) => poll(() => events().find((run) => run.type === 'start' && run.tag === tag), 'No empezó el turno local ' + tag, 20_000);
async function waitReply(convId, count) {
  return poll(async () => {
    const { messages } = await invoke('list_messages', { conversationId: convId });
    return messages.filter((message) => message.role === 'assistant' && message.status !== 'running').length >= count;
  }, 'No apareció la respuesta', 25_000);
}
const activity = () => chatField().getAttribute('data-activity');

async function seedConversations() {
  const created = await invoke('create_project', { name: stableProfile ? 'Módulo de cálculo' : 'Proyecto QA Revisión', path: project });
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

async function recordScreencast(name, action) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ sessionId, data, metadata }) => {
    frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
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
    lastFile = index.toString().padStart(5, '0') + '.jpg';
    writeFileSync(join(dir, lastFile), frame.data, 'base64');
    concat.push(`file '${lastFile}'`);
    const interval = frames[index + 1] ? frames[index + 1].time - frame.time : 0.6;
    concat.push('duration ' + Math.max(1 / 90, Math.min(1.5, interval || 1 / 24)).toFixed(4));
  }
  concat.push(`file '${lastFile}'`);
  writeFileSync(join(dir, 'frames.ffconcat'), concat.join('\n'));
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
    '-c:v', 'libx264', '-threads', '2', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, name + '.mp4')], { cwd: dir });
  (results.stats.videos ??= {})[name] = { frames: frames.length, seconds: Number((frames.at(-1).time - frames[0].time).toFixed(1)) };
  console.log('Vídeo', name, frames.length, 'fotogramas');
}

/** Atributos y geometría del campo de la conversación. */
const fieldState = () => page.evaluate(() => {
  const field = document.querySelector('.chat-stage > .background-field');
  const canvas = field?.querySelector('canvas');
  const r = (node) => node && node.getBoundingClientRect().toJSON();
  return field && {
    background: field.dataset.background, activity: field.dataset.activity, running: field.dataset.running,
    ready: field.dataset.ready, texture: field.dataset.texture, quality: field.dataset.quality ?? '0', thread: field.dataset.thread,
    opacity: getComputedStyle(field).opacity, mask: getComputedStyle(field).maskImage,
    field: r(field), stage: r(field.parentElement), canvas: r(canvas), canvasSize: canvas && [canvas.width, canvas.height],
    canvases: field.querySelectorAll('canvas').length, dpr: devicePixelRatio,
  };
});

/** Espera a que la opacidad del campo termine su transición (dos lecturas iguales). */
async function stableOpacity() {
  let last = '';
  await poll(async () => {
    const now = await chatField().evaluate((el) => getComputedStyle(el).opacity);
    const same = now === last;
    last = now;
    await wait(250);
    return same;
  }, 'La opacidad del campo no se estabilizó', 8000);
}

// ── escenarios ──

/** Original: forma vertical del horizonte en reposo, trabajando y esperando; comparable entre ejecutables. */
async function scenarioOriginal() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await seedConversations();
  await choosePreset('original', 'Duovra');
  await wait(1200);
  await stableOpacity();
  results.stats.originalEmpty = { state: await fieldState(), ...summary(await stage()) };
  await shot('original-vacio');
  await sendText('Revisa el cálculo. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  await composer().blur();
  await page.mouse.move(5, 5);
  await wait(2500);
  await stableOpacity();
  results.stats.originalIdle = { state: await fieldState(), ...summary(await stage()) };
  await shot('original-con-mensajes-reposo');
  await sendText('Trabaja paso a paso. [QA:MASCOT-CODEX]');
  await waitProvider('MASCOT-CODEX');
  release('MASCOT-STEP-0');
  release('MASCOT-STEP-1');
  await poll(async () => !['idle', 'done'].includes(await activity()), 'Falta el estado de ejecución');
  await wait(1600);
  await stableOpacity();
  results.stats.originalWorking = { state: await fieldState(), ...summary(await stage()) };
  await shot('original-trabajando');
  for (const step of [2, 3, 4]) release('MASCOT-STEP-' + step);
  await poll(async () => (await activity()) === 'waiting', 'Falta la espera de autorización', 15_000);
  await wait(1600);
  await stableOpacity();
  results.stats.originalWaiting = { state: await fieldState(), ...summary(await stage()) };
  await shot('original-esperando');
  await button('Aprobar').first().click();
  release('MASCOT-CODEX');
  await waitReply(ids.codex, 2);
  await wait(1500);
  await stableOpacity();
  results.stats.originalDone = { state: await fieldState(), ...summary(await stage()) };
  await shot('original-completado');
  for (const key of ['originalEmpty', 'originalIdle', 'originalWorking', 'originalWaiting', 'originalDone']) {
    const s = results.stats[key];
    console.log(key, 'opacidad', s.state?.opacity, 'abajo', s.bottom0to40, '40-120', s.rows40to120, '120-200', s.rows120to200, '200-240', s.rows200to240, '240-320', s.rows240to320, 'salto', s.step, '@', s.rowFromBottom);
  }
  pass('Original medido en reposo, trabajando, esperando y completado');
  // Regresión: con --baseline, la forma del horizonte y la opacidad por estado deben coincidir con
  // la apariencia histórica medida en el ejecutable de la integración (6e0d375).
  const baselinePath = arg('--baseline');
  if (!baselinePath) return;
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8')).stats;
  const crest = (s) => s.profile.slice(80, 128).reduce((a, b) => a + b, 0) / 48;
  const comparison = {};
  for (const key of ['originalIdle', 'originalWorking', 'originalWaiting', 'originalDone']) {
    const now = results.stats[key];
    const then = baseline[key];
    comparison[key] = {
      crest: Number(crest(now).toFixed(2)), crestHistoric: Number(crest(then).toFixed(2)),
      opacity: Number(now.state.opacity), opacityHistoric: Number(then.state.opacity),
      mask: now.state.mask !== 'none',
    };
  }
  results.stats.historicComparison = comparison;
  console.log(JSON.stringify(comparison, null, 1));
  for (const [key, c] of Object.entries(comparison)) {
    assert(c.mask, key + ': Original sin máscara de horizonte');
    assert(Math.abs(c.opacity - c.opacityHistoric) <= 0.03, `${key}: opacidad ${c.opacity} frente a ${c.opacityHistoric} histórica`);
    // El patrón se mueve: tolerancia de 2,5 niveles de luminancia media sobre la cresta.
    assert(Math.abs(c.crest - c.crestHistoric) <= 2.5, `${key}: cresta ${c.crest} frente a ${c.crestHistoric} histórica`);
  }
  pass('Original conserva la máscara, la opacidad por actividad y la intensidad histórica del horizonte');
}

// ── utilidades de la revisión ──

let cdpPage;
async function size(width, height, deviceScaleFactor) {
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width, height } } });
  cdpPage ??= await page.context().newCDPSession(page);
  if (deviceScaleFactor) {
    await cdpPage.send('Emulation.setDeviceMetricsOverride', { width: width - 1, height, deviceScaleFactor, mobile: false });
    await wait(80);
    await cdpPage.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  } else await cdpPage.send('Emulation.clearDeviceMetricsOverride');
  await wait(450);
}

async function openSettings() {
  await page.keyboard.press('Control+,');
  await dialog().waitFor();
  await poll(async () => (await dialog().getAttribute('data-state')) === 'open', 'Ajustes no se abrió');
}
async function closeSettings() {
  await page.keyboard.press('Escape');
  const confirm = page.locator('.request-dialog');
  if (await confirm.isVisible().catch(() => false)) await confirm.locator('.btn-danger').click();
  await dialog().waitFor({ state: 'detached' });
}
async function appearance() {
  await page.getByRole('tab', { name: 'Apariencia' }).click();
  await editor().waitFor();
}
const category = (name) => button(name, editor()).click();
async function applyDraft() {
  await button('Aplicar', editor()).click();
  await editor().getByRole('status').filter({ hasText: 'Fondo aplicado' }).waitFor();
}
async function choosePreset(id, group = 'Patrones') {
  await openSettings();
  await appearance();
  await category(group);
  await preset(id).click();
  if (await button('Aplicar', editor()).isEnabled()) await applyDraft();
  assert.equal((await getSettings())[stateKey]?.active?.presetId, id);
  await closeSettings();
  await poll(async () => (await chatField().getAttribute('data-ready')) === 'true', 'El fondo no se pintó');
  await wait(1000);
}

/** Registro en la página: lienzos sustituidos, campo remontado, pérdidas de data-ready. */
const installWatch = () => page.evaluate(() => {
  const log = window.__fieldWatch = { canvasAdded: 0, canvasRemoved: 0, fieldsAdded: 0, fieldsRemoved: 0, readyLost: 0, textures: [] };
  const stageEl = document.querySelector('.chat-stage');
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeName === 'CANVAS') log.canvasAdded++;
          if (n.classList?.contains('background-field')) log.fieldsAdded++;
        }
        for (const n of r.removedNodes) {
          if (n.nodeName === 'CANVAS') log.canvasRemoved++;
          if (n.classList?.contains('background-field')) log.fieldsRemoved++;
        }
      } else if (r.attributeName === 'data-ready' && r.target.classList.contains('background-field') && r.target.dataset.ready !== 'true') log.readyLost++;
      else if (r.attributeName === 'data-texture') log.textures.push(r.target.dataset.texture);
    }
  }).observe(stageEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ready', 'data-texture'] });
});
const readWatch = () => page.evaluate(() => window.__fieldWatch);

/**
 * Luminancia media por fotograma de un vídeo en una región (fracciones del fotograma). Sirve para
 * detectar parpadeos, fotogramas vacíos y saltos de intensidad en zonas sin texto.
 */
function frameLuma(video, region) {
  const [fx, fy, fw, fh] = region;
  const raw = ffmpeg(['-i', video, '-vf', `crop=iw*${fw}:ih*${fh}:iw*${fx}:ih*${fy},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  return [...raw];
}
function lumaStats(values) {
  let jump = 0;
  for (let i = 1; i < values.length; i++) jump = Math.max(jump, Math.abs(values[i] - values[i - 1]));
  return { frames: values.length, min: Math.min(...values), max: Math.max(...values), maxFrameJump: jump };
}

async function workerTargets() {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'worker' && target.url.includes('field.worker')).length;
  } finally { await cdp.detach(); }
}

async function setPattern(presetId, pattern) {
  const current = (await getSettings())[stateKey];
  await setting(stateKey, { ...current, active: { presetId, config: { kind: 'pattern', pattern } } });
  await page.reload();
  await composer().waitFor();
  await poll(async () => (await chatField().getAttribute('data-ready')) === 'true', 'El patrón no se pintó');
  await wait(1000);
}

// ── continuidad con animación ──

async function scenarioContinuity() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await seedConversations();
  await poll(async () => (await chatField().getAttribute('data-ready')) === 'true', 'Original no se pintó');
  await installWatch();
  const timeline = [];
  const mark = async (text) => timeline.push({ t: Date.now(), text, activity: await activity(), running: await chatField().getAttribute('data-running'), opacity: await chatField().evaluate((el) => getComputedStyle(el).opacity) });
  await recordScreencast('continuidad-original', async () => {
    await mark('conversación recién creada');
    await wait(2500);
    await sendText('Trabaja paso a paso y pide permiso antes de ejecutar. [QA:MASCOT-CODEX]');
    await waitProvider('MASCOT-CODEX');
    await mark('primer mensaje enviado');
    await wait(900);
    for (const [step, text] of [[0, 'inicio del turno (razonamiento)'], [1, 'lectura de archivos'], [2, 'edición'], [3, 'ejecución de comandos'], [4, 'espera de autorización']]) {
      release('MASCOT-STEP-' + step);
      await wait(300);
      await mark(text);
      await wait(1700);
    }
    await poll(async () => (await activity()) === 'waiting', 'Falta la espera de autorización', 15_000);
    await wait(1500);
    await button('Aprobar').first().click();
    await wait(300);
    await mark('autorización concedida, ejecución');
    await wait(1700);
    release('MASCOT-CODEX');
    await waitReply(ids.codex, 1);
    await mark('finalización');
    await wait(2500);
    await mark('retorno al reposo');
    await wait(2500);
    // Cambio de agente: la conversación de Claude Code trabaja con su paleta cálida.
    await page.locator('.tree-conv', { hasText: 'Documentación con Claude Code' }).click();
    await composer().waitFor();
    await wait(1200);
    await mark('conversación de Claude Code');
    await page.getByRole('button', { name: /^Agente para el próximo mensaje/ }).click();
    await page.getByRole('menuitemradio', { name: /Claude Code/ }).click();
    await sendText('Escribe un resumen breve. [QA:HOLD-CLAUDE-REVIEW]');
    await waitProvider('HOLD-CLAUDE-REVIEW');
    await wait(300);
    await mark('Claude Code trabajando');
    await wait(2500);
    release('HOLD-CLAUDE-REVIEW');
    await waitReply(ids.claude, 1);
    await mark('Claude Code completado');
    await wait(2000);
    await page.locator('.tree-conv', { hasText: 'Revisión del módulo de cálculo' }).click();
    await composer().waitFor();
    await wait(1500);
    await mark('vuelta a Codex');
    await wait(1500);
  });
  results.stats.continuityTimeline = timeline.map((entry) => ({ ...entry, t: entry.t - timeline[0].t }));
  results.stats.continuityWatch = await readWatch();
  const video = join(out, 'continuidad-original.mp4');
  // Margen izquierdo del escenario a la altura del horizonte: sin texto ni compositor.
  const box = await page.locator('.chat-stage').boundingBox();
  const vw = await page.evaluate(() => innerWidth);
  const vh = await page.evaluate(() => innerHeight);
  const region = [(box.x + 8) / vw, (box.y + box.height - 150) / vh, 120 / vw, 110 / vh];
  results.stats.continuityLuma = lumaStats(frameLuma(video, region));
  console.log('continuidad', JSON.stringify(results.stats.continuityWatch), JSON.stringify(results.stats.continuityLuma));
  for (const entry of results.stats.continuityTimeline) console.log(String(entry.t).padStart(6), entry.activity, entry.running, entry.opacity, entry.text);
  pass('Secuencia continua de Original grabada con animación (Codex y Claude Code)');
}

// ── presets intensos sobre una conversación larga ──

const INTENSE = ['vivid', 'ascii', 'halftone', 'streaks', 'mono', 'still', 'corner'];
async function scenarioPresets() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await seedConversations();
  for (let i = 1; i <= 3; i++) {
    await sendText(`Revisa el caso ${i} y documenta la solución con código y diff. [QA:ACTIVITY-HOLD-REFINEMENT]`);
    if (i === 1) await waitProvider('ACTIVITY-HOLD-REFINEMENT');
    release('ACTIVITY-HOLD-REFINEMENT');
    await waitReply(ids.codex, i);
  }
  const scroll = page.locator('.chat-scroll');
  for (const id of INTENSE) {
    await choosePreset(id);
    await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.mouse.move(1300, 300);
    const state = await fieldState();
    await shot(`preset-${id}-conversacion`);
    await scroll.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.45; });
    await shot(`preset-${id}-codigo`);
    (results.stats.presets ??= {})[id] = { texture: state.texture, opacity: state.opacity, canvases: state.canvases, quality: state.quality };
  }
  // Vivid con Workbench, compositor enfocado y agente trabajando.
  await choosePreset('vivid');
  await button('Mostrar Workbench').click();
  await composer().focus();
  await composer().fill('Texto de prueba en el compositor sobre Vivid');
  await sendText('Sigue con el siguiente caso. [QA:ACTIVITY-HOLD-REVIEW]');
  await waitProvider('ACTIVITY-HOLD-REVIEW');
  await wait(1500);
  await composer().fill('Borrador mientras el agente trabaja');
  await shot('preset-vivid-workbench-trabajando');
  release('ACTIVITY-HOLD-REVIEW');
  await waitReply(ids.codex, 4);
  await button('Ocultar Workbench').click();
  pass('Presets intensos capturados en conversación larga, código, Workbench y turno activo');
}

// ── cambios de preset rápidos ──

async function scenarioSwitching() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedConversations();
  await choosePreset('streaks');
  await installWatch();
  const workersBefore = await workerTargets();
  await openSettings();
  await appearance();
  await category('Patrones');
  const sequence = ['ascii', 'halftone', 'streaks', 'ascii', 'vivid', 'halftone', 'mono', 'still', 'corner', 'ascii', 'halftone', 'streaks'];
  const expected = { ascii: 'ascii', halftone: 'halftone', streaks: 'dither', vivid: 'dither', mono: 'dither', still: 'dither', corner: 'dither', quiet: 'dither' };
  const settled = [];
  // Cambios espaciados: cada uno debe terminar en su tratamiento, con un único lienzo.
  await recordScreencast('cambios-de-preset', async () => {
    for (const id of sequence) {
      await preset(id).click();
      await wait(650);
      settled.push({ id, texture: await chatField().getAttribute('data-texture'), canvases: await chatField().locator('canvas').count() });
    }
    // Ráfaga: cinco cambios sin esperar; el resultado final es la última selección.
    for (const id of ['halftone', 'ascii', 'streaks', 'halftone', 'ascii']) await preset(id).click({ delay: 0 });
    await wait(1500);
  });
  const finalTexture = await chatField().getAttribute('data-texture');
  results.stats.switching = { settled, finalTexture, watch: await readWatch(), workersBefore, workersAfter: await workerTargets(), field: await fieldState() };
  // El diálogo cubre el centro: se mide el margen izquierdo del escenario.
  const video = join(out, 'cambios-de-preset.mp4');
  const box = await page.locator('.chat-stage').boundingBox();
  const vw = await page.evaluate(() => innerWidth);
  const vh = await page.evaluate(() => innerHeight);
  results.stats.switchingLuma = lumaStats(frameLuma(video, [(box.x + 6) / vw, (box.y + 40) / vh, 60 / vw, (box.height - 80) / vh]));
  console.log(JSON.stringify(results.stats.switching, null, 1), JSON.stringify(results.stats.switchingLuma));
  const wrong = settled.filter((item) => item.texture !== expected[item.id] || item.canvases !== 1);
  if (wrong.length) note('Cambio de preset con tratamiento o lienzos incorrectos: ' + JSON.stringify(wrong));
  else pass('Cada cambio espaciado termina en su tratamiento con un único lienzo');
  if (finalTexture !== 'ascii') note('La ráfaga terminó en ' + finalTexture + ' en lugar de la última selección (ascii)');
  else pass('Tras una ráfaga de cambios el fondo corresponde a la última selección');
  // Tratamiento desde Ajustes avanzados sobre el mismo patrón.
  await preset('vivid').click();
  await editor().getByText('Ajustes avanzados', { exact: true }).first().click();
  const texture = editor().getByRole('combobox', { name: 'Tratamiento', exact: true });
  const options = { Dither: 'dither', ASCII: 'ascii', Halftone: 'halftone', Soft: 'soft' };
  const treatment = [];
  for (const name of ['ASCII', 'Halftone', 'Soft', 'Dither', 'ASCII', 'Soft']) {
    await texture.click();
    await page.getByRole('option', { name, exact: true }).click();
    await wait(600);
    treatment.push({ name, texture: await chatField().getAttribute('data-texture'), canvases: await chatField().locator('canvas').count() });
  }
  results.stats.treatment = treatment;
  const badTreatment = treatment.filter((item) => item.texture !== options[item.name] || item.canvases !== 1);
  if (badTreatment.length) note('Tratamiento incorrecto tras cambiarlo: ' + JSON.stringify(badTreatment));
  else pass('Dither, ASCII, Halftone y Soft alternan sobre el mismo lienzo');
  await closeSettings();
  results.stats.workersAfterClose = await workerTargets();
}

// ── cobertura, resolución y escalado ──

async function scenarioCoverage() {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedConversations();
  const sizes = [[1440, 900], [1366, 768], [960, 800], [820, 700]];
  const scales = [1, 1.1, 1.25, 1.5];
  const configs = {
    ascii: { pattern: 'streaks', style: 'ascii', amount: 38, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 78, speed: 26, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true },
    halftone: { pattern: 'aurora', style: 'halftone', amount: 42, focus: { x: 0.61, y: 0.19 }, reach: 82, detail: 83, speed: 25, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true },
    dither: { pattern: 'streaks', style: 'dither', amount: 51, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 86, speed: 44, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true },
    soft: { pattern: 'aurora', style: 'soft', amount: 45, focus: { x: 0.72, y: 0.78 }, reach: 100, detail: 60, speed: 30, angle: 35, colour: 'agent', hue: 28, saturation: 70, react: true },
  };
  const rows = [];
  for (const [name, pattern] of Object.entries(configs)) {
    await setPattern(name, pattern);
    for (const [w, h] of sizes) for (const dpr of scales) for (const workbench of [false, true]) {
      await size(w, h, dpr);
      if (workbench) await button('Mostrar Workbench').click();
      await wait(350);
      const s = await fieldState();
      const gapRight = Number((s.field.right - s.canvas.right).toFixed(2));
      const gapBottom = Number((s.field.bottom - s.canvas.bottom).toFixed(2));
      const covers = s.canvas.left <= s.field.left + 0.01 && s.canvas.top <= s.field.top + 0.01 && gapRight <= 0.03 && gapBottom <= 0.03;
      const fills = Math.abs(s.field.width - s.stage.width) < 0.05 && Math.abs(s.field.height - s.stage.height) < 0.05;
      rows.push({ texture: name, size: `${w}x${h}`, dpr, workbench, covers, fills, gapRight, gapBottom, canvasSize: s.canvasSize, quality: s.quality });
      if (dpr === 1.25 && w === 1366 && workbench) await shot(`cobertura-${name}-1366-125-workbench`, { scale: 'css' });
      if (dpr === 1.1 && w === 820) await shot(`cobertura-${name}-820-110${workbench ? '-workbench' : ''}`, { scale: 'css' });
      if (workbench) await button('Ocultar Workbench').click({ timeout: 1500 }).catch(() => page.keyboard.press('Escape'));
      await page.locator('#workbench').waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
    }
  }
  await size(1440, 900);
  results.stats.coverage = rows;
  const failed = rows.filter((row) => !row.covers || !row.fills);
  if (failed.length) note('Cobertura incompleta en ' + failed.length + ' casos: ' + JSON.stringify(failed.slice(0, 8)));
  else pass(`Cobertura completa en ${rows.length} combinaciones de tratamiento, tamaño, escala y Workbench`);
  // Original también cubre su horizonte con cambios de escala.
  await setting(stateKey, { active: { presetId: 'original', config: { kind: 'original' } }, presets: [] });
  await page.reload();
  await composer().waitFor();
  const originalRows = [];
  for (const [w, h] of sizes) for (const dpr of scales) {
    await size(w, h, dpr);
    const s = await fieldState();
    originalRows.push({ size: `${w}x${h}`, dpr, covers: s.canvas.right >= s.field.right - 0.03 && s.canvas.bottom >= s.field.bottom - 0.03 });
  }
  await size(1440, 900);
  results.stats.coverageOriginal = originalRows;
  if (originalRows.every((row) => row.covers)) pass('Original cubre el escenario en todos los tamaños y escalas');
  else note('Original sin cubrir: ' + JSON.stringify(originalRows.filter((row) => !row.covers)));
}

// ── Ajustes: estado de la conversación y vista previa ──

async function scenarioSettings() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await seedConversations();
  if (await chatField().getAttribute('data-background') !== 'original') await choosePreset('original', 'Recomendados');
  for (let i = 1; i <= 3; i++) {
    await sendText(`Caso ${i} con código. [QA:ACTIVITY-HOLD-REFINEMENT]`);
    if (i === 1) await waitProvider('ACTIVITY-HOLD-REFINEMENT');
    release('ACTIVITY-HOLD-REFINEMENT');
    await waitReply(ids.codex, i);
  }
  await button('Mostrar Workbench').click();
  const scroll = page.locator('.chat-scroll');
  await scroll.evaluate((el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.4); });
  await sendText('Turno largo. [QA:HOLD-REVIEW-SETTINGS]');
  await waitProvider('HOLD-REVIEW-SETTINGS');
  await sendText('Encargo en cola. [QA:QUEUE-REVIEW-SETTINGS]');
  await page.locator('.queue-next').waitFor();
  await composer().fill('Borrador que debe sobrevivir a Ajustes');
  await scroll.evaluate((el) => { el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.4); });
  const before = await page.evaluate(() => ({
    scroll: document.querySelector('.chat-scroll').scrollTop,
    workbench: !!document.querySelector('.workbench, [data-workbench]'),
    queue: document.querySelectorAll('.queue-next').length,
  }));
  const fieldNode = await chatField().evaluateHandle((el) => el);
  const settingsBefore = JSON.stringify((await getSettings())[stateKey]);
  await openSettings();
  await appearance();
  await category('Patrones');
  await preset('vivid').click();
  await poll(async () => (await chatField().getAttribute('data-background')) === 'pattern', 'La vista previa no llegó a la conversación');
  // Vista previa por teclado.
  const trigger = button('Ver en la conversación', editor());
  await trigger.focus();
  await page.keyboard.press('Enter');
  const exit = button('Volver a Ajustes');
  await exit.waitFor();
  const peekFocus = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await wait(1500);
  const running = await chatField().getAttribute('data-running');
  await shot('ajustes-vista-previa');
  await page.keyboard.press('Escape');
  await editor().waitFor();
  const backFocus = await page.evaluate(() => document.activeElement?.textContent?.trim());
  const stillDraft = await chatField().getAttribute('data-background');
  const savedDuringPreview = JSON.stringify((await getSettings())[stateKey]);
  // Clic fuera durante la vista previa vuelve al editor sin cerrar.
  await trigger.click();
  await exit.waitFor();
  await page.mouse.click(300, 500);
  await editor().waitFor();
  const dialogOpen = await dialog().getAttribute('data-state');
  await shot('ajustes-superpuestos-turno-activo');
  await closeSettings();
  const after = await page.evaluate(() => ({
    scroll: document.querySelector('.chat-scroll').scrollTop,
    workbench: !!document.querySelector('.workbench, [data-workbench]'),
    queue: document.querySelectorAll('.queue-next').length,
  }));
  const sameField = await fieldNode.evaluate((el) => el.isConnected);
  const draft = await composer().inputValue();
  const background = await chatField().getAttribute('data-background');
  release('HOLD-REVIEW-SETTINGS');
  await waitReply(ids.codex, 4);
  release('QUEUE-REVIEW-SETTINGS');
  results.stats.settings = { before, after, peekFocus, backFocus, running, stillDraft, dialogOpen, sameField, draft, background,
    previewSaved: savedDuringPreview !== settingsBefore };
  console.log(JSON.stringify(results.stats.settings));
  assert.equal(after.scroll, before.scroll, 'Ajustes cambió el desplazamiento de la conversación');
  assert.equal(draft, 'Borrador que debe sobrevivir a Ajustes', 'Se perdió el borrador');
  assert.equal(after.queue, before.queue, 'La cola cambió al abrir Ajustes');
  assert.equal(peekFocus, 'Volver a Ajustes', 'El foco no fue a «Volver a Ajustes»');
  assert.equal(stillDraft, 'pattern', 'La vista previa perdió el borrador');
  assert.equal(savedDuringPreview, settingsBefore, 'La vista previa escribió en SQLite');
  assert.equal(dialogOpen, 'open', 'Un clic fuera durante la vista previa cerró Ajustes');
  assert.equal(background, 'original', 'Cerrar descartando no restauró el fondo guardado');
  pass('Ajustes conserva desplazamiento, borrador, cola, ejecución y Workbench; la vista previa funciona con teclado y no guarda nada');
}

async function scenarioReadme() {
  assert(stableProfile, 'Las capturas públicas requieren el ejecutable estable y su perfil desechable');
  const { codex } = await seedConversations();
  const history = [
    ['user', null, null, null, 'Añade una validación para los importes antes de restarlos.'],
    ['assistant', 'codex', 'gpt-6-luna', 'high', 'La función comprueba que ambos importes sean finitos. Añadí casos para importes negativos, cero y entradas no válidas.'],
    ['user', null, null, null, 'Revisa el cambio y dime si afecta a las llamadas existentes.'],
    ['assistant', 'claude', 'claude-haiku-5-5', 'medium', 'La firma de `resta(a, b)` se mantiene. El único cambio observable es que las entradas no válidas ahora se rechazan con un mensaje explícito.'],
  ];
  const db = new DatabaseSync(join(dbDir, 'studio.sqlite3'));
  try {
    const insert = db.prepare('INSERT INTO messages (id, conversation_id, seq, role, agent, model, effort, content, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    for (const [index, entry] of history.entries()) {
      insert.run(randomUUID(), codex, index + 1, ...entry, now - (history.length - index) * 1000, now);
    }
  } finally {
    db.close();
  }
  await page.reload();
  await page.getByText('Revisa el cambio y dime si afecta a las llamadas existentes.').waitFor();
  await choosePreset('vivid');
  await shot('readme-conversation', { scale: 'css' });
  await openSettings();
  await appearance();
  await category('Patrones');
  await shot('readme-appearance', { scale: 'css' });
  await closeSettings();
  pass('Capturas del ejecutable estable con conversación ficticia y presets de patrones');
}

// ── compositor ──

async function scenarioComposer() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedConversations();
  await choosePreset('vivid');
  const hits = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.composer button, .composer [role="button"], .composer textarea')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push({ name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName, ok: !!hit && (hit === el || el.contains(hit)), hit: hit?.className?.toString().slice(0, 40) });
    }
    return out;
  });
  results.stats.composerHits = hits;
  const blocked = hits.filter((item) => !item.ok);
  if (blocked.length) note('Controles del compositor tapados: ' + JSON.stringify(blocked));
  else pass(`Los ${hits.length} controles del compositor reciben el clic en su centro`);
  // Foco por teclado visible en los botones del compositor.
  await composer().focus();
  await page.keyboard.press('Shift+Tab');
  const focusStyles = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    focusStyles.push(await page.evaluate(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      const composer = el.closest('.composer');
      const outlineVisible = (style) => style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      return { name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 24) || el.tagName, inComposer: !!el.closest('.composer'),
        outline: outlineVisible(s) || (el.matches('textarea') && composer && outlineVisible(getComputedStyle(composer))),
        shadow: s.boxShadow !== 'none' };
    }));
  }
  results.stats.composerFocus = focusStyles;
  const invisible = focusStyles.filter((item) => item.inComposer && item.name !== 'TEXTAREA' && !item.outline && !item.shadow);
  if (invisible.length) note('Foco sin indicador visible: ' + JSON.stringify(invisible));
  else pass('El foco por teclado es visible en los controles del compositor');
  // Placeholder y texto.
  results.stats.composerText = await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea');
    return { color: getComputedStyle(ta).color, placeholder: getComputedStyle(ta, '::placeholder').color, backdrop: getComputedStyle(document.querySelector('.composer')).backdropFilter };
  });
  // Menús dentro de la ventana y por encima del cristal.
  const menus = [];
  for (const name of [/^Agente para el próximo mensaje/, /^Modelo/, /^Esfuerzo/]) {
    const trigger = page.getByRole('button', { name }).first();
    if (!(await trigger.count())) { menus.push({ name: String(name), missing: true }); continue; }
    await trigger.click();
    await wait(250);
    const menu = await page.evaluate(() => {
      const pop = [...document.querySelectorAll('.popover, [role="menu"], [role="listbox"]')].filter((el) => el.getBoundingClientRect().height > 0).at(-1);
      if (!pop) return null;
      const r = pop.getBoundingClientRect();
      const items = [...pop.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], button')].slice(0, 4);
      const topHit = items.every((item) => {
        const b = item.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return hit && (hit === item || item.contains(hit));
      });
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, topHit, items: items.length };
    });
    menus.push({ name: String(name), ...menu });
    await shot('compositor-menu-' + menus.length);
    await page.keyboard.press('Escape');
    await wait(200);
  }
  results.stats.composerMenus = menus;
  const badMenus = menus.filter((menu) => !menu.missing && (!menu.inside || !menu.topHit));
  if (badMenus.length) note('Menús recortados o tapados: ' + JSON.stringify(badMenus));
  else pass('Menús de agente, modelo y esfuerzo dentro de la ventana y por encima del cristal');
  await composer().fill('Primera línea\nSegunda línea\nTercera línea del borrador multilínea');
  await composer().focus();
  await shot('compositor-foco-multilinea');
  console.log(JSON.stringify({ hits: results.stats.composerHits.length, focus: focusStyles, text: results.stats.composerText, menus }));
}

// ── recursos ──

async function scenarioResources() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedConversations();
  await choosePreset('vivid');
  const report = { workersStart: await workerTargets() };
  await openSettings();
  await appearance();
  await category('Patrones');
  report.workersGallery = await workerTargets();
  report.usersGallery = await page.evaluate(() => document.querySelectorAll('.background-field').length);
  for (const id of ['ascii', 'halftone', 'streaks', 'vivid', 'ascii', 'mono']) { await preset(id).click(); await wait(200); }
  await closeSettings();
  await wait(11_500);
  report.workersAfterClose = await workerTargets();
  report.fieldsAfterClose = await page.evaluate(() => document.querySelectorAll('.background-field').length);
  report.canvases = await chatField().locator('canvas').count();
  const running = (expected) => poll(async () => (await chatField().getAttribute('data-running')) === expected, 'Movimiento esperado: ' + expected, 8000);
  await running('true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await running('false');
  report.reducedPaused = true;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await running('true');
  // Ajustes abierto sin cambios: el fondo de detrás queda quieto.
  await openSettings();
  await appearance();
  await wait(4500);
  report.settingsRunning = await chatField().getAttribute('data-running');
  await closeSettings();
  await running('true');
  await invoke('plugin:window|minimize', { label: 'main' });
  await running('false');
  report.minimizedPaused = true;
  // Solo la compilación de QA concede los comandos para restaurar y enfocar la ventana.
  if (!stableProfile) {
    await invoke('plugin:window|unminimize', { label: 'main' });
    await invoke('plugin:window|set_focus', { label: 'main' });
    await page.bringToFront();
    await running('true');
  }
  results.stats.resources = report;
  console.log(JSON.stringify(report));
  assert(report.workersAfterClose <= 1, 'Workers duplicados');
  assert.equal(report.canvases, 1, 'Lienzos duplicados en el campo');
  pass('Un worker compartido, un lienzo por campo, pausa al minimizar y con movimiento reducido');
}

// ── foco al abrir Estadísticas (enlace desde Workbench y navegación por pestañas) ──

async function scenarioFocus() {
  const ids = await seedConversations();
  await sendText('Revisa el cálculo. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  // Navegación por flechas dentro del diálogo: el foco debe seguir en la pestaña.
  await openSettings();
  const tabs = page.locator('.settings-nav-list [role="tab"]');
  const names = await tabs.allInnerTexts();
  const target = names.findIndex((name) => name.includes('Estadísticas'));
  await tabs.first().focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < target; i++) await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'Estadísticas', exact: true }).waitFor();
  await wait(600);
  const arrowFocus = await page.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent?.trim() }));
  await closeSettings();
  // Enlace «Estadísticas de uso» desde Workbench → Actividad → Detalles: el foco va al encabezado.
  await button('Mostrar Workbench').click();
  const panel = page.locator('#workbench');
  await panel.getByRole('tab', { name: 'Actividad' }).click();
  await panel.locator('summary').filter({ hasText: /^\s*Detalles\s*$/ }).click();
  await panel.getByRole('button', { name: 'Estadísticas de uso' }).press('Enter');
  const heading = page.getByRole('heading', { name: 'Estadísticas', exact: true });
  await heading.waitFor();
  await wait(600);
  const linkFocus = await heading.evaluate((el) => el === document.activeElement);
  await closeSettings();
  results.stats.focus = { arrowFocus, linkFocus };
  console.log(JSON.stringify(results.stats.focus));
  assert.equal(arrowFocus.role, 'tab', 'La navegación por flechas perdió el foco de la pestaña al llegar a Estadísticas');
  assert(linkFocus, 'Estadísticas no recibió el foco al abrirse desde Workbench');
  pass('Estadísticas recibe el foco desde Workbench y la navegación por flechas conserva el foco de la pestaña');
}

// ── comprobación breve de recursos: CPU de WebView2 y p95 de fotogramas ──

async function sampleLoad(ms = 3500) {
  const cdp = await browser.newBrowserCDPSession();
  const snapshot = () => cdp.send('SystemInfo.getProcessInfo').then(({ processInfo }) => processInfo, () => []);
  try {
    const first = await snapshot();
    const started = Date.now();
    const gaps = await page.evaluate((duration) => new Promise((done) => {
      const list = [];
      const begin = performance.now();
      let previous;
      const frame = (now) => {
        if (previous !== undefined) list.push(now - previous);
        previous = now;
        if (now - begin < duration) requestAnimationFrame(frame); else done(list);
      };
      requestAnimationFrame(frame);
    }), ms);
    const last = await snapshot();
    const elapsed = (Date.now() - started) / 1000;
    const initial = new Map(first.map(({ id: pid, cpuTime }) => [pid, cpuTime]));
    const cpu = last.reduce((sum, { id: pid, cpuTime }) => sum + (initial.has(pid) ? cpuTime - initial.get(pid) : 0), 0);
    const sorted = [...gaps].sort((a, b) => a - b);
    return { cpu: Number((100 * cpu / elapsed).toFixed(1)), p95: Number(sorted.at(Math.floor(sorted.length * 0.95)).toFixed(1)), max: Number(sorted.at(-1).toFixed(1)) };
  } finally { await cdp.detach(); }
}

async function scenarioPerf() {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await seedConversations();
  await sendText('Revisa el cálculo. [QA:ACTIVITY-1]');
  await waitReply(ids.codex, 1);
  await composer().blur();
  await page.mouse.move(5, 5);
  await wait(3500);
  const perf = {};
  for (let round = 1; round <= 3; round++) (perf.originalIdle ??= []).push(await sampleLoad());
  perf.idleField = await fieldState();
  await sendText('Respuesta larga en streaming. [QA:HOLD-CHAT-JUMP]');
  await waitProvider('HOLD-CHAT-JUMP');
  await wait(800);
  for (let round = 1; round <= 3; round++) (perf.originalStreaming ??= []).push(await sampleLoad());
  perf.streamingField = await fieldState();
  release('HOLD-CHAT-JUMP-MORE');
  release('HOLD-CHAT-JUMP');
  await waitReply(ids.codex, 2);
  // Escritura en el compositor durante la carga: la pulsación debe reflejarse sin retraso apreciable.
  const typing = await page.evaluate(async () => {
    const ta = document.querySelector('.composer textarea');
    ta.focus();
    const delays = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      ta.value += 'a';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => r()));
      delays.push(performance.now() - t0);
    }
    return Math.max(...delays);
  });
  perf.composerMaxFrameMs = Number(typing.toFixed(1));
  const median = (rows, key) => [...rows.map((row) => row[key])].sort((a, b) => a - b)[1];
  perf.summary = Object.fromEntries(['originalIdle', 'originalStreaming'].map((k) => [k, { cpu: median(perf[k], 'cpu'), p95: median(perf[k], 'p95') }]));
  results.stats.perf = perf;
  console.log(JSON.stringify(perf.summary), 'compositor', perf.composerMaxFrameMs);
  for (const k of ['idleField', 'streamingField']) { const f = perf[k]; console.log(k, f.activity, 'running', f.running, 'q', f.quality, 'opacity', f.opacity, 'canvas', JSON.stringify(f.canvasSize), 'field', f.field.height); }
  pass('Carga breve de Original en reposo y durante streaming medida');
}

const run = {
  perf: scenarioPerf,
  focus: scenarioFocus,
  original: scenarioOriginal, continuity: scenarioContinuity, presets: scenarioPresets, switching: scenarioSwitching,
  coverage: scenarioCoverage, settings: scenarioSettings, composer: scenarioComposer, resources: scenarioResources, readme: scenarioReadme,
};

try {
  seedFixture();
  await boot();
  await invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width: 1440, height: 900 } } }).catch(() => undefined);
  await wait(400);
  for (const name of scenarios) {
    assert(run[name], 'Escenario desconocido: ' + name);
    await run[name]();
  }
  assert.deepEqual(pageErrors, [], 'Errores de página: ' + pageErrors.join(' | '));
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = String(error?.stack ?? error);
  console.error(error);
  if (page) await page.screenshot({ path: join(shots, 'fallo.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  results.pageErrors = pageErrors;
  results.finished = new Date().toISOString();
  writeFileSync(join(out, `resultado-${scenarios.join('-')}.json`), JSON.stringify(results, null, 2));
  await shutdown();
}

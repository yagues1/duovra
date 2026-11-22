// Recorre la build portable en WebView2 por CDP, con SQLite y Git de QA.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { beta } from '../personal-beta-config.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const rc1 = process.argv.includes('--rc1');
const personalBeta = process.argv.includes('--personal-beta');
assert(!(rc1 && personalBeta));
const isolated = rc1 || personalBeta;
const build = personalBeta ? beta.qa : join(root, 'output', 'qa', rc1 ? 'rc1' : 'workbench');
const out = process.env.DUOVRA_QA_OUTPUT ? resolve(process.env.DUOVRA_QA_OUTPUT) : build;
const exe = personalBeta ? beta.executable : join(build, 'app', rc1 ? 'Duovra 0.6.0 RC1 QA.exe' : 'Duovra Workbench QA.exe');
const idQA = personalBeta ? beta.identifier : rc1 ? 'dev.duovra.studio.rc1.qa' : 'dev.duovra.workbench.qa';
const profileId = randomUUID();
assert(existsSync(exe), 'Compila primero con node scripts/qa/workbench-build.mjs');
mkdirSync(out, { recursive: true });
const session = mkdtempSync(join(out, 'sesion-'));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'duovra-workbench-'));
const evidence = join(out, isolated ? 'evidencia-workbench' : 'evidencia');
mkdirSync(evidence, { recursive: true });

const listen = createServer();
await new Promise((resolve, reject) => listen.listen(0, '127.0.0.1', resolve).once('error', reject));
const port = listen.address().port;
await new Promise((resolve) => listen.close(resolve));
const endpoint = 'http://127.0.0.1:' + port;
const paths = Object.fromEntries(['codex', 'claude'].map((agent) => {
  const path = join(session, agent + '.cmd');
  const fixture = fileURLToPath(new URL('workbench-agent.mjs', import.meta.url));
  writeFileSync(path, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" ' + agent + ' %*\r\n');
  return [agent, path];
}));
// Crea solo la tabla de ajustes del identificador QA, antes de que la app detecte agentes.
// El backend crea después sus tablas y corre las migraciones normales.
assert(process.env.APPDATA, 'Falta la carpeta de datos de Windows');
const appData = join(process.env.APPDATA, idQA);
const expectedData = isolated ? join(appData, 'fixtures', profileId) : appData;
mkdirSync(expectedData, { recursive: true });
const settingsDb = new DatabaseSync(join(expectedData, 'studio.sqlite3'));
try {
  settingsDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const set = settingsDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [agent, path] of Object.entries(paths)) set.run('agents.' + agent + '.path', JSON.stringify(path));
} finally {
  settingsDb.close();
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(path|webview2_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home)$/i.test(key)) delete env[key];
}
Object.assign(env, {
  PATH: session + ';' + process.env.PATH,
  CODEX_HOME: join(session, 'codex-profile'),
  CLAUDE_CONFIG_DIR: join(session, 'claude-profile'),
  WEBVIEW2_USER_DATA_FOLDER: join(session, 'webview2'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
});
if (rc1) env.DUOVRA_RC1_TEST_PROFILE = profileId;
if (personalBeta) env[beta.profileVariable] = profileId;
const app = spawn(exe, [], { cwd: dirname(exe), env, stdio: 'ignore' });
const checks = [];
const errors = [];
const measurements = {};
let launchError;
let failure;
app.on('error', (error) => { launchError = error; });
let browser;
let page;
let dataDir;
const check = (name) => { checks.push(name); console.log('PASS', name); };
const shot = async (name) => {
  await page.screenshot({ path: join(evidence, name + '.png') });
};

async function poll(fn, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await fn()) return;
    await wait(100);
  } while (Date.now() < deadline);
  assert.fail(description);
}

const invoke = (name, data = {}) => page.evaluate(
  ([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args),
  [name, data],
);
const setting = (key, value) => invoke('set_setting', { key, value });
const getHistory = async (conversationId) => (await invoke('list_messages', { conversationId })).messages;
const put = (base, file, text) => {
  const path = join(base, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const repo = join(fixtureRoot, 'orbit');
const empty = join(fixtureRoot, 'vacio');
const external = join(fixtureRoot, 'externo');
const source = 'src/core/scheduler.ts';
const long = 'fixtures/Informe operativo con nombre muy largo para probar el acceso rapido.ts';
const large = 'fixtures/archivo-grande.txt';
const samples = Array.from({ length: 31 }, (_, i) => 'export const value' + i + ' = ' + i + ';');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' });
const git = (...args) => {
  const result = spawnSync('git', ['-C', repo, ...args], { env: gitEnv, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
};

function files() {
  mkdirSync(empty);
  put(external, 'fuera.txt', 'ARCHIVO FUERA DEL PROYECTO');
  put(repo, source, samples.join('\n') + '\n');
  put(repo, 'src/core/metrics.ts', 'export const enabled: boolean = true;\n');
  put(repo, 'src/obsoleto.ts', '// Archivado.\n');
  put(repo, 'README.md', '# Orbit\n\nRepositorio temporal de la fase 4A.\n');
  put(repo, '.gitignore', 'fixtures/\nqa-enlace/\n');
  put(repo, long, '// Ruta larga con espacios. Solo referencia en el compositor.\n');
  put(repo, large, 'línea deliberadamente extensa\n'.repeat(65_000));
  for (let n = 0; n < 72; n++) put(repo, 'fixtures/catalogo-' + n + '.ts', '// Archivo de QA\n');
  symlinkSync(external, join(repo, 'qa-enlace'), 'junction');
  git('init', '-q', '-b', 'main', '--template=');
  git('config', '--local', 'core.autocrlf', 'false');
  git('add', '--', '.');
  git('-c', 'user.name=Duovra Workbench QA', '-c', 'user.email=workbench-qa@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture inicial');
}

async function seed() {
  files();
  const seen = (await invoke('bootstrap')).projects.some((item) => item.name.startsWith('Orbit · proyecto de QA'));
  const suffix = seen ? ' · ' + basename(fixtureRoot).slice(-6) : '';
  const project = await invoke('create_project', { name: 'Orbit · proyecto de QA' + suffix, path: repo });
  const noGit = await invoke('create_project', { name: 'Proyecto vacío de QA' + suffix, path: empty });
  const primary = await invoke('create_conversation', { projectId: project.id, title: 'Plan de trabajo · Orbit' + suffix });
  const short = await invoke('create_conversation', { projectId: project.id, title: 'Conversación breve de QA' + suffix });
  await invoke('create_conversation', { projectId: noGit.id, title: 'Proyecto vacío · comprobación' + suffix });
  const globalPhrase = 'telemetría exterior' + suffix;
  const insert = (db, conversation, rows) => {
    const query = db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, agent, model, effort, content, items, status, usage, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?)",
    );
    const start = Date.now() - 36_000;
    for (const [i, row] of rows.entries()) {
      const agent = row.agent ?? 'codex';
      query.run(randomUUID(), conversation.id, i + 1, row.role, agent,
        agent === 'claude' ? 'haiku' : 'gpt-6-luna', agent === 'claude' ? 'medium' : 'high',
        row.content, JSON.stringify(row.items ?? []), JSON.stringify(row.usage ?? null), start + i, start + i + 1);
    }
  };
  const turnChange = { path: source, kind: 'update', diff: '--- a/src/core/scheduler.ts\n+++ b/src/core/scheduler.ts\n@@ -1 +1 @@\n-export const before = 0;\n+export const registradoPorElTurno = 1;\n' };
  const start = [
    { role: 'user', content: 'Revisa el scheduler y localiza el umbral orbital.' },
    {
      role: 'assistant', agent: 'claude',
      content: 'El umbral orbital queda en ' + String.fromCharCode(96) + source + ':3' + String.fromCharCode(96) + '.',
      items: [
        { id: 'qa-reasoning', kind: 'reasoning', status: 'completed', text: 'Comprobación de la lógica de planificación.' },
        { id: 'qa-command', kind: 'command', status: 'completed', command: 'npm run typecheck',
          description: 'Comprobación de tipos', output: 'Resultado: horizonte plegado. Tipos correctos.', exitCode: 0 },
        { id: 'qa-turn-file', kind: 'file_change', status: 'completed', changes: [turnChange] },
      ],
      usage: { source: 'claude', inputTokens: 95000, cachedInputTokens: 92000, outputTokens: 1550, costUsd: 0.014, durationMs: 5490 },
    },
  ];
  const longHistory = Array.from({ length: 126 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'Bloque ' + (i + 1) + '. ' + 'Revisión del flujo de trabajo y las dependencias del proyecto. '.repeat(2),
  }));
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite3'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    insert(db, primary, [...start, ...longHistory, {
      role: 'assistant', content: 'El lanzador de Orbit está listo para revisión.',
      items: [{ id: 'qa-recent-file', kind: 'file_change', status: 'completed', changes: [turnChange] }],
    }]);
    insert(db, short, [
      { role: 'user', content: 'Comprueba si hay una órbita elíptica en la documentación.' },
      { role: 'assistant', content: 'La órbita figura en el manual, en el apartado de ' + globalPhrase + '.' },
    ]);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  await setting('ui.lastProjectId', project.id);
  await setting('ui.lastConversationId', primary.id);
  await invoke('set_conversation_prefs', { conversationId: primary.id, agent: 'codex', model: 'gpt-6-luna', effort: 'high' });
  return { noGit, primary, short, globalPhrase, project };
}

async function workspace({ project, noGit }) {
  const call = (cmd, args = {}, projectId = project.id) => invoke('workspace_' + cmd, { projectId, ...args });
  const initial = await call('git_status');
  assert.equal(initial.branch, 'main');
  assert.deepEqual(initial.entries, []);
  const list = await call('list', { path: 'src' });
  assert(list.entries.some((entry) => entry.directory && entry.path === 'src/core'));
  assert.deepEqual((await call('list', { path: '' }, noGit.id)).entries, []);
  assert.equal((await call('git_status', {}, noGit.id)).repository, false);
  const doc = await call('read', { path: source });
  assert.equal(doc.relative, source);
  assert.match(doc.content, /export const value0/);
  assert.equal(await call('read', { path: source, revision: doc.revision }), null);
  assert.equal((await call('read', { path: large })).truncated, true);
  assert((await call('catalog')).entries.length >= 75);
  for (const [path, reason] of [
    ['ausente.ts', /No se pudo leer la ruta/],
    ['../externo/fuera.txt', /salto de carpeta/],
    [join(external, 'fuera.txt'), /fuera del proyecto/],
    ['qa-enlace/fuera.txt', /enlace o punto de montaje/],
    ['.git/config', /fuera del espacio/],
  ]) {
    await assert.rejects(() => call('read', { path }), reason);
  }
  check('IPC nativo: directorios, TypeScript, revisión, límite, proyecto vacío, ruta ausente y contención por ruta/junction');

  const stage = [...samples];
  stage[1] = 'export const stagedWindow = 24;';
  put(repo, source, stage.join('\n') + '\n');
  put(repo, 'src/nuevo.ts', 'export const addition = true;\n');
  git('add', '--', source, 'src/nuevo.ts');
  const unstaged = [...stage];
  unstaged[0] = 'export const maxLatencyMs: number = 80;';
  unstaged[26] = 'export const retryLimit: number = 4;';
  put(repo, source, unstaged.join('\n') + '\n');
  put(repo, 'src/[borrador].ts', 'export const freshDraft = "borrador";\n');
  unlinkSync(join(repo, 'src/obsoleto.ts'));
  const indexBefore = createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex');
  const status = await call('git_status');
  const row = (name) => status.entries.find((entry) => entry.path === name);
  assert.deepEqual([row(source).index, row(source).worktree], ['M', 'M']);
  assert.equal(row('src/nuevo.ts').index, 'A');
  assert.equal(row('src/obsoleto.ts').worktree, 'D');
  assert.equal(row('src/[borrador].ts').worktree, '?');
  const readDiff = async (path, scope) => (await call('git_diff', { path, scope })).diff;
  assert.match(await readDiff(source, 'staged'), /\+.*stagedWindow/);
  const diff = await readDiff(source, 'unstaged');
  assert.equal(diff.match(/^@@ /gm)?.length, 2);
  assert.match(diff, /\+.*retryLimit/);
  assert.match(await readDiff('src/[borrador].ts', 'untracked'), /\+.*freshDraft/);
  await assert.rejects(() => readDiff('../externo/fuera.txt', 'unstaged'));
  await assert.rejects(() => readDiff('qa-enlace/fuera.txt', 'unstaged'));
  assert.equal(createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex'), indexBefore);
  check('IPC nativo: Git limpio, ausente, staged y unstaged, altas, bajas, nombre literal con corchetes y diff de dos bloques; índice intacto');
}

async function captureVideo(action) {
  if (isolated) return action();
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    if (frames.length < 900) frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1280, maxHeight: 850, everyNthFrame: 1 });
  try {
    await action();
  } finally {
    await cdp.send('Page.stopScreencast');
    await cdp.detach();
  }
  assert(frames.length > 8, 'Faltan fotogramas de WebView2');
  const folder = join(session, 'fotogramas');
  mkdirSync(folder);
  const list = ['ffconcat version 1.0'];
  for (const [i, frame] of frames.entries()) {
    const file = String(i).padStart(4, '0') + '.jpg';
    writeFileSync(join(folder, file), frame.data, 'base64');
    const interval = frames[i + 1] ? frames[i + 1].time - frame.time : 0.8;
    const duration = Number.isFinite(interval) ? Math.max(1 / 60, Math.min(4, interval)) : 1 / 30;
    list.push("file '" + file + "'", 'duration ' + duration.toFixed(4));
  }
  list.push("file '" + String(frames.length - 1).padStart(4, '0') + ".jpg'");
  writeFileSync(join(folder, 'video.ffconcat'), list.join('\n'));
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'video.ffconcat',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    join(evidence, 'busqueda-y-paleta.mp4')], { cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

async function exercise({ noGit, primary, short, globalPhrase }) {
  const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  const panel = page.locator('#workbench');
  const scroller = page.locator('.chat-scroll');
  const search = page.getByRole('searchbox', { name: 'Buscar en la conversación', exact: true });
  const counter = page.getByRole('search', { name: 'Búsqueda de conversación' }).locator('output');
  const dialog = page.getByRole('dialog', { name: 'Paleta de comandos' });
  const palette = dialog.locator('input');
  const isFocused = (locator) => locator.evaluate((el) => document.activeElement === el);
  const workbenchTab = (name) => panel.getByRole('tab', { name, exact: true });
  const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
  const open = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor();
    await page.locator('.studio-intro').waitFor({ state: 'hidden', timeout: 10_000 });
  };
  const closePanel = () => panel.getByRole('button', { name: 'Cerrar Workbench', exact: true }).click();
  const find = async (query, count) => {
    await composer.focus();
    await page.keyboard.press('Control+f');
    await search.waitFor();
    await search.fill(query);
    await poll(async () => count.test(await counter.innerText()), 'Recuento inesperado para ' + query);
  };
  const paletteRun = async (query, name = query) => {
    await page.keyboard.press('Control+Shift+p');
    await palette.waitFor();
    await palette.fill(query);
    await dialog.getByRole('option', { name, exact: typeof name === 'string' }).waitFor();
    await palette.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
  };
  const saveDraft = async (expected) => poll(async () => (await invoke('bootstrap')).conversations
    .find((entry) => entry.id === primary.id)?.draft === expected, 'El borrador no se guardó en SQLite');

  await open();
  await page.getByRole('heading', { name: primary.title, exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  const originalTop = await scrollTop();
  await page.locator('#workbench-toggle').click();
  await panel.waitFor();
  assert.equal(await scrollTop(), originalTop);
  await workbenchTab('Archivos').click();
  const folder = (label) => panel.locator('button[aria-expanded]').filter({ has: page.getByText(label, { exact: true }) });
  const fileButton = (path) => panel.getByRole('tabpanel').locator('button').filter({ has: page.getByText(path, { exact: true }) });
  await folder('src').focus();
  await page.keyboard.press('Enter');
  assert.equal(await folder('src').getAttribute('aria-expanded'), 'true');
  await folder('core').click();
  const file = fileButton('scheduler.ts');
  await file.waitFor();
  await folder('core').press('Space');
  await file.waitFor({ state: 'hidden' });
  assert.equal(await folder('core').getAttribute('aria-expanded'), 'false');
  await folder('core').press('Space');
  await file.locator('[aria-label="Modificado"]').waitFor();
  await shot('workbench-archivos');
  await file.click();
  await panel.locator('.code-line[data-line="1"]').getByText(/maxLatencyMs/).waitFor();
  assert((await panel.locator('.code-text .hljs-keyword').count()) > 0, 'El TypeScript no tiene resaltado');
  await shot('workbench-typescript');
  await panel.getByRole('button', { name: 'Copiar ruta relativa', exact: true }).click();
  await panel.getByRole('button', { name: 'Copiar ruta relativa', exact: true }).locator('.lucide-check').waitFor();
  await panel.getByRole('tabpanel').focus();
  await page.keyboard.press('Control+f');
  assert.equal(await search.count(), 0, 'Ctrl+F del Workbench abrió la búsqueda de conversación');
  const metricsTitle = 'metrics.ts';
  await workbenchTab('Archivos').click();
  assert.equal(await folder('core').getAttribute('aria-expanded'), 'true');
  await fileButton(metricsTitle).click();
  await panel.getByText(/enabled: boolean/).waitFor();
  await workbenchTab('metrics.ts').press('ArrowLeft');
  await poll(async () => await workbenchTab('scheduler.ts').getAttribute('aria-selected') === 'true', 'No funcionó Flecha izquierda en Workbench');
  const fresh = 'export const vistaActualizada: number = 100;';
  put(repo, source, readFileSync(join(repo, source), 'utf8') + fresh + '\n');
  await panel.getByText(fresh, { exact: true }).waitFor({ timeout: 7000 });
  unlinkSync(join(repo, 'src/core', metricsTitle));
  await workbenchTab('metrics.ts').click();
  await panel.getByRole('status').filter({ hasText: /No se pudo|No se encontr/i }).waitFor();
  await workbenchTab('Archivos').click();
  await folder('fixtures').click();
  await fileButton('archivo-grande.txt').click();
  await panel.getByText('Vista limitada al primer MB del archivo.').waitFor();
  await closePanel();
  await page.locator('.file-ref').getByText(source + ':3', { exact: true }).click();
  await panel.locator('.code-line[data-line="3"][data-mark]').waitFor();
  check('Workbench: posición de lectura, árbol con teclado, badges, TS resaltado, pestañas, recarga automática, archivo grande y error, enlace del chat');

  await workbenchTab('Archivos').press('ArrowRight');
  assert.equal(await workbenchTab('Cambios').getAttribute('aria-selected'), 'true');
  await panel.getByRole('heading', { name: 'main', exact: true }).waitFor();
  const agentChanges = panel.getByRole('region', { name: 'Cambios del agente', exact: true });
  await agentChanges.getByRole('heading', { name: 'Cambios del último turno · Codex', exact: true }).waitFor();
  await agentChanges.getByRole('button', { name: new RegExp(source) }).press('Enter');
  await panel.locator('.diff-line[data-type="add"]').filter({ hasText: 'registradoPorElTurno' }).waitFor();
  await shot('workbench-diff-turno');
  await workbenchTab('Cambios').click();
  await panel.getByRole('region', { name: 'Preparados (staged)', exact: true }).waitFor();
  await panel.getByRole('region', { name: 'Sin seguimiento', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Actualizar Git', exact: true }).click();
  const unstaged = panel.getByRole('region', { name: 'Sin preparar (unstaged)', exact: true });
  await unstaged.getByRole('button', { name: /metrics[.]ts/ }).waitFor();
  await shot('workbench-git');
  await unstaged.getByRole('button', { name: new RegExp(source) }).click();
  await panel.locator('.diff-line[data-type="add"]').filter({ hasText: 'maxLatencyMs' }).waitFor();
  assert((await panel.locator('.diff-line[data-type="hunk"]').count()) >= 2);
  await shot('workbench-diff-real');
  await workbenchTab('Actividad').click();
  assert.equal(await panel.getByRole('heading', { name: 'main', exact: true }).count(), 0);
  await panel.locator('.activity-panel .changes-list').getByRole('button', { name: new RegExp(source) }).waitFor();
  await closePanel();
  check('Workbench: Cambios por teclado, diff del agente, rama y grupos Git, diff de dos bloques y vista Actividad separada');

  await composer.fill('Borrador intacto para la búsqueda');
  await saveDraft('Borrador intacto para la búsqueda');
  await scroller.evaluate((element) => { element.scrollTop = 1234; });
  await wait(100);
  const beforeSearch = await scrollTop();
  await captureVideo(async () => {
    await find('umbral orbital', /[12] de 2/);
    await wait(500);
    assert(await page.evaluate(() => CSS.highlights.get('conversation-find-current')?.size), 'Falta el resaltado de la coincidencia');
    await shot('busqueda');
    const before = await counter.innerText();
    await search.press('Enter');
    await poll(async () => (await counter.innerText()) !== before, 'Enter no cambió de coincidencia');
    await search.press('Shift+Enter');
    await poll(async () => (await counter.innerText()) === before, 'Shift+Enter no volvió a la coincidencia');
    await search.fill('horizonte plegado');
    await poll(async () => (await counter.innerText()) === '1 de 1', 'No se encontró el resultado dentro de la salida plegada');
    await scroller.getByText('Resultado: horizonte plegado. Tipos correctos.', { exact: true }).waitFor();
    await wait(650);
    await search.fill('zxy-inexistente-321');
    await poll(async () => (await counter.innerText()) === 'Sin resultados', 'El buscador no confirmó la ausencia de resultados');
    assert(await page.getByRole('button', { name: 'Coincidencia siguiente' }).isDisabled());
    await search.press('Escape');
    await search.waitFor({ state: 'hidden' });
    await poll(() => isFocused(composer), 'Esc no devolvió el foco al compositor');
    assert(Math.abs(await scrollTop() - beforeSearch) <= 4, 'Cerrar búsqueda alteró la posición de lectura');
    assert.equal(await composer.inputValue(), 'Borrador intacto para la búsqueda');

    await composer.press('Control+Shift+p');
    await palette.waitFor();
    await poll(() => isFocused(palette), 'La paleta no recibió el foco');
    const conversationsBefore = (await invoke('bootstrap')).conversations.length;
    await palette.press('Control+n');
    assert.equal((await invoke('bootstrap')).conversations.length, conversationsBefore, 'Ctrl+N se filtró fuera de la paleta');
    await palette.fill('Cerrar Workbench');
    const disabled = dialog.getByRole('option', { name: /Cerrar Workbench/ });
    await disabled.waitFor();
    assert.equal(await disabled.getAttribute('aria-disabled'), 'true');
    await palette.press('Enter');
    assert(await dialog.isVisible());
    await palette.fill('');
    await poll(async () => await dialog.getByRole('option', { disabled: false }).count() > 1,
      'Esperaba más de una acción habilitada al buscar workbench');
    const startOption = await palette.getAttribute('aria-activedescendant');
    await palette.press('ArrowDown');
    const nextOption = await palette.getAttribute('aria-activedescendant');
    assert(nextOption && nextOption !== startOption, 'Flecha abajo no cambió la opción activa');
    await palette.press('ArrowUp');
    assert.equal(await palette.getAttribute('aria-activedescendant'), startOption);
    await shot('paleta');
    await wait(800);
    await palette.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await poll(() => isFocused(composer), 'Esc no restauró el foco de la paleta');

    await paletteRun(globalPhrase, /En mensajes/);
    await page.getByRole('heading', { name: short.title, exact: true }).waitFor();
    await search.waitFor();
    assert.equal(await search.inputValue(), globalPhrase);
    await search.fill('órbita');
    await poll(async () => /[12] de 2/.test(await counter.innerText()), 'No se encontraron dos coincidencias en conversación breve');
    await wait(650);
    await search.press('Escape');
  });
  check('Búsqueda: hilo corto y largo, palabra y frase, anterior/siguiente, resaltado, acordeones, sin resultados y restauración de scroll/foco');
  check('Paleta: apertura y cierre por teclado, navegación, acción deshabilitada, conflicto con Ctrl+N y búsqueda SQLite por contenido');

  await paletteRun(primary.title, new RegExp(primary.title));
  await page.getByRole('heading', { name: primary.title, exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'Borrador intacto para la búsqueda');
  await find('horizonte plegado', /1 de 1/);
  await page.locator('.find-step').filter({ hasText: 'horizonte plegado' }).locator('.step-open').click();
  await panel.locator('.term-out').filter({ hasText: 'Resultado: horizonte plegado. Tipos correctos.' }).waitFor();
  const commandBackground = await panel.locator('.term-out').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(!/255,\s*0,\s*255/.test(commandBackground), 'El comando de prueba tiene fondo fucsia');
  await shot('workbench-comando');
  await closePanel();
  await search.press('Escape');

  if (isolated) {
    await page.evaluate(() => {
      const fetchNative = window.fetch;
      const catalog = window.__TAURI_INTERNALS__.convertFileSrc('workspace_catalog', 'ipc');
      window.fetch = async function (url, ...args) {
        if (url === catalog) {
          await new Promise((done) => { window.releaseQaCatalog = done; });
          window.fetch = fetchNative;
        }
        return fetchNative.call(this, url, ...args);
      };
    });
    const before = (await getHistory(primary.id)).length;
    await composer.fill('Revisa @catalogo');
    await page.getByText('Buscando archivos…', { exact: true }).waitFor();
    await page.waitForFunction(() => typeof window.releaseQaCatalog === 'function');
    await composer.press('Enter');
    assert.equal(await composer.inputValue(), 'Revisa @catalogo');
    assert.equal((await getHistory(primary.id)).length, before);
    await page.evaluate(() => window.releaseQaCatalog());
    check('Enter conserva el borrador mientras el catálogo de referencias @ está pendiente');
  }
  await composer.fill('@catalogo');
  const suggestions = page.getByRole('listbox', { name: 'Sugerencias de archivos' });
  await suggestions.waitFor();
  await poll(async () => await suggestions.getByRole('option').count() >= 8, 'No se mostraron resultados numerosos de @');
  await composer.fill('@src/core/');
  await suggestions.getByRole('option', { name: /scheduler[.]ts/ }).waitFor();
  await composer.press('Escape');
  await suggestions.waitFor({ state: 'hidden' });
  await composer.fill('Revisa @Informe');
  const mention = suggestions.getByRole('option', { name: /Informe operativo con nombre muy largo/ });
  await mention.waitFor();
  await shot('compositor-mencion');
  await composer.press('ArrowDown');
  await composer.press('Enter');
  assert.equal(await suggestions.count(), 0);
  const draft = await composer.inputValue();
  assert.match(draft, /Informe operativo con nombre muy largo/);
  await saveDraft(draft);
  await shot('compositor-referencia-insertada');
  const messages = (await getHistory(primary.id)).length;
  await composer.fill('/git');
  await page.getByRole('listbox', { name: 'Comandos locales' }).getByRole('option', { name: /git/i }).waitFor();
  await shot('compositor-accion');
  await composer.press('Enter');
  await panel.getByRole('heading', { name: 'main', exact: true }).waitFor();
  assert.equal((await getHistory(primary.id)).length, messages, 'Un comando / local se envió al agente');
  await closePanel();
  await composer.fill(draft);
  await paletteRun('Cambiar a Claude Code');
  await poll(async () => (await page.locator('.agent-btn').getAttribute('aria-label')).includes('Claude Code'),
    'Cambiar a Claude Code no aplicó la preferencia');
  assert.equal(await composer.inputValue(), draft, 'Cambiar de proveedor alteró el borrador');
  await saveDraft(draft);
  await open();
  await poll(async () => await composer.inputValue() === draft, 'El borrador no sobrevivió a recargar el WebView');
  assert.match(await page.locator('.agent-btn').getAttribute('aria-label'), /Claude Code/);
  check('Compositor: @ con muchos resultados, selección por teclado de una ruta larga, /git local, agente y borrador tras recarga');

  await paletteRun(noGit.name, new RegExp(noGit.name));
  await page.locator('#workbench-toggle').click();
  await workbenchTab('Archivos').click();
  await panel.getByText('Carpeta vacía.').waitFor();
  await workbenchTab('Cambios').click();
  await panel.getByText('La carpeta no pertenece a un repositorio Git.').waitFor();
  await closePanel();
  check('Cambio de proyecto y navegación en carpeta vacía sin repositorio Git');

  await paletteRun(primary.title, new RegExp(primary.title));
  await page.getByRole('heading', { name: primary.title, exact: true }).waitFor();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 850, height: Math.max(viewport.height, 650) });
  const toggle = page.locator('#workbench-toggle');
  await toggle.click();
  await page.locator('#workbench[open]').waitFor();
  await paletteRun('Cerrar Workbench');
  await panel.waitFor({ state: 'hidden' });
  await poll(() => isFocused(toggle), 'La paleta no devolvió el foco al control de Workbench estrecho');
  await page.setViewportSize(viewport);
  check('Paleta y restauración del foco con Workbench modal a 850 px');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.intensity === 'reduced');
  await paletteRun('Cambiar a Codex');
  await find('umbral orbital', /[12] de 2/);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reading = await scrollTop();
  const send = (text) => invoke('send_message', { request: { conversationId: primary.id, agent: 'codex',
    model: 'gpt-6-luna', effort: 'high', text, attachments: [] } });
  await assert.rejects(() => send('Intenta abrir @"../externo/fuera.txt"'));
  assert.equal((await getHistory(primary.id)).length, messages, 'Una referencia rechazada alteró el historial');
  const prompt = 'Comprueba el streaming de QA con @' + JSON.stringify(long);
  await composer.fill(prompt);
  await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
  let userMessage;
  await poll(async () => {
    userMessage = (await getHistory(primary.id)).find((entry) => entry.role === 'user' && entry.content === prompt);
    return !!userMessage;
  }, 'El envío desde el compositor no se guardó en SQLite');
  assert.equal(userMessage.attachments[0].path, long);
  assert.equal(userMessage.attachments[0].image, false);
  assert.equal(userMessage.attachments[0].projectReference, true);
  check('El envío nativo valida la mención, bloquea el escape de raíz y guarda la referencia relativa sin contenido adjunto');
  await page.locator('.chat-scroll').getByText('Fragmento de streaming local 2.', { exact: true }).waitFor();
  await wait(800);
  assert(Math.abs(await scrollTop() - reading) <= 4, 'Los fragmentos nuevos arrastraron el resultado fuera de la vista');
  await search.fill('streaming local 5');
  await poll(async () => /^[1-9] de [1-9]/.test(await counter.innerText()), 'La búsqueda no indexó el streaming local', 6500);
  await search.press('Escape');
  await search.waitFor({ state: 'hidden' });
  await poll(async () => (await getHistory(primary.id)).some((entry) =>
    entry.role === 'assistant' && entry.seq === userMessage.seq + 1 && entry.status === 'done'),
  'El turno del fixture local no terminó', 12_000);
  await shot('movimiento-reducido');
  check('WebView2 con prefers-reduced-motion: teclado, lectura estable durante streaming e indexación de deltas del fixture local');
  await page.getByRole('button', { name: 'Abrir ' + basename(long) + ' en Workbench', exact: true }).click();
  await workbenchTab(basename(long)).waitFor();
  await shot('compositor-referencia-abierta');
  check('La referencia persistida se vuelve a abrir desde el chat en Workbench');
}

async function checkRuntime(primary) {
  const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  const field = page.locator('[data-activity][aria-hidden="true"]');
  const toggle = page.locator('#workbench-toggle');
  const panel = page.locator('#workbench');
  const cdp = await page.context().newCDPSession(page);
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    const { nodes, jsEventListeners } = await cdp.send('Memory.getDOMCounters');
    return { usedSize, nodes, jsEventListeners };
  };
  try {
    if (await panel.isVisible()) await toggle.click();
    await panel.waitFor({ state: 'hidden' });
    measurements.beforeWorkbenchCycles = await sample();
    for (let n = 0; n < 5; n++) {
      await toggle.click();
      await panel.waitFor();
      await toggle.click();
      await panel.waitFor({ state: 'hidden' });
    }
    measurements.afterWorkbenchCycles = await sample();
  } finally { await cdp.detach(); }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await toggle.click();
  const selected = panel.getByRole('tab', { selected: true });
  await selected.waitFor();
  await composer.focus();
  assert.equal(await selected.evaluate((node) => getComputedStyle(node).outlineStyle), 'solid');
  await toggle.click();
  check('Workbench conserva un indicador de selección en colores forzados y supera cinco ciclos de montaje');

  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
  await setting('appearance.intensity', 'balanced');
  await setting('appearance.backdrop', 'enabled');
  await setting('appearance.background', true);
  await setting('appearance.ambient', 'off');
  await setting('ui.lastConversationId', primary.id);
  await page.reload();
  await composer.waitFor();
  await composer.focus();
  await field.locator('canvas').waitFor();
  await poll(async () => await field.getAttribute('data-ready') === 'true', 'campo de luz no dibujó el primer fotograma');
  assert.equal(await field.getAttribute('data-thread'), 'worker');
  assert.equal(await field.getAttribute('data-running'), 'false');
  await setting('appearance.ambient', 'normal');
  await page.reload();
  await composer.waitFor();
  await composer.focus();
  await poll(async () => await field.getAttribute('data-ready') === 'true' && await field.getAttribute('data-running') === 'true'
    && await field.getAttribute('data-activity') === 'idle',
    'campo de luz no derivó en reposo con movimiento ambiental');
  await setting('appearance.ambient', 'off');
  await page.reload();
  await composer.waitFor();
  await composer.focus();
  await poll(async () => await field.getAttribute('data-ready') === 'true' && await field.getAttribute('data-running') === 'false',
    'El movimiento ambiental siguió activo tras desactivarlo');
  const lookup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Id ' + app.pid + ').MainWindowHandle.ToInt64()'],
  { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  const hwnd = lookup.stdout?.trim();
  assert(lookup.status === 0 && /^[1-9]\d*$/.test(hwnd), 'No se encontró la ventana QA antes de minimizar');
  await composer.fill('Fixture de streaming largo para observar el campo de luz');
  await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
  await poll(async () => await field.getAttribute('data-running') === 'true'
    && await field.getAttribute('data-activity') !== 'idle', 'El campo no reaccionó al turno con el ambiente apagado');
  await page.locator('.stage-mascot[data-agent="codex"] svg.mascot').first().waitFor();
  await invoke('plugin:window|minimize', { label: 'main' });
  try {
    assert(await invoke('plugin:window|is_minimized', { label: 'main' }));
    await poll(async () => await field.getAttribute('data-running') === 'false', 'campo de luz siguió animando minimizado');
  } finally {
    // Restaurar solo la ventana del proceso que inició este arnés.
    const ps = 'Add-Type -Name QaWindow -Namespace Duovra -MemberDefinition ' +
      '\'[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);\'; ' +
      'if (-not [Duovra.QaWindow]::ShowWindowAsync([IntPtr]' + hwnd + ', 9)) { exit 1 }';
    const restore = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 });
    assert.equal(restore.status, 0, restore.stderr?.toString());
  }
  await poll(async () => !await invoke('plugin:window|is_minimized', { label: 'main' }), 'No se restauró la ventana');
  await poll(async () => (await getHistory(primary.id)).at(-1)?.status === 'done', 'El turno local no terminó');
  await page.locator('.turn[data-agent="codex"][data-status="done"] .turn-gutter svg.mascot').last().waitFor();
  check('La mascota de Codex aparece durante el streaming y en el turno terminado');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await poll(async () => await field.getAttribute('data-running') === 'false', 'El fondo se mueve con reduce');
  await page.addInitScript(() => {
    window.Worker = class { constructor() { throw new Error('Worker desactivado por el fixture'); } };
  });
  await page.reload();
  await poll(async () => await field.getAttribute('data-thread') === 'main' && await field.getAttribute('data-ready') === 'true',
    'El fondo no recuperó la imagen mediante fallback');
  check('campo de luz en WebView2: worker, reposo quieto y con deriva ambiental, actividad, minimización, restauración, movimiento reducido y fallback');
}

try {
  await poll(async () => {
    if (launchError) throw launchError;
    assert.equal(app.exitCode, null, 'La ventana QA se cerró al iniciar');
    try { return (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }, 'No se abrió el puerto CDP de WebView2', 25_000);
  browser = await chromium.connectOverCDP(endpoint);
  await poll(() => {
    page = browser.contexts()[0]?.pages().find((tab) => tab.url().includes('tauri.localhost'));
    return page;
  }, 'No se encontró el WebView2 de Tauri');
  page.setDefaultTimeout(5_000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
  await page.bringToFront();
  await page.waitForFunction(() => '__TAURI_INTERNALS__' in window);
  const reported = await invoke('plugin:path|resolve_directory', { directory: 14 });
  assert.equal(reported.toLowerCase(), appData.toLowerCase(), 'Aborta: el ejecutable debe usar únicamente SQLite de QA');
  if (rc1) assert.equal((await invoke('bootstrap')).qaMode, 'fixture');
  dataDir = expectedData;
  assert.equal((await invoke('distribution_info')).updaterEnabled, false, 'El overlay QA no debe consultar actualizaciones');
  assert.match(await page.evaluate(() => navigator.userAgent), /Edg\//);
  const entry = await page.locator('script[type="module"]').getAttribute('src');
  assert(entry && readFileSync(join(root, 'dist', 'index.html'), 'utf8').includes(entry),
    'El ejecutable no contiene el frontend que acaba de compilarse');
  const detection = await invoke('detect_agents');
  assert(detection.length === 2 && detection.every((item) => item.working && item.path?.toLowerCase().startsWith(session.toLowerCase())),
    'La sesión de QA debe detectar solamente los dos fixtures locales');
  check('WebView2 real, identidad QA, SQLite aislada, actualizador desactivado y proveedores simulados locales');
  const data = await seed();
  await workspace(data);
  await exercise(data);
  if (isolated) await checkRuntime(data.primary);
  assert.deepEqual(errors, []);
  if (existsSync(join(evidence, 'fallo.png'))) unlinkSync(join(evidence, 'fallo.png'));
} catch (error) {
  console.error(error);
  failure = String(error);
  if (page) await shot('fallo').catch(() => undefined);
  process.exitCode = 1;
} finally {
  writeFileSync(join(evidence, 'verificacion.json'), JSON.stringify({
    runtime: 'Tauri / WebView2', session, fixtureRoot, dataDir, checks, measurements, errors, failure,
    sha256: createHash('sha256').update(readFileSync(exe)).digest('hex'),
  }, null, 2));
  if (browser) await browser.close().catch(() => undefined);
  app.kill();
}

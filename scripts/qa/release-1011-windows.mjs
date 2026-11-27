import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// QA de publicación de Duovra 1.0.11 en un Windows desechable de GitHub Actions.
// clean: instalación limpia del instalador firmado. packages: 1.0.10 pública → instalador firmado 1.0.11 y ZIP.
// public: 1.0.10 pública → actualizador real por el canal estable. Sin cuentas reales ni llamadas a modelos.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Solo en Windows desechable de GitHub Actions');
assert.equal(process.platform, 'win32');
const phase = process.argv[2];
assert(['clean', 'packages', 'public'].includes(phase));
const OLD = '1.0.10';
const NEW = '1.0.11';

const output = resolve('output');
const installDir = join(output, 'installed');
const installed = join(installDir, 'duovra.exe');
const profile = join(process.env.APPDATA, 'dev.duovra.studio.beta');
const dbPath = join(profile, 'studio.sqlite3');
assert(!existsSync(profile), 'Hay un perfil anterior en el runner');
const cdp = 'http://127.0.0.1:19333';
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=19333',
  WEBVIEW2_USER_DATA_FOLDER: join(output, 'webview'),
};
const installer = (dir, version) => join(output, dir, `Duovra-${version}-windows-x64-setup.exe`);
const install = (path) => execFileSync(path, ['/S', '/NS', '/D=' + installDir], { timeout: 90_000, windowsHide: true, stdio: 'inherit' });
const invoke = (page, cmd, args = {}) => page.evaluate(([command, payload]) =>
  window.__TAURI_INTERNALS__.invoke(command, payload), [cmd, args]);
const firstPage = (browser) => browser.contexts()[0]?.pages()[0];
const NEW_TABLES = ['imported_sessions', 'instruction_deliveries', 'instruction_revisions', 'instructions', 'interactions',
  'legacy_instruction_context', 'memories', 'memory_deliveries', 'memory_revisions', 'prompts'];

async function poll(read, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(350);
  } while (Date.now() < deadline);
  throw new Error(message, { cause: lastError });
}

let connection;
let app;
async function appWithVersion(version) {
  return poll(async () => {
    if (!connection?.isConnected()) {
      if (!(await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(800) })).ok) return;
      connection = await chromium.connectOverCDP(cdp, { timeout: 2000 });
    }
    const page = firstPage(connection);
    const info = page && await invoke(page, 'bootstrap');
    if (info?.appVersion === version) return { page, info };
  }, `No se abrió Duovra ${version} con su perfil`, 110_000);
}

async function start(executable, version) {
  assert(existsSync(executable), `No existe ${executable}`);
  app = spawn(executable, [], { cwd: dirname(executable), env, stdio: 'inherit' });
  app.on('error', console.error);
  app.on('exit', (code, signal) => console.log('Proceso Duovra finalizado:', code, signal));
  console.log('Iniciado Duovra:', app.pid, executable);
  return appWithVersion(version);
}

async function stop() {
  const page = connection && firstPage(connection);
  if (page && !page.isClosed()) {
    await page.locator('.titlebar .win-close').click({ timeout: 5000 }).catch(() => {});
  }
  if (app?.exitCode === null && app.signalCode === null) {
    app.kill();
    await poll(async () => app.exitCode !== null || app.signalCode !== null, 'No se cerró Duovra');
  }
  await connection?.close().catch(() => {});
  connection = undefined;
  await poll(async () => !await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(600) }).then(() => true, () => false),
    'WebView2 no liberó el puerto');
}

// Integridad SQLite y migraciones de 1.0.11, con la app cerrada.
function checkDatabase(expectNewSchema) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
    for (const table of NEW_TABLES) assert.equal(tables.has(table), expectNewSchema, `Tabla ${table}`);
    return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
  } finally {
    db.close();
  }
}

if (phase === 'clean') {
  try {
    install(installer('signed', NEW));
    const { page, info } = await start(installed, NEW);
    const distribution = await invoke(page, 'distribution_info');
    console.log('distribution_info', JSON.stringify(distribution));
    assert.equal(distribution.updaterEnabled, true);
    assert.equal(info.projects.length, 0);
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).waitFor({ timeout: 35_000 }).catch(() => {});
    mkdirSync(join(output, 'screens'), { recursive: true });
    await page.screenshot({ path: join(output, 'screens', 'clean-install.png') });
    await stop();
    console.log('Tablas tras instalación limpia:', checkDatabase(true));
    const portableDir = join(output, 'portable');
    mkdirSync(portableDir);
    execFileSync('tar.exe', ['-xf', join(output, 'signed', `Duovra-${NEW}-windows-x64-portable.zip`), '-C', portableDir]);
    assert(existsSync(join(portableDir, 'WebView2Loader.dll')));
    assert(existsSync(join(portableDir, 'DEPENDENCY-NOTICES.txt')));
    await start(join(portableDir, 'duovra.exe'), NEW);
    console.log(`PASS: instalación limpia del instalador firmado ${NEW}, actualizador activo, esquema nuevo íntegro y ZIP portable abierto`);
  } finally {
    await stop();
  }
  process.exit(0);
}

const title = 'Conversación aislada de publicación';
const draft = 'Borrador guardado antes de actualizar';
const message = 'Mensaje histórico de prueba';
const preference = 'composer.enterToSend';
const attachment = join(output, 'adjunto-publicacion.txt');
const accountDir = join(output, 'cuenta-ficticia');
mkdirSync(accountDir, { recursive: true });
writeFileSync(attachment, 'Adjunto del borrador de prueba');

try {
  install(installer('baseline', OLD));
  const { page } = await start(installed, OLD);
  assert.equal((await invoke(page, 'distribution_info')).updaterEnabled, true);
  const project = await invoke(page, 'create_project', { name: 'Publicación QA', path: output });
  const conversation = await invoke(page, 'create_conversation', { projectId: project.id, title });
  const set = (key, value) => invoke(page, 'set_setting', { key, value });
  await set('ui.language', 'en');
  await set(preference, false);
  await set('startup.restoreConversation', true);
  await set('startup.view', 'last');
  await set('ui.lastProjectId', project.id);
  await set('ui.lastConversationId', conversation.id);
  await set('updates.autoCheck', false);
  await invoke(page, 'set_draft', { conversationId: conversation.id, draft });
  await invoke(page, 'set_draft_attachments', { conversationId: conversation.id, paths: [attachment] });

  // Historial, cuenta y sesión nativa sintéticas (sin credenciales ni CLI autenticadas).
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  const now = Date.now();
  db.prepare('INSERT INTO messages(id, conversation_id, seq, role, content, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run('release-qa-message', conversation.id, 'user', message, now);
  db.prepare('INSERT INTO accounts(id, agent, label, config_dir, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('release-qa-account', 'codex', 'Cuenta ficticia QA', accountDir, now);
  db.prepare('INSERT INTO provider_sessions(conversation_id, agent, session_id, last_seq, account_id, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
    .run(conversation.id, 'codex', 'qa-session-0001', 'release-qa-account', now);
  db.close();
  console.log(`PASS: binario oficial ${OLD}, proyecto, conversación, historial, cuenta, sesión, preferencias, borrador y adjunto creados`);

  async function verify({ page, info }) {
    assert.equal(info.projects.find(({ id }) => id === project.id)?.name, 'Publicación QA');
    const saved = info.conversations.find(({ id }) => id === conversation.id);
    assert.equal(saved?.title, title);
    assert.equal(saved?.draft, draft);
    assert.deepEqual(saved?.draftAttachments, [attachment]);
    assert.equal(info.settings['ui.language'], 'en');
    assert.equal(info.settings[preference], false);
    assert.equal(info.settings['updates.autoCheck'], false);
    assert.equal(info.accounts?.find(({ id }) => id === 'release-qa-account')?.label, 'Cuenta ficticia QA');
    const { messages } = await invoke(page, 'list_messages', { conversationId: conversation.id });
    assert(messages.some(({ content }) => content === message), 'Falta el mensaje guardado');
  }
  function verifySession() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT session_id, account_id FROM provider_sessions WHERE conversation_id = ? AND agent = ?').get(conversation.id, 'codex');
    db.close();
    assert.deepEqual({ ...row }, { session_id: 'qa-session-0001', account_id: 'release-qa-account' });
  }

  await verify({ page, info: await invoke(page, 'bootstrap') });
  await stop();
  console.log(`Tablas en ${OLD}:`, checkDatabase(false));
  const baseline = await start(installed, OLD);

  if (phase === 'packages') {
    await verify(baseline);
    await stop();
    install(installer('signed', NEW));
    const upgraded = await start(installed, NEW);
    await verify(upgraded);
    await stop();
    console.log(`Tablas en ${NEW}:`, checkDatabase(true));
    verifySession();
    const again = await start(installed, NEW);
    await verify(again);
    mkdirSync(join(output, 'screens'), { recursive: true });
    await again.page.screenshot({ path: join(output, 'screens', 'upgraded-installer.png') });
    await stop();
    checkDatabase(true);
    console.log(`PASS: instalador firmado ${OLD} → ${NEW}: proyecto, conversación, historial, cuenta, sesión, preferencias, borrador y adjunto conservados; migraciones, integridad e idempotencia al reabrir`);

    const portable = join(output, 'portable');
    mkdirSync(portable);
    execFileSync('tar.exe', ['-xf', join(output, 'signed', `Duovra-${NEW}-windows-x64-portable.zip`), '-C', portable]);
    assert(existsSync(join(portable, 'WebView2Loader.dll')));
    assert(existsSync(join(portable, 'DEPENDENCY-NOTICES.txt')));
    await verify(await start(join(portable, 'duovra.exe'), NEW));
    console.log(`PASS: ZIP firmado ${NEW} extraído y abierto con WebView2 sobre el perfil migrado`);
  }

  if (phase === 'public') {
    const { page } = baseline;
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 35_000 });
    await page.getByRole('tab', { name: 'Updates and notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    const notes = page.getByRole('dialog', { name: /new in Duovra/i });
    await notes.getByText(`Duovra ${NEW}`, { exact: true }).waitFor({ timeout: 140_000 });
    console.log(`PASS: ${OLD} detectó ${NEW} en el canal estable real`);
    await notes.getByRole('button', { name: 'Update now', exact: true }).click();
    await poll(async () => {
      const error = page.locator('dialog.update-screen [data-phase="error"] #update-detail');
      if (await error.isVisible().catch(() => false)) {
        console.error('Error mostrado por el actualizador:', await error.textContent());
      }
      return app.exitCode !== null || app.signalCode !== null;
    }, 'El actualizador no cerró la versión anterior para instalar la descarga verificada', 150_000);

    const reopened = await appWithVersion(NEW);
    await verify(reopened);
    const composer = reopened.page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await composer.waitFor({ timeout: 30_000 });
    assert.equal(await composer.inputValue(), draft);
    await reopened.page.getByText('adjunto-publicacion.txt').first().waitFor({ timeout: 15_000 });
    await poll(async () => (await invoke(reopened.page, 'bootstrap')).settings['updates.pending'] === null,
      'La reapertura no confirmó la actualización');
    mkdirSync(join(output, 'screens'), { recursive: true });
    await reopened.page.screenshot({ path: join(output, 'screens', 'updated-channel.png') });
    // El actualizador relanza la app fuera de este proceso: se cierra desde la ventana y se espera al puerto.
    await reopened.page.locator('.titlebar .win-close').click({ timeout: 5000 }).catch(() => {});
    await connection?.close().catch(() => {});
    connection = undefined;
    await poll(async () => !await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(600) }).then(() => true, () => false),
      'WebView2 no liberó el puerto', 30_000);
    await poll(async () => { try { checkDatabase(true); return true; } catch { return false; } }, 'Base de datos no íntegra tras actualizar', 20_000);
    verifySession();
    console.log(`PASS: canal público, descarga, firma Tauri, instalación, reapertura automática ${NEW}; conversación, historial, cuenta, sesión, preferencias, borrador, adjunto, migraciones e integridad SQLite`);
  }
} finally {
  await stop();
}

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Solo en Windows desechable de GitHub Actions');
assert.equal(process.platform, 'win32');
const phase = process.argv[2];
assert(['baseline', 'packages', 'public'].includes(phase));

const output = resolve('output');
const installDir = join(output, 'installed');
const installed = join(installDir, 'duovra.exe');
const profile = join(process.env.APPDATA, 'dev.duovra.studio.beta');
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
  if (app?.exitCode === null && app.signalCode === null) {
    app.kill();
    await poll(async () => app.exitCode !== null || app.signalCode !== null, 'No se cerró Duovra');
  }
  await connection?.close().catch(() => {});
  connection = undefined;
  await poll(async () => !await fetch(cdp + '/json/version', { signal: AbortSignal.timeout(600) }).then(() => true, () => false),
    'WebView2 no liberó el puerto');
}

const title = 'Conversación aislada de publicación';
const draft = 'Borrador guardado antes de actualizar';
const message = 'Mensaje histórico de prueba';
const preference = 'composer.sendOnEnter';

try {
  install(installer('baseline', '1.0.7'));
  const { page } = await start(installed, '1.0.7');
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

  const db = new DatabaseSync(join(profile, 'studio.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('INSERT INTO messages(id, conversation_id, seq, role, content, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run('release-qa-message', conversation.id, 'user', message, Date.now());
  db.close();
  console.log('PASS: binario oficial 1.0.7, WebView2, proyecto, conversación, historial, preferencias y borrador creados');

  async function verify({ page, info }) {
    assert.equal(info.projects.find(({ id }) => id === project.id)?.name, 'Publicación QA');
    const saved = info.conversations.find(({ id }) => id === conversation.id);
    assert.equal(saved?.title, title);
    assert.equal(saved?.draft, draft);
    assert.equal(info.settings['ui.language'], 'en');
    assert.equal(info.settings[preference], false);
    const { messages } = await invoke(page, 'list_messages', { conversationId: conversation.id });
    assert(messages.some(({ content }) => content === message), 'Falta el mensaje guardado');
  }

  await verify({ page, info: await invoke(page, 'bootstrap') });
  if (phase === 'packages') {
    await stop();
    install(installer('signed', '1.0.8'));
    const upgraded = await start(installed, '1.0.8');
    await verify(upgraded);
    console.log('PASS: instalador oficial 1.0.7 → 1.0.8 conserva proyecto, conversación, mensajes, preferencias y borrador');

    const captures = join(output, 'appearance');
    mkdirSync(captures);
    for (const [lang, settings, appearance] of [['en', 'Settings', 'Appearance'], ['es', 'Ajustes', 'Apariencia']]) {
      await invoke(upgraded.page, 'set_setting', { key: 'ui.language', value: lang });
      await upgraded.page.reload();
      await upgraded.page.getByRole('button', { name: settings, exact: true }).click({ timeout: 35_000 });
      await upgraded.page.getByRole('tab', { name: appearance, exact: true }).click();
      await upgraded.page.screenshot({ path: join(captures, lang + '.png') });
    }
    await invoke(upgraded.page, 'set_setting', { key: 'ui.language', value: 'en' });
    await stop();

    const portable = join(output, 'portable');
    mkdirSync(portable);
    execFileSync('tar.exe', ['-xf', join(output, 'signed', 'Duovra-1.0.8-windows-x64-portable.zip'), '-C', portable]);
    assert(existsSync(join(portable, 'WebView2Loader.dll')));
    assert(existsSync(join(portable, 'DEPENDENCY-NOTICES.txt')));
    await verify(await start(join(portable, 'duovra.exe'), '1.0.8'));
    console.log('PASS: ZIP oficial 1.0.8 extraído y abierto con WebView2, datos del perfil íntegros');
  }

  if (phase === 'public') {
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 35_000 });
    await page.getByRole('tab', { name: 'Updates and notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    const notes = page.getByRole('dialog', { name: /new in Duovra/i });
    await notes.getByText('Duovra 1.0.8', { exact: true }).waitFor({ timeout: 140_000 });
    console.log('PASS: 1.0.7 detectó 1.0.8 en el canal estable real');
    await notes.getByRole('button', { name: 'Update now', exact: true }).click();
    await poll(async () => {
      const error = page.locator('dialog.update-screen [data-phase="error"] #update-detail');
      if (await error.isVisible().catch(() => false)) {
        console.error('Error mostrado por el actualizador:', await error.textContent());
      }
      return app.exitCode !== null || app.signalCode !== null;
    }, 'El actualizador no cerró la versión anterior para instalar la descarga verificada', 150_000);

    const reopened = await appWithVersion('1.0.8');
    await verify(reopened);
    await poll(async () => (await invoke(reopened.page, 'bootstrap')).settings['updates.pending'] === null,
      'La reapertura no confirmó la actualización');
    console.log('PASS: canal público, descarga, firma y versión Tauri, instalación, reapertura automática y conservación de conversación, historial, preferencias y borrador');
  }
} finally {
  await stop();
}

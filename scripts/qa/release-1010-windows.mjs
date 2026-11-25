import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

const title = 'Conversación aislada de publicación';
const draft = 'Borrador guardado antes de actualizar';
const message = 'Mensaje histórico de prueba';
const preference = 'composer.enterToSend';
const attachment = join(output, 'adjunto-publicacion.txt');
writeFileSync(attachment, 'Adjunto del borrador de prueba');

try {
  install(installer('baseline', '1.0.9'));
  const { page } = await start(installed, '1.0.9');
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

  const db = new DatabaseSync(join(profile, 'studio.sqlite3'));
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('INSERT INTO messages(id, conversation_id, seq, role, content, created_at) VALUES (?, ?, 1, ?, ?, ?)')
    .run('release-qa-message', conversation.id, 'user', message, Date.now());
  db.close();
  console.log('PASS: binario oficial 1.0.9, WebView2, proyecto, conversación, historial, preferencias, borrador y adjunto creados');

  async function verify({ page, info }) {
    assert.equal(info.projects.find(({ id }) => id === project.id)?.name, 'Publicación QA');
    const saved = info.conversations.find(({ id }) => id === conversation.id);
    assert.equal(saved?.title, title);
    assert.equal(saved?.draft, draft);
    assert.deepEqual(saved?.draftAttachments, [attachment]);
    assert.equal(info.settings['ui.language'], 'en');
    assert.equal(info.settings[preference], false);
    assert.equal(info.settings['updates.autoCheck'], false);
    const { messages } = await invoke(page, 'list_messages', { conversationId: conversation.id });
    assert(messages.some(({ content }) => content === message), 'Falta el mensaje guardado');
  }

  await verify({ page, info: await invoke(page, 'bootstrap') });
  if (phase === 'packages') {
    await stop();
    install(installer('signed', '1.0.10'));
    const upgraded = await start(installed, '1.0.10');
    await verify(upgraded);
    console.log('PASS: instalador oficial 1.0.9 → 1.0.10 conserva proyecto, conversación, mensajes, preferencias, borrador y adjunto');

    // Botón de apoyo (1.0.10) en el binario firmado: etiqueta por idioma, barra expandida y contraída,
    // y la URL que la app nativa entrega al plugin opener (se reenvía la llamada original, así que el
    // permiso de la capacidad también queda comprobado). No se visita ninguna plataforma de pago.
    const captures = join(output, 'support');
    mkdirSync(captures);
    for (const [lang, label, url] of [['es', 'Apoyar Duovra', 'https://duovra.vercel.app/#support'], ['en', 'Support Duovra', 'https://duovra.vercel.app/en#support']]) {
      await invoke(upgraded.page, 'set_setting', { key: 'ui.language', value: lang });
      await invoke(upgraded.page, 'set_setting', { key: 'ui.sidebarCollapsed', value: false });
      await upgraded.page.reload();
      const full = upgraded.page.locator('.support-link');
      await full.waitFor({ timeout: 35_000 });
      assert.equal((await full.innerText()).trim(), label);
      await upgraded.page.screenshot({ path: join(captures, lang + '-expanded.png') });
      const calls = await upgraded.page.evaluate(async () => {
        const internals = window.__TAURI_INTERNALS__;
        const original = internals.invoke;
        const seen = [];
        internals.invoke = (cmd, args, options) => {
          const result = original.call(internals, cmd, args, options);
          if (cmd.includes('opener')) seen.push({ cmd, url: args?.url, result: result.then(() => 'ok', (e) => 'error: ' + String(e)) });
          return result;
        };
        document.querySelector('.support-link').click();
        await new Promise((ok) => setTimeout(ok, 1500));
        internals.invoke = original;
        return Promise.all(seen.map(async (c) => ({ cmd: c.cmd, url: c.url, result: await c.result })));
      });
      console.log('Apoyo', lang, JSON.stringify(calls));
      assert.deepEqual(calls, [{ cmd: 'plugin:opener|open_url', url, result: 'ok' }]);
      await invoke(upgraded.page, 'set_setting', { key: 'ui.sidebarCollapsed', value: true });
      await upgraded.page.reload();
      const rail = upgraded.page.locator('.support-rail');
      await rail.waitFor({ timeout: 35_000 });
      assert.equal(await rail.getAttribute('data-tip'), label);
      await upgraded.page.screenshot({ path: join(captures, lang + '-collapsed.png') });
    }
    await invoke(upgraded.page, 'set_setting', { key: 'ui.sidebarCollapsed', value: false });
    console.log('PASS: botón de apoyo en la build firmada (ES/EN, barra expandida y contraída, open_url con la URL del idioma)');
    await invoke(upgraded.page, 'set_setting', { key: 'ui.language', value: 'en' });
    await stop();

    const portable = join(output, 'portable');
    mkdirSync(portable);
    execFileSync('tar.exe', ['-xf', join(output, 'signed', 'Duovra-1.0.10-windows-x64-portable.zip'), '-C', portable]);
    assert(existsSync(join(portable, 'WebView2Loader.dll')));
    assert(existsSync(join(portable, 'DEPENDENCY-NOTICES.txt')));
    await verify(await start(join(portable, 'duovra.exe'), '1.0.10'));
    console.log('PASS: ZIP oficial 1.0.10 extraído y abierto con WebView2, datos del perfil íntegros');
  }

  if (phase === 'public') {
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 35_000 });
    await page.getByRole('tab', { name: 'Updates and notifications', exact: true }).click();
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    const notes = page.getByRole('dialog', { name: /new in Duovra/i });
    await notes.getByText('Duovra 1.0.10', { exact: true }).waitFor({ timeout: 140_000 });
    console.log('PASS: 1.0.9 detectó 1.0.10 en el canal estable real');
    await notes.getByRole('button', { name: 'Update now', exact: true }).click();
    await poll(async () => {
      const error = page.locator('dialog.update-screen [data-phase="error"] #update-detail');
      if (await error.isVisible().catch(() => false)) {
        console.error('Error mostrado por el actualizador:', await error.textContent());
      }
      return app.exitCode !== null || app.signalCode !== null;
    }, 'El actualizador no cerró la versión anterior para instalar la descarga verificada', 150_000);

    const reopened = await appWithVersion('1.0.10');
    await verify(reopened);
    const composer = reopened.page.getByRole('textbox', { name: 'Mensaje', exact: true });
    await composer.waitFor({ timeout: 30_000 });
    assert.equal(await composer.inputValue(), draft);
    await reopened.page.getByText('adjunto-publicacion.txt').first().waitFor({ timeout: 15_000 });
    await poll(async () => (await invoke(reopened.page, 'bootstrap')).settings['updates.pending'] === null,
      'La reapertura no confirmó la actualización');
    console.log('PASS: canal público, descarga, firma y versión Tauri, instalación, reapertura automática y conservación de conversación, historial, preferencias, borrador y adjunto');
  }
} finally {
  await stop();
}

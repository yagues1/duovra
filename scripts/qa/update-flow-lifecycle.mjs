import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import verifyReport from './distribution-webview.mjs';
import verifyUpdate from './update-flow-webview.mjs';

const directory = resolve('output/qa/distribution');
const { current, next, productName, mainBinaryName, identifier } = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8'));
assert.equal(identifier, 'dev.duovra.studio.qa.distribution');
assert.equal(productName, 'Duovra Distribution QA');
assert.equal(mainBinaryName, 'duovra-distribution-qa');
const live = process.argv.includes('--live-report');
const run = mkdtempSync(join(directory, 'run-'));
const installer = join(directory, `qa-${current}-setup.exe`);
const installDir = join(run, 'app');
const exe = join(installDir, mainBinaryName + '.exe');
const ca = readFileSync(join(directory, 'ca.pem'));
const endpoint = 'http://127.0.0.1:19333';
const origin = 'https://127.0.0.1:17443';
const registry = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}`;
assert.equal(spawnSync('reg.exe', ['query', registry], { stdio: 'ignore' }).status, 1,
  'Ya hay una instalación de este producto de QA. Retírala antes de ejecutar la prueba.');
assert(!(await fetch(endpoint + '/json/version').then(() => true, () => false)), 'El puerto CDP ya está ocupado');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(webview2_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home|duovra_qa_live_report)$/i.test(name)) delete env[name];
}
const codex = join(run, 'codex.cmd');
writeFileSync(codex, '@echo off\r\n"' + process.execPath + '" "' + resolve('scripts/qa/execution-queue-agent.mjs') + '" codex %*\r\n');
const codexHome = join(run, 'codex-home');
mkdirSync(codexHome);
Object.assign(env, {
  CODEX_HOME: codexHome,
  DUOVRA_QUEUE_FIXTURE: run,
  WEBVIEW2_USER_DATA_FOLDER: join(run, 'webview2'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=19333',
  ...(live && { DUOVRA_QA_LIVE_REPORT: '1' }),
});

function mode(name) {
  return new Promise((resolve, reject) => {
    const req = request(origin + '/qa?mode=' + name, { method: 'POST', ca, timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('El servidor rechazó el modo de QA')));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Servidor de QA sin respuesta')));
    req.end();
  });
}

async function poll(read, label, timeout = 30_000) {
  const until = Date.now() + timeout;
  do {
    const value = await read().catch(() => undefined);
    if (value) return value;
    await wait(200);
  } while (Date.now() < until);
  assert.fail(label);
}

let server;
function startServer() {
  server = spawn(process.execPath, ['scripts/qa/distribution-server.mjs', directory,
    join(directory, `qa-${next}-setup.exe`), next], { stdio: 'inherit', windowsHide: true });
  return poll(async () => {
    if (server.exitCode !== null) return false;
    await mode('current');
    return true;
  }, 'No arrancó el canal local de QA');
}

let browser;
let app;
let failure;
const log = (...parts) => console.log('PASS', ...parts);
try {
  await startServer();
  execFileSync(installer, ['/S', '/D=' + installDir], { timeout: 90_000, windowsHide: true });
  assert(existsSync(exe), 'NSIS no instaló el ejecutable de QA');
  app = spawn(exe, [], { cwd: installDir, env, stdio: 'ignore' });
  await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'No se abrió WebView2');
  browser = await chromium.connectOverCDP(endpoint);
  const page = await poll(async () => browser.contexts()[0]?.pages()[0], 'No apareció la ventana de QA');
  const invokeOn = (view, cmd, args = {}) => view.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const invoke = (cmd, args) => invokeOn(page, cmd, args);
  const before = await poll(() => invoke('bootstrap'), 'No se abrió SQLite');
  assert.equal(before.appVersion, current);
  assert.deepEqual(await invoke('distribution_info'), {
    version: current, platform: 'Windows (x86_64)', reportingEnabled: true, updaterEnabled: true,
  });

  await verifyReport(page, { mode, invoke, live, log });
  if (!live) {
    const project = await invoke('create_project', { name: 'Proyecto QA', path: run });
    const conversation = await invoke('create_conversation', { projectId: project.id, title: 'Conversación QA' });
    const setting = (key, value) => invoke('set_setting', { key, value });
    await setting('qa.distribution', run);
    await setting('agents.codex.path', codex);
    await setting('ui.lastProjectId', project.id);
    await setting('ui.lastConversationId', conversation.id);
    server.kill();
    await poll(async () => server.exitCode !== null || server.signalCode !== null, 'No se detuvo el canal local');
    await assert.rejects(invoke('check_update'), /No se pudo consultar el canal/);
    await startServer();
    log('El canal vuelve a responder después de interrumpir la conexión.');
    await verifyUpdate(page, { mode, invoke, log, startAgent: async () => {
      const tag = 'HOLD-UPDATE';
      await invoke('send_message', { request: {
        conversationId: conversation.id, agent: 'codex', model: 'gpt-6-luna', effort: 'high',
        text: `[QA:${tag}]`, attachments: [],
      } });
      await invoke('set_draft', { conversationId: conversation.id, draft: 'Borrador persistente de QA' });
      await poll(async () => (await invoke('bootstrap')).activeRuns.some((active) => active.ready), 'El proveedor simulado no arrancó');
      return { version: next, release: () => writeFileSync(join(run, tag + '.release'), '') };
    } });
    await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'NSIS no reabrió Duovra automáticamente', 90_000);
    browser = await chromium.connectOverCDP(endpoint);
    const restarted = await poll(async () => browser.contexts()[0]?.pages()[0], 'No apareció la versión actualizada');
    const after = await poll(async () => {
      const info = await invokeOn(restarted, 'bootstrap');
      return info.appVersion === next && info;
    }, 'No se ejecuta la nueva versión');
    assert.equal(after.projects.find(({ id }) => id === project.id)?.name, 'Proyecto QA');
    assert.equal(after.conversations.find(({ id }) => id === conversation.id)?.draft, 'Borrador persistente de QA');
    assert.equal(after.settings['qa.distribution'], run);
    const messages = (await invokeOn(restarted, 'list_messages', { conversationId: conversation.id })).messages;
    assert(messages.some(({ content }) => content.includes('Codex completó HOLD-UPDATE')));
    await restarted.getByText(`Duovra se ha actualizado a la versión ${next}.`).waitFor({ timeout: 10_000 });
    log(`Instalación ${current} a ${next}, reapertura automática, versión confirmada y datos conservados.`);
  }
} catch (error) {
  failure = error;
} finally {
  for (const page of browser?.contexts()[0]?.pages() ?? []) {
    await page.getByRole('button', { name: 'Cerrar', exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  }
  if (app?.exitCode === null && app.signalCode === null) app.kill();
  await browser?.close().catch(() => {});
  server?.kill();
  const uninstall = join(installDir, 'uninstall.exe');
  if (existsSync(uninstall)) {
    try {
      execFileSync(uninstall, ['/S'], { windowsHide: true, timeout: 60_000 });
    } catch (error) {
      failure ??= error;
    }
  }
}
if (failure) throw failure;

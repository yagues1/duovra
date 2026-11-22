// Verifica el instalador y el ejecutable entregados con un UUID de perfil exclusivo.
// Añade --stable para probar 1.0.0 y --from-beta para abrir primero la Beta 2 local.
// Usa --portable-only si esta edición ya está instalada en el equipo.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { beta as personalBeta, config, root } from '../personal-beta-config.mjs';

const stable = process.argv.includes('--stable');
const fromBeta = process.argv.includes('--from-beta');
const portableOnly = process.argv.includes('--portable-only');
const verifyIndex = process.argv.indexOf('--verify-real');
const verify = verifyIndex >= 0;
const real = verify || process.argv.includes('--real');
assert(!fromBeta || (stable && !real), '--from-beta requiere --stable sin proveedores reales');
assert(!portableOnly || (stable && !real), '--portable-only requiere --stable sin proveedores reales');
const base = `${config.productName}-${config.version}`;
const directory = join(root, 'output', 'distribution', base);
const beta = stable ? {
  ...personalBeta,
  version: config.version,
  productName: config.productName,
  qa: join(root, 'output', 'qa', 'stable-lifecycle'),
  installer: join(directory, base + '-windows-x64-setup.exe'),
} : personalBeta;
if (fromBeta || !stable) {
  assert(personalBeta.productName, 'Faltan los artefactos Beta 2. Indica su carpeta con DUOVRA_BETA2_ARTIFACTS');
}
const binary = stable ? config.mainBinaryName : personalBeta.productName.toLowerCase().replaceAll(' ', '-');
const betaTitle = personalBeta.productName?.replace(/ Beta$/, ' 1.0.0 Beta 2');
const title = stable ? config.productName : betaTitle;
const test = verify ? 'proveedores-verificacion' : real ? 'proveedores' : portableOnly ? 'portable' : 'instalacion';
mkdirSync(beta.qa, { recursive: true });
const run = mkdtempSync(join(beta.qa, test + '-'));
const portableDir = join(run, 'portable');
if (stable) {
  mkdirSync(portableDir);
  execFileSync('tar.exe', ['-xf', join(directory, base + '-windows-x64-portable.zip'), '-C', portableDir], { windowsHide: true });
}
const portableExe = stable ? join(portableDir, binary + '.exe') : beta.executable;
const projectDir = join(run, 'proyecto');
mkdirSync(projectDir);
const profile = verify ? process.argv[verifyIndex + 1] : randomUUID();
assert.match(profile ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const dbPath = join(process.env.APPDATA, beta.identifier, 'fixtures', profile, 'studio.sqlite3');
const installDir = join(run, 'app');
const installedExe = join(installDir, binary + '.exe');
const uninstall = join(installDir, 'uninstall.exe');
const checks = [];
const measurements = [];
const check = (message) => { checks.push(message); console.log('PASS', message); };
const models = [
  { agent: 'claude', label: 'Claude Code', model: 'haiku', exact: 'claude-haiku-5-5', effort: 'medium', level: 'Medio',
    prompt: 'Responde solo con las palabras Faro Turquesa. No uses herramientas ni leas archivos.' },
  { agent: 'codex', label: 'Codex', model: 'gpt-6-luna', exact: 'gpt-6-luna', effort: 'high', level: 'Alto',
    prompt: 'Repite únicamente las dos palabras de la respuesta anterior. No uses herramientas ni leas archivos.' },
];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(webview2_.+|duovra_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home)$/i.test(key)));
Object.assign(env, {
  [beta.profileVariable]: profile,
  WEBVIEW2_USER_DATA_FOLDER: join(run, 'webview2'),
});

async function poll(read, message, timeout = 20_000) {
  const deadline = performance.now() + timeout;
  let lastError;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await wait(100);
  } while (performance.now() < deadline);
  throw new Error(message, { cause: lastError });
}

async function open(executable, label, expectedVersion = beta.version, expectedTitle = title) {
  const listener = createServer();
  await new Promise((done, fail) => listener.listen(0, '127.0.0.1', done).once('error', fail));
  const endpoint = 'http://127.0.0.1:' + listener.address().port;
  const args = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + listener.address().port;
  await new Promise((done) => listener.close(done));
  const start = performance.now();
  const child = spawn(executable, [], { cwd: dirname(executable), env: {
    ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args,
  }, stdio: 'ignore', windowsHide: true });
  let browser;
  const errors = [];
  try {
    await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'No se abrió WebView2');
    browser = await chromium.connectOverCDP(endpoint);
    const page = await poll(() => browser.contexts()[0]?.pages()[0], 'No se abrió la ventana');
    page.on('pageerror', (error) => errors.push(error.message));
    const invoke = (command, payload = {}) => page.evaluate(([c, p]) => window.__TAURI_INTERNALS__.invoke(c, p), [command, payload]);
    const boot = await poll(() => invoke('bootstrap'), 'No se abrió el perfil SQLite');
    measurements.push({ label, bootstrapMs: Math.round(performance.now() - start), webview: browser.version() });
    assert.equal(boot.appVersion, expectedVersion);
    assert.equal(boot.qaMode, null);
    const brand = page.locator('.brand-name');
    await brand.waitFor();
    assert.equal(await brand.innerText(), expectedTitle);
    if (stable && expectedVersion === config.version) assert.equal(await page.title(), config.productName);
    return { page, invoke, boot, async close() {
      const exited = once(child, 'exit');
      try {
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click({ timeout: 5000 });
        assert(await Promise.race([exited.then(() => true), wait(5000, false)]), 'La ventana no cerró');
        assert.deepEqual(errors, []);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await browser.close().catch(() => {});
      }
    } };
  } catch (error) {
    child.kill();
    await browser?.close().catch(() => {});
    throw error;
  }
}

const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
const betaKey = uninstallKey + beta.productName;
const betaLocationKey = 'HKCU\\Software\\duovra\\' + beta.productName;
function registry(key) {
  try {
    return execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (error.status !== 1) throw error;
    return null;
  }
}

function untouchedInstalls() {
  const registration = registry(uninstallKey + 'Duovra');
  const location = /InstallLocation\s+REG_SZ\s+([^\r\n]+)/.exec(registration ?? '')?.[1].trim().replace(/^"|"$/g, '');
  const identifiers = ['dev.claudecodexstudio.app', personalBeta.identifier];
  const profiles = identifiers.flatMap((id) => ['', '-wal', '-shm'].map((suffix) => {
    const path = join(process.env.APPDATA, id, 'studio.sqlite3' + suffix);
    if (!existsSync(path)) return null;
    const { size, mtimeMs } = statSync(path);
    return { size, mtimeMs };
  }));
  const exe = location && join(location, 'duovra.exe');
  const sha256 = exe && existsSync(exe) ? createHash('sha256').update(readFileSync(exe)).digest('hex') : null;
  const prerelease = stable && personalBeta.productName ? registry(uninstallKey + personalBeta.productName) : null;
  return { registration, prerelease, profiles, sha256 };
}

function install() {
  execFileSync(beta.installer, ['/S', '/NS', '/D=' + installDir], { windowsHide: true, timeout: 60_000, stdio: 'ignore' });
  assert(existsSync(installedExe) && existsSync(uninstall));
  assert(registry(betaKey)?.includes(beta.version), 'Identidad o versión NSIS incorrecta');
  if (stable) {
    for (const file of ['WebView2Loader.dll', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md', 'licenses/WebView2-SDK-LICENSE.txt']) {
      assert(existsSync(join(installDir, file)), 'Falta en el instalador: ' + file);
      assert.deepEqual(readFileSync(join(installDir, file)), readFileSync(join(portableDir, file)));
    }
  }
}

async function addProject(session) {
  const { invoke, boot } = session;
  assert.deepEqual(boot.projects, []);
  const project = await invoke('create_project', { name: 'Proyecto temporal de verificación', path: projectDir });
  const conversation = await invoke('create_conversation', { projectId: project.id, title: 'Verificación de Duovra' });
  await invoke('set_setting', { key: 'ui.lastProjectId', value: project.id });
  await invoke('set_setting', { key: 'ui.lastConversationId', value: conversation.id });
  return { project, conversation };
}

async function verifyTurn(page, messages, index) {
  const model = models[index];
  const message = messages.filter((item) => item.role === 'assistant')[index];
  const input = messages.find((item) => item.seq === message?.seq - 1);
  assert.equal(message?.status, 'done', model.label + ': ' + (message?.error ?? message?.status));
  assert.equal(message.model, model.exact);
  assert.equal(message.effort, model.effort);
  assert.match(message.content, /Faro Turquesa/i);
  if (index) assert.equal(input?.contextNote?.mode, 'shared');
  await page.locator('#turn-' + message.id + ' .turn-chip').filter({ hasText: model.exact }).waitFor();
  check(model.label + ' completó un turno con ' + model.exact + '/' + model.effort);
}

let session, testInstall = false, before, failure;
try {
  if (verify) {
    assert(existsSync(dbPath), 'No existe el perfil desechable indicado');
    session = await open(portableExe, 'Reapertura del historial real, sin inferencia');
    const [project] = session.boot.projects;
    const [conversation] = session.boot.conversations;
    assert.equal(project?.name, 'Proyecto temporal de verificación');
    assert(project.path.startsWith(join(beta.qa, 'proveedores-')));
    assert.equal(conversation?.title, 'Verificación de Duovra');
    const { messages } = await session.invoke('list_messages', { conversationId: conversation.id });
    assert.equal(messages.length, 4);
    for (const index of models.keys()) await verifyTurn(session.page, messages, index);
    assert.deepEqual(readdirSync(project.path), []);
    check('Conversación real compartida y carpeta temporal intacta');
  } else if (real) {
    execFileSync(process.execPath, ['scripts/qa/check-test-models.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
    session = await open(portableExe, 'Portable con CLIs reales');
    const { page, invoke } = session;
    const detected = await invoke('detect_agents');
    for (const agent of ['claude', 'codex']) assert(detected.some((item) => item.agent === agent && item.working));
    const { conversation } = await addProject(session);
    await invoke('set_setting', { key: 'codex.sandbox', value: 'read-only' });
    for (const { agent, model, effort, exact } of models.toReversed()) {
      const catalog = await invoke('agent_models', { agent });
      assert(catalog.models.some((item) => item.id === model && (item.resolved ?? item.id) === exact && item.efforts.includes(effort)));
      await invoke('set_conversation_prefs', { conversationId: conversation.id, agent, model, effort });
    }
    await page.reload();
    const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
    const picker = page.getByRole('button', { name: /^Agente para el próximo mensaje/ });
    for (const [index, model] of models.entries()) {
      if (index) {
        await picker.click();
        await page.getByRole('menuitemradio', { name: model.label, exact: true }).click();
      }
      assert((await picker.getAttribute('aria-label')).endsWith(model.label));
      await page.getByRole('button', { name: 'Esfuerzo: ' + model.level, exact: true }).waitFor();
      await composer.fill(model.prompt);
      await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
      const messages = await poll(async () => {
        const { messages } = await invoke('list_messages', { conversationId: conversation.id });
        const message = messages.filter((item) => item.role === 'assistant')[index];
        return message?.completedAt && messages;
      }, 'El turno real de ' + model.label + ' no terminó', 90_000);
      await verifyTurn(page, messages, index);
    }
    assert.deepEqual(readdirSync(projectDir), []);
    check('Conversación real compartida y carpeta temporal intacta');
  } else {
    if (!portableOnly) {
      assert(!registry(betaKey) && !registry(betaLocationKey), 'Ya hay una instalación o una ubicación previa registrada para esta edición');
      assert(existsSync(beta.installer), 'Falta el instalador de esta edición');
    }
    before = untouchedInstalls();
    mkdirSync(dirname(dbPath), { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (const agent of ['claude', 'codex']) {
      const path = join(run, agent + '.cmd');
      writeFileSync(path, '@echo off\r\n"' + process.execPath + '" "' + join(root, 'scripts', 'qa', 'execution-queue-agent.mjs') + '" ' + agent + ' %*\r\n');
      seed.prepare('INSERT INTO settings VALUES (?,?)').run('agents.' + agent + '.path', JSON.stringify(path));
      env[agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = join(run, agent);
    }
    env.DUOVRA_QUEUE_FIXTURE = run;
    seed.close();
    let previous;
    if (fromBeta) {
      session = await open(personalBeta.executable, 'Perfil original creado con Beta 2', personalBeta.version, betaTitle);
      previous = await addProject(session);
      await session.invoke('set_draft', { conversationId: previous.conversation.id, draft: 'Borrador anterior al lanzamiento' });
      await session.invoke('set_setting', { key: 'appearance.mascots', value: 'minimal' });
      await session.invoke('set_setting', { key: 'appearance.backdrop', value: 'off' });
      await session.close();
      session = undefined;

      const old = new DatabaseSync(dbPath);
      try {
        assert.equal(old.prepare("SELECT name FROM sqlite_schema WHERE name='background_images'").get(), undefined);
        old.prepare('INSERT INTO messages (id,conversation_id,seq,role,content,created_at) VALUES (?,?,?,?,?,?)')
          .run('qa-previous-turn', previous.conversation.id, 1, 'user', 'Mensaje guardado en Beta 2', Date.now());
      } finally { old.close(); }
    }
    if (!portableOnly) {
      testInstall = true;
      install();
    }
    session = portableOnly
      ? await open(portableExe, 'Apertura del ZIP x64')
      : await open(installedExe, 'Instalación x64 por usuario');
    if (previous) {
      const { project, conversation } = previous;
      assert.equal(session.boot.projects[0].id, project.id);
      assert.equal(session.boot.conversations[0].id, conversation.id);
      assert.equal(session.boot.conversations[0].draft, 'Borrador anterior al lanzamiento');
      assert.equal(session.boot.settings['appearance.mascots'], 'minimal');
      assert.equal(session.boot.settings['appearance.backdrop'], 'off');
      await session.page.locator('.chat-stage [data-activity][aria-hidden="true"]').waitFor({ state: 'hidden' });
      const { messages } = await session.invoke('list_messages', { conversationId: conversation.id });
      assert.equal(messages[0].content, 'Mensaje guardado en Beta 2');
      const backup = new DatabaseSync(join(dirname(dbPath), 'studio.pre-1.0.0.sqlite3.bak'), { readOnly: true });
      try {
        assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.equal(backup.prepare('SELECT content FROM messages WHERE id=?').get('qa-previous-turn').content, messages[0].content);
        assert.equal(backup.prepare("SELECT name FROM sqlite_schema WHERE name='background_images'").get(), undefined);
      } finally { backup.close(); }
      check('Beta 2 → 1.0.0 conserva proyecto, conversación, borrador, mensaje y ajustes, con respaldo del esquema original');
    }
    const distribution = await session.invoke('distribution_info');
    assert.equal(distribution.version, beta.version);
    assert.equal(distribution.updaterEnabled, false);
    assert.equal(distribution.reportingEnabled, false);
    assert.equal(await session.invoke('check_update'), null);
    await assert.rejects(session.invoke('submit_report', { report: {} }), /no está configurado/);
    check((portableOnly ? 'ZIP' : 'NSIS') + ', arranque nativo, marca y bloqueo de red de distribución');
    const { project, conversation } = previous ?? await addProject(session);
    await session.invoke('set_setting', { key: 'appearance.intensity', value: 'reduced' });
    await session.page.reload();
    const start = performance.now();
    await session.page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Borrador persistente de verificación');
    measurements.push({ label: 'Primera edición tras recarga', fillMs: Math.round(performance.now() - start) });
    await session.close();
    session = undefined;
    if (!portableOnly) install();
    for (const executable of portableOnly ? [portableExe] : [installedExe, portableExe]) {
      const label = portableOnly ? 'Reapertura del portable' : executable === installedExe ? 'Reinstalación de NSIS' : 'Portable tras reinstalación';
      session = await open(executable, label);
      assert.equal(session.boot.projects[0].id, project.id);
      assert.equal(session.boot.conversations[0].id, conversation.id);
      assert.equal(session.boot.conversations[0].draft, 'Borrador persistente de verificación');
      assert.equal(session.boot.settings['appearance.intensity'], 'reduced');
      await session.close();
      session = undefined;
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    check((portableOnly ? 'Reapertura del portable' : 'Reinstalación, reinicio y portable')
      + ' conserva proyecto, conversación, borrador y ajustes. SQLite íntegro');
    if (portableOnly) {
      assert.deepEqual(untouchedInstalls(), before);
      check('Registros de instalación y metadatos de perfiles reales intactos');
    }
  }
} catch (error) {
  failure = error;
} finally {
  await session?.close().catch(() => {});
  if (testInstall) {
    try {
      if (existsSync(uninstall)) {
        execFileSync(uninstall, ['/S'], { windowsHide: true, timeout: 60_000, stdio: 'ignore' });
        await poll(() => !existsSync(installedExe) && !registry(betaKey), 'La desinstalación no retiró la instalación de prueba');
        assert(existsSync(dbPath));
        check('Retirada de los binarios de prueba con datos de prueba preservados');
      }
      assert.equal(registry(betaKey), null);
      const location = registry(betaLocationKey);
      if (location) {
        assert(location.includes(installDir) || location.trim().split(/\r?\n/).length === 1,
          'La ubicación registrada ya no pertenece a esta prueba');
        execFileSync('reg.exe', ['delete', betaLocationKey, '/f'], { windowsHide: true, stdio: 'ignore' });
      }
      assert.deepEqual(untouchedInstalls(), before);
      if (before.registration || before.prerelease) check('Registros de las otras ediciones y metadatos de sus perfiles intactos');
    } catch (error) { failure ??= error; }
  }
  writeFileSync(join(beta.qa, test + '.json'), JSON.stringify({ ok: !failure, checks, measurements, failure: failure?.stack ?? null }, null, 2));
}
if (failure) throw failure;

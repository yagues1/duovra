// Ejecuta NSIS y WebView2 con un identificador, perfiles y proveedor locales de QA.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'output', 'qa', 'rc1');
const run = mkdtempSync(join(out, 'instalacion-'));
const installer = join(out, 'Duovra RC1 QA_0.6.0-rc.1_x64-setup.exe');
const installDir = join(run, 'app');
const exe = join(installDir, 'duovra.exe');
const uninstall = join(installDir, 'uninstall.exe');
const appData = join(process.env.APPDATA, 'dev.duovra.studio.rc1.qa');
const evidence = join(out, 'verificacion-instala-migra.json');
const registry = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Duovra RC1 QA`;
const legacySource = execFileSync('git', ['show', 'v0.5.1:src-tauri/src/db.rs'], { cwd: root, encoding: 'utf8' });
const legacySchema = /const SCHEMA: &str = r#"([\s\S]*?)"#;/.exec(legacySource)?.[1];
assert(legacySchema && legacySource.includes("ADD COLUMN agent_prefs TEXT NOT NULL DEFAULT '{}'"));
const profiles = Object.fromEntries(['codex', 'claude'].map((agent) => {
  const dir = join(run, agent);
  mkdirSync(dir);
  const path = join(run, agent + '.cmd');
  const fixture = join(root, 'scripts', 'qa', 'execution-queue-agent.mjs');
  writeFileSync(path, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" ' + agent + ' %*\r\n');
  return [agent, { dir, path }];
}));
const checks = [];
const measurements = [];
const check = (label) => { checks.push(label); console.log('PASS', label); };
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(webview2_.+|anthropic_.+|openai_.+|claude_config_dir|codex_home)$/i.test(name)) delete env[name];
}
Object.assign(env, { CODEX_HOME: profiles.codex.dir, CLAUDE_CONFIG_DIR: profiles.claude.dir, DUOVRA_QUEUE_FIXTURE: run });

function profile() {
  const id = randomUUID();
  const dir = join(appData, 'fixtures', id);
  mkdirSync(dir, { recursive: true });
  return { id, path: join(dir, 'studio.sqlite3'), webview: join(run, 'webview-' + id) };
}

function configure(db) {
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const set = db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
  for (const [agent, configuration] of Object.entries(profiles)) {
    set.run('agents.' + agent + '.path', JSON.stringify(configuration.path));
  }
  set.run('appearance.intensity', '"reduced"');
}

function setupLegacy(db) {
  db.exec(legacySchema);
  db.exec("ALTER TABLE conversations ADD COLUMN agent_prefs TEXT NOT NULL DEFAULT '{}'");
  configure(db);
  db.exec(`
    INSERT INTO projects VALUES('old-p','Proyecto de 0.5.1','C:/qa',1,2);
    INSERT INTO conversations(id,project_id,title,created_at,updated_at,last_agent,last_model,last_effort,draft,agent_prefs)
    VALUES('old-c','old-p','Historial legado',2,3,'codex','gpt-6-luna','high','Borrador previo',
           '{"codex":{"model":"gpt-6-luna","effort":"high"},"claude":{"model":"haiku","effort":"medium"}}');
    INSERT INTO accounts VALUES('old-account','claude','Cuenta histórica','C:/qa/cuenta-anterior',1);
    INSERT INTO provider_sessions VALUES('old-c','claude','claude-session',2,'old-account',3),
      ('old-c','codex','codex-thread',3,NULL,3);
    INSERT INTO messages(id,conversation_id,seq,role,agent,model,effort,content,items,usage,attachments,context_note,created_at,completed_at)
    VALUES('old-u','old-c',1,'user','claude','haiku','medium','Adjunto la nota','[]','null',
       '[{"path":"C:/qa/nota.txt","name":"nota.txt","image":false}]','{"mode":"none"}',2,2),
      ('old-h','old-c',2,'assistant','claude','claude-haiku-5-5','medium','Respuesta Claude',
       '[{"id":"old-tool","kind":"command","status":"completed","output":"resultado"}]','{"inputTokens":14}',
       '[]','null',3,4),
      ('old-x','old-c',3,'assistant','codex','gpt-6-luna','high','Respuesta Codex','[]','null','[]','null',4,5);
    INSERT INTO usage_log(conversation_id,agent,model,input_tokens,output_tokens,created_at)
    VALUES('old-c','claude','claude-haiku-5-5',14,5,4);
    INSERT INTO settings VALUES('ui.lastProjectId','"old-p"'),('ui.lastConversationId','"old-c"'),
      ('appearance.hue','"menta"');
  `);
}

function integrity(db, version) {
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function legacyRows(db) {
  return [
    'SELECT * FROM projects ORDER BY id',
    'SELECT id,project_id,title,created_at,updated_at,last_agent,last_model,last_effort,draft,agent_prefs FROM conversations ORDER BY id',
    ...['messages', 'provider_sessions', 'accounts', 'settings', 'usage_log'].map((table) =>
      'SELECT * FROM ' + table + ' ORDER BY rowid'),
  ].map((sql) => db.prepare(sql).all());
}

async function poll(read, label, timeout = 20000) {
  const start = performance.now();
  do {
    const value = await read().catch(() => null);
    if (value) return value;
    await wait(100);
  } while (performance.now() - start < timeout);
  assert.fail(label);
}

async function open(profile, label) {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const endpoint = 'http://127.0.0.1:' + port;
  const start = performance.now();
  const child = spawn(exe, [], { cwd: installDir, env: {
    ...env, DUOVRA_RC1_TEST_PROFILE: profile.id, WEBVIEW2_USER_DATA_FOLDER: profile.webview,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=' + port,
  }, stdio: 'ignore' });
  let browser;
  try {
    await poll(async () => (await fetch(endpoint + '/json/version')).ok, 'No se abrió WebView2');
    browser = await chromium.connectOverCDP(endpoint);
    const page = await poll(async () => browser.contexts()[0]?.pages()[0], 'No apareció una ventana');
    const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
    const boot = await poll(() => invoke('bootstrap'), 'SQLite no se abrió');
    measurements.push({ label, bootstrapMs: Math.round(performance.now() - start), webview: browser.version() });
    assert.equal(boot.appVersion, '0.6.0-rc.1');
    assert.equal(boot.qaMode, 'fixture');
    const distribution = await invoke('distribution_info');
    assert.equal(distribution.version, '0.6.0-rc.1');
    assert.equal(distribution.updaterEnabled, false);
    assert.equal(distribution.reportingEnabled, false);
    return { page, invoke, boot, async close() {
      const exited = once(child, 'exit');
      try {
        await page.getByRole('button', { name: 'Cerrar', exact: true }).click({ timeout: 4000 });
        assert(await Promise.race([exited.then(() => true), wait(4000, false)]), 'La ventana no cerró');
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

function install() {
  execFileSync(installer, ['/S', '/D=' + resolve(installDir)], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
  assert(existsSync(exe) && existsSync(uninstall));
}

let session, source, installed = false, failure;
const clean = profile();
const migrated = profile();
try {
  assert(existsSync(installer), 'Compila primero la candidata NSIS');
  let existing = false;
  try {
    existing = !!execFileSync('reg.exe', ['query', registry], { stdio: ['ignore', 'pipe', 'ignore'] }).length;
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert(!existing, 'Ya hay una instalación RC1 QA registrada');
  install();
  installed = true;
  const cleanDb = new DatabaseSync(clean.path);
  configure(cleanDb);
  cleanDb.close();
  session = await open(clean, 'Instalación limpia, primer inicio');
  assert.deepEqual(session.boot.projects, []);
  await assert.rejects(session.invoke('submit_report', { report: {} }), /no está configurado/);
  assert.equal(await session.invoke('check_update'), null);
  const project = await session.invoke('create_project', { name: 'Proyecto limpio', path: run });
  const conversation = await session.invoke('create_conversation', { projectId: project.id });
  await session.invoke('rename_project', { id: project.id, name: 'Proyecto persistente' });
  await session.invoke('rename_conversation', { id: conversation.id, title: 'Conversación persistente' });
  await session.invoke('set_setting', { key: 'ui.lastProjectId', value: project.id });
  await session.invoke('set_setting', { key: 'ui.lastConversationId', value: conversation.id });
  await session.page.reload();
  const composer = session.page.getByRole('textbox', { name: 'Mensaje', exact: true });
  const composeStart = performance.now();
  await composer.fill('Borrador al cerrar QA');
  measurements.push({ label: 'Recarga y primera interacción del compositor', fillMs: Math.round(performance.now() - composeStart) });
  await session.close();
  session = undefined;
  check('NSIS x64 instala por usuario, abre y cierra. QA bloquea reportes y actualizaciones');

  install();
  session = await open(clean, 'Reapertura tras reinstalar la candidata');
  assert.equal(session.boot.projects[0].name, 'Proyecto persistente');
  assert.equal(session.boot.conversations[0].title, 'Conversación persistente');
  assert.equal(session.boot.conversations[0].draft, 'Borrador al cerrar QA');
  await session.invoke('delete_conversation', { id: conversation.id });
  await session.invoke('delete_project', { id: project.id });
  assert.deepEqual((await session.invoke('bootstrap')).conversations, []);
  await session.close();
  session = undefined;
  check('Sustitución de la candidata conserva proyecto, conversación y borrador y deja operar el CRUD');

  source = new DatabaseSync(migrated.path);
  source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  setupLegacy(source);
  integrity(source, 0);
  const before = legacyRows(source);
  assert(statSync(migrated.path + '-wal').size > 32);
  session = await open(migrated, 'Primer inicio sobre esquema 0.5.1 con WAL');
  assert.deepEqual(session.boot.conversations[0].draftAttachments, []);
  assert.equal((await session.invoke('run_insights', { messageId: 'old-h' })).legacy, true);
  assert.deepEqual((await session.invoke('message_queue', { conversationId: 'old-c' })).entries, []);
  assert.deepEqual(legacyRows(source), before);
  integrity(source, 1);
  const backupPath = migrated.path.replace(/\.sqlite3$/, '.pre-0.6.0.sqlite3.bak');
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  integrity(backup, 0);
  assert.deepEqual(legacyRows(backup), before);
  backup.close();
  const backupTime = statSync(backupPath).mtimeMs;
  source.close();
  source = undefined;
  await session.close();
  session = undefined;
  for (let i = 1; i <= 2; i++) {
    session = await open(migrated, 'Reinicio del perfil migrado ' + i);
    const current = new DatabaseSync(migrated.path, { readOnly: true });
    integrity(current, 1);
    assert.deepEqual(legacyRows(current), before);
    assert.equal(current.prepare('SELECT COUNT(*) AS n FROM run_insights').get().n, 2);
    assert.equal(statSync(backupPath).mtimeMs, backupTime);
    current.close();
    await session.close();
    session = undefined;
  }
  check('Migración desde el esquema del tag v0.5.1, respaldo que incluye WAL, integridad y dos reinicios idempotentes');
} catch (error) {
  failure = error;
} finally {
  source?.close();
  await session?.close().catch(() => {});
  if (installed && existsSync(uninstall)) {
    try {
      execFileSync(uninstall, ['/S'], { windowsHide: true, timeout: 60000, stdio: 'ignore' });
      await poll(async () => !existsSync(exe), 'La desinstalación no retiró el ejecutable');
      assert(existsSync(clean.path) && existsSync(migrated.path));
      check('Desinstalación silenciosa elimina los binarios de QA y conserva ambos perfiles de datos');
    } catch (error) {
      failure ??= error;
    }
  }
  writeFileSync(evidence, JSON.stringify({ ok: !failure, checks, measurements, failure: failure?.stack ?? null }, null, 2));
}
if (failure) throw failure;

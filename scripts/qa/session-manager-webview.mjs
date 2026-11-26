// QA 1.0.11 · fase 3: Session Manager sobre la app en desarrollo (perfil QA aislado).
// Requisitos: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y
// `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json`.
//
// Uso: node scripts/qa/session-manager-webview.mjs <carpeta-salida> [--real]
// Sin --real no invoca modelos: bifurcación y memoria histórica, edición, regeneración, worktrees,
// organización, importación desde una cuenta de fixture de Claude Code y aislamiento por cuenta.
// Con --real: 4 turnos breves para crear sesiones nativas (Claude Code haiku/medium ×2, Codex
// gpt-6-luna/high ×2) y 2 turnos en la bifurcación (uno por agente) que comprueban la bifurcación
// nativa exacta. Permisos de solo lectura; nunca el modo plan de Claude Code (`opusplan`).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-sessions');
const REAL = process.argv.includes('--real');
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const results = [];
const calls = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 240) : '');
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 400));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messages = async (id) => (await invoke('list_messages', { conversationId: id, includeSessions: false })).messages;
const sessions = async (id) => (await invoke('list_messages', { conversationId: id, includeSessions: true })).sessions;
const conversation = async (id) => (await invoke('bootstrap')).conversations.find((c) => c.id === id);

// ---------- Fixtures locales ----------
const dir = mkdtempSync(join(tmpdir(), 'duovra-sm-qa-'));
writeFileSync(join(dir, 'README.md'), '# Proyecto QA del Session Manager\n');
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('-c', 'user.email=qa@duovra.invalid', '-c', 'user.name=QA', 'add', '.');
git('-c', 'user.email=qa@duovra.invalid', '-c', 'user.name=QA', 'commit', '-q', '-m', 'init');
const project = await invoke('create_project', { name: 'QA Session Manager', path: dir });
const conv = await invoke('create_conversation', { projectId: project.id, title: 'QA · Session Manager' });
// Un borrador evita que la limpieza de conversaciones vacías de `bootstrap` la descarte antes del primer turno.
await invoke('set_draft', { conversationId: conv.id, draft: 'qa' });

await check('migración: las conversaciones existentes se leen sin fijar, sin archivar y sin procedencia', async () => {
  const all = (await invoke('bootstrap')).conversations;
  const old = all.filter((c) => c.id !== conv.id && c.projectId !== project.id);
  assert(all.every((c) => 'pinnedAt' in c && 'archivedAt' in c && 'origin' in c));
  return { conversations: all.length, previas: old.length, conProcedencia: old.filter((c) => c.origin?.kind).length };
});

await check('fijar, archivar y recuperar sin perder datos', async () => {
  const pinned = await invoke('set_conversation_pinned', { id: conv.id, pinned: true });
  assert(pinned.pinnedAt > 0);
  const archived = await invoke('set_conversation_archived', { id: conv.id, archived: true });
  assert(archived.archivedAt > 0 && archived.pinnedAt === pinned.pinnedAt);
  const restored = await invoke('set_conversation_archived', { id: conv.id, archived: false });
  const unpinned = await invoke('set_conversation_pinned', { id: conv.id, pinned: false });
  assert.equal(restored.archivedAt, null);
  assert.equal(unpinned.pinnedAt, null);
  return { pinnedAt: pinned.pinnedAt, archivedAt: archived.archivedAt };
});

// Cuenta de fixture de Claude Code con una transcripción propia: la importación no toca datos reales.
const fixtureHome = mkdtempSync(join(tmpdir(), 'duovra-sm-claude-home-'));
const fixtureSession = `7e57a000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
const projDir = join(fixtureHome, 'projects', 'C--qa');
mkdirSync(projDir, { recursive: true });
const line = (v) => JSON.stringify(v) + '\n';
writeFileSync(join(projDir, `${fixtureSession}.jsonl`),
  line({ type: 'user', uuid: 'u1', parentUuid: null, cwd: dir, timestamp: '2026-11-20T10:00:00.000Z', message: { role: 'user', content: 'Revisa el README del proyecto QA' } })
  + line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-20T10:00:05.000Z', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'El README tiene un único encabezado.' }] } })
  + line({ type: 'custom-title', customTitle: 'Revisión del README', sessionId: fixtureSession }));
const { accounts } = await invoke('add_account', { agent: 'claude', label: 'QA fixture', configDir: fixtureHome });
const fixtureAccount = accounts.find((a) => a.configDir === fixtureHome);

let imported;
await check('importar · listar, buscar y previsualizar sesiones de Claude Code de una cuenta', async () => {
  const target = { agent: 'claude', accountId: fixtureAccount.id };
  const all = await invoke('import_list', { target, query: '', cursor: null });
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].title, 'Revisión del README');
  assert.equal(all.items[0].conversationId, null);
  assert.equal((await invoke('import_list', { target, query: 'readme', cursor: null })).items.length, 1);
  assert.equal((await invoke('import_list', { target, query: 'inexistente', cursor: null })).items.length, 0);
  const preview = await invoke('import_preview', { target, sessionId: fixtureSession });
  assert.deepEqual(preview.messages.map((m) => m.role), ['user', 'assistant']);
  return { item: all.items[0].title, preview: preview.messages.length };
});

await check('importar · atribución, origen y prevención de duplicados', async () => {
  const target = { agent: 'claude', accountId: fixtureAccount.id };
  const r = await invoke('import_sessions', { target, projectId: project.id, worktreeId: null, sessions: [fixtureSession], native: true });
  assert.equal(r.created.length, 1);
  imported = r.created[0];
  assert.equal(imported.origin.kind, 'import');
  assert.equal(imported.origin.native.claude.state, 'pending');
  assert.equal(imported.origin.native.claude.accountId, fixtureAccount.id);
  const list = await messages(imported.id);
  assert.deepEqual(list.map((m) => [m.role, m.agent, m.model]), [['user', 'claude', null], ['assistant', 'claude', 'claude-haiku-5-5']]);
  const again = await invoke('import_sessions', { target, projectId: project.id, worktreeId: null, sessions: [fixtureSession], native: true });
  assert.equal(again.created.length, 0);
  assert.match(again.failed[0].error, /ya está en Duovra/);
  const listed = await invoke('import_list', { target, query: '', cursor: null });
  assert.equal(listed.items[0].conversationId, imported.id);
  // La cuenta de fixture no es la activa: nunca se cambia de cuenta para continuar.
  const settings = (await invoke('bootstrap')).settings;
  return { title: imported.title, activeClaudeAccount: settings['accounts.active.claude'] ?? null, failed: again.failed.length };
});

// Memoria histórica: recuerdos creados, editados y archivados en distintos puntos.
let memories = {};
await check('memoria · fixture con ediciones y archivados en distintos puntos', async () => {
  memories.a = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Decisión inicial', category: 'decision', priority: 0 } });
  return { anchor: memories.a.anchorSeq };
});

// Worktree para comprobar la integración.
let worktree;
await check('worktrees · crear un worktree con el sistema existente', async () => {
  worktree = await invoke('worktree_create', { projectId: project.id, request: { name: 'qa-fork', path: join(dir, '..', `${dir.split(/[\\/]/).pop()}-qa-fork`), newBranch: true, branch: 'qa-fork', base: 'HEAD' } });
  assert(worktree.id && existsSync(worktree.path));
  return { worktree: worktree.label };
});

// ---------- Proveedores reales (mínimo imprescindible) ----------
async function send(conversationId, agent, text) {
  const model = agent === 'claude' ? 'haiku' : 'gpt-6-luna';
  const effort = agent === 'claude' ? 'medium' : 'high';
  // Claude en modo manual, nunca plan: con `opusplan` el modo plan cambia el modelo elegido.
  const permissions = agent === 'claude' ? { mode: 'manual' } : { sandbox: 'read-only', approval: 'never' };
  const started = Date.now();
  const r = await invoke('send_message', { request: { conversationId, agent, model, effort, text, attachments: [], permissions } });
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const list = await messages(conversationId);
    const a = list.find((m) => m.id === r.assistantMessage.id);
    const u = list.find((m) => m.id === r.userMessage.id);
    if (a && a.status !== 'running') {
      const insights = await invoke('run_insights', { messageId: a.id });
      calls.push({ agent, model, effort, status: a.status, ms: Date.now() - started, exactModel: a.model, lastRequestModel: insights?.details?.lastRequestModel ?? null, continuity: insights?.details?.continuity ?? null, usage: a.usage && { input: a.usage.inputTokens, output: a.usage.outputTokens } });
      return { user: u, assistant: a, insights };
    }
  }
  throw new Error('El turno no terminó a tiempo');
}

function claudeFile(sessionId) {
  const root = join(homedir(), '.claude', 'projects');
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

if (REAL) {
  const turns = {};
  await check('real · 4 turnos alternos crean las sesiones nativas de origen', async () => {
    turns.alpha = await send(conv.id, 'claude', 'Reply with the single word: alpha');
    turns.gamma = await send(conv.id, 'codex', 'Reply with the single word: gamma');
    memories.b = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Objetivo B', category: 'goal', priority: 0 } });
    await invoke('memory_save', { input: { id: memories.a.id, conversationId: conv.id, content: 'Decisión editada', category: 'decision', priority: 0 } });
    turns.beta = await send(conv.id, 'claude', 'Reply with the single word: beta');
    await invoke('memory_archive', { id: memories.b.id, archived: true });
    turns.delta = await send(conv.id, 'codex', 'Reply with the single word: delta');
    for (const t of Object.values(turns)) assert.equal(t.assistant.status, 'done');
    assert(turns.alpha.insights.details.nativeAnchor, 'Claude guarda el elemento exacto del turno');
    assert(turns.gamma.insights.details.providerTurnId, 'Codex guarda el turno');
    return Object.fromEntries(Object.entries(turns).map(([k, t]) => [k, `${t.assistant.model} · ${t.assistant.content}`]));
  });

  let fork;
  await check('bifurcar en «gamma» · mensajes, memoria histórica y planes nativos exactos', async () => {
    const cut = turns.gamma.assistant;
    fork = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: cut.id, purpose: 'fork' } });
    const list = await messages(fork.id);
    assert.equal(list.length, cut.seq);
    assert.equal(list.at(-1).content, cut.content);
    assert.equal(fork.origin.native.claude.state, 'pending');
    assert.equal(fork.origin.native.claude.anchor, turns.alpha.insights.details.nativeAnchor);
    assert.equal(fork.origin.native.codex.anchor, turns.gamma.insights.details.providerTurnId);
    const at = async (message) => {
      const f = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: message.id, purpose: 'fork' } });
      const list = await invoke('memory_list', { conversationId: f.id, includeArchived: true });
      await invoke('delete_conversation', { id: f.id });
      return list.map((m) => `${m.content}${m.archived ? ' [archivado]' : ''}`).sort();
    };
    // La edición y «Objetivo B» se guardaron con la conversación en «gamma»; el archivado, en «beta».
    const mem = await invoke('memory_list', { conversationId: fork.id, includeArchived: true });
    assert.deepEqual(mem.map((m) => m.content).sort(), ['Decisión editada', 'Objetivo B']);
    assert.deepEqual(await at(turns.alpha.assistant), ['Decisión inicial']);
    assert.deepEqual(await at(turns.beta.assistant), ['Decisión editada', 'Objetivo B [archivado]']);
    assert.deepEqual(await sessions(fork.id), []);
    return { messages: list.length, memories: mem.map((m) => m.content), native: fork.origin.native };
  });

  await check('real · Claude Code continúa con una bifurcación nativa exacta (--fork-session)', async () => {
    const source = (await sessions(conv.id)).find((s) => s.agent === 'claude');
    const file = claudeFile(source.sessionId);
    const before = file && statSync(file).size;
    const r = await send(fork.id, 'claude', 'Without using tools: which single words have you replied with in this conversation so far? Answer with just those words.');
    assert.equal(r.assistant.status, 'done');
    const after = file && statSync(file).size;
    const s = (await sessions(fork.id)).find((x) => x.agent === 'claude');
    assert.notEqual(s.sessionId, source.sessionId, 'la sesión bifurcada es otra');
    assert.equal(after, before, 'la transcripción original no cambia');
    assert.equal(r.insights.details.continuity, 'forked');
    assert.match(r.assistant.content.toLowerCase(), /alpha/);
    assert.doesNotMatch(r.assistant.content.toLowerCase(), /beta/);
    assert.equal(r.assistant.model, 'claude-haiku-5-5');
    const origin = (await conversation(fork.id)).origin.native.claude;
    assert.equal(origin.state, 'native');
    return { answer: r.assistant.content, lastRequestModel: r.insights.details.lastRequestModel, note: r.user.contextNote };
  });

  await check('real · Codex continúa con thread/fork en el turno exacto', async () => {
    const source = (await sessions(conv.id)).find((s) => s.agent === 'codex');
    const r = await send(fork.id, 'codex', 'Without running commands: which single words have you replied with in this conversation so far? Answer with just those words.');
    assert.equal(r.assistant.status, 'done');
    const s = (await sessions(fork.id)).find((x) => x.agent === 'codex');
    assert.notEqual(s.sessionId, source.sessionId);
    assert.equal(r.insights.details.continuity, 'forked');
    assert.match(r.assistant.content.toLowerCase(), /gamma/);
    assert.doesNotMatch(r.assistant.content.toLowerCase(), /delta/);
    assert.equal((await conversation(fork.id)).origin.native.codex.state, 'native');
    // El hilo original sigue asociado solo a la conversación original.
    assert.equal((await sessions(conv.id)).find((x) => x.agent === 'codex').sessionId, source.sessionId);
    return { answer: r.assistant.content, model: r.assistant.model };
  });

  await check('original intacta tras bifurcar y continuar', async () => {
    const list = await messages(conv.id);
    assert.equal(list.length, 8);
    const mem = await invoke('memory_list', { conversationId: conv.id, includeArchived: true });
    assert(mem.some((m) => m.content === 'Decisión editada') && mem.some((m) => m.content === 'Objetivo B' && m.archived));
    return { messages: list.length, memories: mem.length };
  });

  await check('bifurcar hacia un worktree · Claude se reconstruye, Codex admite cwd', async () => {
    const f = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: turns.delta.assistant.id, purpose: 'fork', space: worktree.id } });
    assert.equal(f.worktreeId, worktree.id);
    assert.deepEqual([f.origin.native.claude.state, f.origin.native.claude.reason], ['rebuild', 'workdir']);
    assert.equal(f.origin.native.codex.state, 'pending');
    return { claude: f.origin.native.claude, codex: f.origin.native.codex.state };
  });

  await check('editar y regenerar · borrador sin enviar ni consumir', async () => {
    const before = calls.length;
    const edit = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: turns.beta.user.id, purpose: 'edit', text: 'Reply with the single word: epsilon' } });
    assert.equal(edit.draft, 'Reply with the single word: epsilon');
    assert.equal((await messages(edit.id)).length, turns.beta.user.seq - 1);
    const regen = await invoke('fork_conversation', { request: { conversationId: conv.id, messageId: turns.delta.assistant.id, purpose: 'regenerate' } });
    assert.equal(regen.draft, 'Reply with the single word: delta');
    assert.equal(regen.lastAgent, 'codex');
    assert.equal((await messages(regen.id)).length, turns.delta.user.seq - 1);
    assert.equal(calls.length, before);
    return { edit: edit.draft, regenerate: [regen.draft, regen.lastAgent] };
  });

  await check('importar · Codex lista el hilo de Duovra como ya presente (sin duplicar)', async () => {
    const thread = (await sessions(conv.id)).find((s) => s.agent === 'codex').sessionId;
    let page = await invoke('import_list', { target: { agent: 'codex', accountId: null }, query: '', cursor: null });
    let found = page.items.find((i) => i.sessionId === thread);
    for (let i = 0; !found && page.nextCursor && i < 5; i++) {
      page = await invoke('import_list', { target: { agent: 'codex', accountId: null }, query: '', cursor: page.nextCursor });
      found = page.items.find((x) => x.sessionId === thread);
    }
    const preview = await invoke('import_preview', { target: { agent: 'codex', accountId: null }, sessionId: thread });
    if (found) assert.equal(found.conversationId, conv.id);
    const again = await invoke('import_sessions', { target: { agent: 'codex', accountId: null }, projectId: project.id, worktreeId: null, sessions: [thread], native: true });
    assert.equal(again.created.length, 0);
    return { listed: !!found, preview: preview.messages.map((m) => `${m.role}: ${m.text}`), duplicate: again.failed[0]?.error };
  });
}

writeFileSync(join(out, 'session-manager-results.json'), JSON.stringify({ conversationId: conv.id, project: dir, real: REAL, results, calls }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones correctas · llamadas reales: ${calls.length}`);
await browser.close();
process.exit(failed ? 1 : 0);

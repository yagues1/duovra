// QA 1.0.11 · fase 2: Context Engine 2.0 sobre la app en desarrollo (perfil QA aislado).
// Requisitos: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 y
// `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json`.
//
// Uso: node scripts/qa/context-engine-webview.mjs <carpeta-salida> [--real]
// Sin --real solo hay comprobaciones locales (memoria, modos, estado, aislamiento): no invoca modelos.
// Con --real hace las llamadas mínimas con los modelos autorizados (docs/qa/test-model-policy.md):
// Claude Code haiku/medium (2 turnos, 1 resumen, 1 compactación) y Codex gpt-6-luna/high (1 turno,
// 1 compactación), en un proyecto temporal aislado y con permisos de solo lectura.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-context');
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
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 220) : '');
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 400));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Fixtures locales ----------
const dir = mkdtempSync(join(tmpdir(), 'duovra-ctx-qa-'));
writeFileSync(join(dir, 'README.md'), '# Proyecto QA del Context Engine\n');
const project = await invoke('create_project', { name: 'QA Context Engine', path: dir });
const conv = await invoke('create_conversation', { projectId: project.id, title: 'QA · Context Engine 2.0' });
const other = await invoke('create_conversation', { projectId: project.id, title: 'QA · Aislamiento' });

let pinned;
await check('crear, editar, fijar, archivar y consultar el origen de recuerdos', async () => {
  const goal = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Objetivo: validar el Context Engine 2.0', category: 'goal', priority: 0 } });
  pinned = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Restricción: responde siempre en una sola palabra en estas pruebas', category: 'constraint', priority: 1 } });
  const edited = await invoke('memory_save', { input: { id: goal.id, conversationId: conv.id, content: 'Objetivo: validar la continuidad entre agentes', category: 'goal', priority: 0 } });
  assert.equal(edited.revision, 2);
  const tmp = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Nota temporal', category: 'note', priority: 0 } });
  const archived = await invoke('memory_archive', { id: tmp.id, archived: true });
  assert(archived.archived);
  const history = await invoke('memory_history', { id: goal.id });
  assert.equal(history.revisions.length, 2);
  await invoke('memory_delete', { id: tmp.id });
  const list = await invoke('memory_list', { conversationId: conv.id, includeArchived: true });
  assert.equal(list.length, 2);
  return { memories: list.map((m) => `${m.category} r${m.revision} p${m.priority}`) };
});

await check('aislamiento entre conversaciones', async () => {
  assert.equal((await invoke('memory_list', { conversationId: other.id })).length, 0);
  await assert.rejects(invoke('memory_save', { input: { id: pinned.id, conversationId: other.id, content: 'x', category: 'note', priority: 0 } }));
  return 'sin fugas';
});

await check('una instrucción no puede venir de un agente', async () => {
  await assert.rejects(invoke('memory_import', { conversationId: conv.id, sourceMessageId: 'no-existe', items: [{ content: 'x', category: 'goal', priority: 0 }], archive: [] }));
  return 'rechazado';
});

await check('estado con datos desconocidos: sin porcentaje inventado', async () => {
  const s = await invoke('context_status', { conversationId: conv.id, agent: 'claude', includeBlock: true });
  assert.equal(s.native.hasSession, false);
  assert.equal(s.native.percent, null);
  assert.equal(s.shared.memories, 2);
  assert.equal(s.shared.next.mode, 'shared');
  assert(s.shared.block.includes('<user_instructions>') && s.shared.block.includes('una sola palabra'));
  return { next: s.shared.next.estimatedTokens, budget: s.shared.next.budgetSource };
});

await check('modos de transferencia por conversación', async () => {
  const seen = {};
  for (const mode of ['economy', 'full', 'custom', 'off', 'auto']) {
    await invoke('set_context_prefs', { conversationId: conv.id, prefs: { mode, memories: mode === 'custom' ? [pinned.id] : [], messages: [] } });
    const s = await invoke('context_status', { conversationId: conv.id, agent: 'codex' });
    seen[mode] = { mode: s.shared.next.mode, memories: s.shared.next.memories ?? 0, warnings: (s.shared.next.warnings ?? []).map((w) => w.id) };
  }
  assert.equal(seen.off.mode, 'none');
  assert(seen.off.warnings.includes('transferOff'));
  assert.equal(seen.custom.memories, 1);
  assert.equal(seen.auto.memories, 2);
  await assert.rejects(invoke('set_context_prefs', { conversationId: conv.id, prefs: { mode: 'raro' } }));
  return seen;
});

// ---------- Proveedores reales (mínimo imprescindible) ----------
async function send(agent, text, extra = {}) {
  const model = agent === 'claude' ? 'haiku' : 'gpt-6-luna';
  const effort = agent === 'claude' ? 'medium' : 'high';
  // Claude en modo manual, nunca plan: con `opusplan` en la configuración del usuario el modo plan
  // cambia el modelo y la prueba dejaría de usar el modelo autorizado.
  const permissions = agent === 'claude' ? { mode: 'manual' } : { sandbox: 'read-only', approval: 'never' };
  const started = Date.now();
  const r = await invoke('send_message', { request: { conversationId: conv.id, agent, model, effort, text, attachments: [], permissions, ...extra } });
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const { messages } = await invoke('list_messages', { conversationId: conv.id, includeSessions: false });
    const a = messages.find((m) => m.id === r.assistantMessage.id);
    const u = messages.find((m) => m.id === r.userMessage.id);
    if (a && a.status !== 'running') {
      calls.push({ agent, model, effort, kind: extra.purpose ?? 'turn', status: a.status, ms: Date.now() - started, usage: a.usage && { input: a.usage.inputTokens, output: a.usage.outputTokens, context: a.usage.contextTokens, window: a.usage.contextWindow } });
      return { user: u, assistant: a };
    }
  }
  throw new Error('El turno no terminó a tiempo');
}

async function waitCompaction(agent) {
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const s = await invoke('context_status', { conversationId: conv.id, agent });
    const c = s.native.compaction;
    if (!s.activeCompaction && c && ['completed', 'failed', 'unknown'].includes(c.state)) return s;
  }
  throw new Error('La compactación no terminó a tiempo');
}

if (REAL) {
  let a, b, c;
  await check('real · turno de Claude Code (haiku/medium) crea su sesión y confirma la entrega', async () => {
    a = await send('claude', 'Reply with the single word: alpha');
    assert.equal(a.assistant.status, 'done');
    assert.equal(a.user.contextNote.state, 'confirmed');
    assert.equal(a.user.contextNote.memories, 2);
    const s = await invoke('context_status', { conversationId: conv.id, agent: 'claude' });
    const ins = await invoke('run_insights', { messageId: a.assistant.id });
    // El modelo que atendió la petición debe ser el autorizado (no basta con el de la sesión).
    assert.equal(ins.details.lastRequestModel, 'claude-haiku-5-5', JSON.stringify(ins.details));
    assert(s.native.contextWindow > 0 && s.native.percent != null, JSON.stringify(s.native));
    return { reply: a.assistant.content, native: s.native, lastRequestModel: ins.details.lastRequestModel };
  });

  await check('real · Codex (gpt-6-luna/high) recibe el intercambio de Claude y la memoria', async () => {
    b = await send('codex', 'Reply with the single word: beta');
    const note = b.user.contextNote;
    assert.equal(b.assistant.status, 'done');
    assert.equal(note.state, 'confirmed');
    assert.equal(note.mode, 'shared');
    assert(note.messages >= 2 && note.agents.includes('claude'), JSON.stringify(note));
    assert.equal(note.memories, 2);
    const s = await invoke('context_status', { conversationId: conv.id, agent: 'codex' });
    return { reply: b.assistant.content, note: { messages: note.messages, memories: note.memories, tokens: note.estimatedTokens }, native: s.native };
  });

  await check('real · Claude solo recibe lo nuevo (Codex) y no repite la memoria ya confirmada', async () => {
    c = await send('claude', 'Reply with the single word: gamma');
    const note = c.user.contextNote;
    assert.equal(note.state, 'confirmed');
    assert.equal(note.messages, 2, JSON.stringify(note));
    assert.equal(note.memories ?? 0, 0, JSON.stringify(note));
    assert.equal(note.agents[0], 'codex');
    return { note: { messages: note.messages, memories: note.memories ?? 0 } };
  });

  await check('sin duplicados: la sesión de Claude está al día', async () => {
    const s = await invoke('context_status', { conversationId: conv.id, agent: 'claude' });
    assert.equal(s.shared.next.mode, 'none', JSON.stringify(s.shared.next));
    return { pending: s.shared.next.pendingMessages };
  });

  await check('una revisión nueva de un recuerdo llega a la sesión que tenía la anterior', async () => {
    await invoke('memory_save', { input: { id: pinned.id, conversationId: conv.id, content: 'Restricción: responde siempre en una sola palabra, en minúsculas', category: 'constraint', priority: 1 } });
    const s = await invoke('context_status', { conversationId: conv.id, agent: 'claude', includeBlock: true });
    assert.equal(s.shared.next.memoriesUpdated, 1);
    assert(s.shared.block.includes('updated'));
    return { next: s.shared.next.memories };
  });

  await check('real · resumen explícito en solo lectura con propuesta estructurada (haiku/medium)', async () => {
    const text = 'Duovra · Propuesta de memoria compartida (solo lectura)\n\nRead-only task: do not run commands, edit files or use tools. Reply with one short sentence and then exactly one fenced block:\n\n```duovra-memory\n{"memories":[{"category":"goal","content":"…","priority":0}]}\n```\n\nAt most 3 items.';
    const r = await send('claude', text, { purpose: 'memorySummary' });
    assert.equal(r.user.contextNote.purpose, 'memorySummary');
    const ins = await invoke('run_insights', { messageId: r.assistant.id });
    assert.equal(ins.details.lastRequestModel, 'claude-haiku-5-5', JSON.stringify(ins.details));
    const block = /```duovra-memory\s*\n([\s\S]*?)```/.exec(r.assistant.content);
    assert(block, 'sin bloque duovra-memory');
    const parsed = JSON.parse(block[1]);
    assert(Array.isArray(parsed.memories) && parsed.memories.length > 0);
    // La memoria no cambia hasta que el usuario aprueba.
    assert.equal((await invoke('memory_list', { conversationId: conv.id, includeArchived: false })).length, 2);
    return { items: parsed.memories.length, categories: parsed.memories.map((m) => m.category) };
  });

  await check('real · compactación nativa de Claude Code (/compact por stream-json)', async () => {
    await invoke('compact_native', { conversationId: conv.id, agent: 'claude' });
    const s = await waitCompaction('claude');
    calls.push({ agent: 'claude', model: 'haiku', kind: 'compact', status: s.native.compaction.state });
    assert.equal(s.native.compaction.state, 'completed', JSON.stringify(s.native.compaction));
    // La compactación invalida las entregas de memoria de esa sesión: se reenviarán.
    assert((s.shared.next.memories ?? 0) >= 1, JSON.stringify(s.shared.next));
    return { compaction: s.native.compaction, tokens: s.native.contextTokens, percent: s.native.percent };
  });

  await check('real · compactación nativa de Codex (thread/compact/start)', async () => {
    await invoke('compact_native', { conversationId: conv.id, agent: 'codex' });
    const s = await waitCompaction('codex');
    calls.push({ agent: 'codex', model: 'gpt-6-luna', kind: 'compact', status: s.native.compaction.state });
    assert.equal(s.native.compaction.state, 'completed', JSON.stringify(s.native.compaction));
    assert.equal(s.native.percent, null, 'Codex no comunica la ocupación tras compactar');
    return { compaction: s.native.compaction };
  });

  await check('la compactación no toca el historial visible ni la otra sesión', async () => {
    const { messages } = await invoke('list_messages', { conversationId: conv.id, includeSessions: false });
    assert.equal(messages.length, 8);
    const claude = await invoke('context_status', { conversationId: conv.id, agent: 'claude' });
    assert.equal(claude.native.compaction.state, 'completed');
    return { messages: messages.length };
  });
}

writeFileSync(join(out, 'context-engine-results.json'), JSON.stringify({ conversationId: conv.id, project: dir, real: REAL, results, calls }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones correctas · llamadas reales: ${calls.length}`);
console.log(JSON.stringify(calls, null, 1));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

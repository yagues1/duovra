// QA 1.0.11 · fase 1: registro de capacidades y selector de modelos sobre la app en desarrollo.
// Requisitos: `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json` con
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 (perfil QA aislado).
// Solo consultas sin coste: initialize, model/list, account/read, sondeo de métodos y esquema.
// No envía ningún mensaje a ningún modelo.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11');
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const results = [];
const check = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 160) : '');
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 300));
  }
};

const reports = {};
await check('detección de ambas instalaciones', async () => {
  const d = await invoke('detect_agents');
  assert(d.every((x) => x.installed && x.working), JSON.stringify(d));
  return d.map((x) => `${x.agent} ${x.version}`);
});

for (const agent of ['claude', 'codex']) {
  await check(`catálogo real · ${agent}`, async () => {
    const c = await invoke('agent_models', { agent, refresh: false });
    assert(c.models.length > 0);
    assert.equal(c.stale, false);
    assert(!('extras' in c), 'el catálogo público no lleva extras');
    const efforts = c.models.filter((m) => m.efforts.length).length;
    const fast = c.models.filter((m) => m.fast).map((m) => m.id);
    const aliases = c.models.filter((m) => m.alias).map((m) => `${m.id}→${m.exact}`);
    return { version: c.version, models: c.models.length, withEfforts: efforts, fast, aliases };
  });
  await check(`caché sin nueva consulta · ${agent}`, async () => {
    const a = await invoke('agent_models', { agent, refresh: false });
    const b = await invoke('agent_models', { agent, refresh: false });
    assert.equal(a.checkedAt, b.checkedAt);
    return { checkedAt: a.checkedAt };
  });
  await check(`actualización manual deduplicada · ${agent}`, async () => {
    const before = (await invoke('agent_models', { agent })).checkedAt;
    const [x, y] = await Promise.all([invoke('agent_models', { agent, refresh: true }), invoke('agent_models', { agent, refresh: true })]);
    assert(x.checkedAt > before);
    assert.equal(x.checkedAt, y.checkedAt, 'dos actualizaciones simultáneas comparten una sola consulta');
    return { before, after: x.checkedAt };
  });
  await check(`informe de capacidades · ${agent}`, async () => {
    const r = await invoke('agent_capabilities', { agent, refresh: false });
    assert.equal(r.capabilities.length, 18);
    assert(r.capabilities.every((c) => ['supported', 'unsupported', 'experimental', 'unknown'].includes(c.status)));
    reports[agent] = r;
    const by = (s) => r.capabilities.filter((c) => c.status === s).map((c) => c.id);
    return { version: r.installation.version, auth: r.installation.auth.state, supported: by('supported').length, experimental: by('experimental'), unknown: by('unknown'), unsupported: by('unsupported') };
  });
}

await check('cambio de cuenta caduca la caché', async () => {
  const before = (await invoke('agent_models', { agent: 'claude' })).checkedAt;
  await invoke('set_setting', { key: 'accounts.active.claude', value: '' });
  const after = (await invoke('agent_models', { agent: 'claude' })).checkedAt;
  assert(after > before);
  return { before, after };
});

await check('ejecutable que falla: últimos datos válidos marcados como desactualizados', async () => {
  // where.exe existe pero no es Claude Code: initialize no responde y el registro cae al último dato.
  await invoke('set_setting', { key: 'agents.claude.path', value: 'C:\\Windows\\System32\\where.exe' });
  try {
    const c = await invoke('agent_models', { agent: 'claude' });
    assert.equal(c.stale, true);
    assert(c.staleReason);
    assert(c.models.length > 0);
    const r = await invoke('agent_capabilities', { agent: 'claude' });
    assert.equal(r.stale, true);
    assert.equal(r.installation.available, false);
    return { staleReason: c.staleReason, reportError: r.error };
  } finally {
    await invoke('set_setting', { key: 'agents.claude.path', value: '' });
  }
});

await check('tras restaurar el ejecutable vuelve a datos confirmados', async () => {
  const c = await invoke('agent_models', { agent: 'claude' });
  assert.equal(c.stale, false);
  return { checkedAt: c.checkedAt };
});

// Interfaz: selector de modelos y vista de Ajustes.
await page.reload();
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
await page.waitForTimeout(1500);
const dir = mkdtempSync(join(tmpdir(), 'duovra-qa-proj-'));
const project = await invoke('create_project', { name: 'QA 1.0.11', path: dir });
const conv = await invoke('create_conversation', { projectId: project.id, title: 'Selector de modelos · QA' });
await invoke('set_conversation_prefs', { conversationId: conv.id, agent: 'claude', model: 'opus', effort: 'medium' });
const retired = await invoke('create_conversation', { projectId: project.id, title: 'Modelo retirado · QA' });
await invoke('set_conversation_prefs', { conversationId: retired.id, agent: 'codex', model: 'gpt-retired-qa', effort: 'high' });
await page.reload();
await page.waitForTimeout(2500);
writeFileSync(join(out, 'ids.json'), JSON.stringify({ project: project.id, conv: conv.id, retired: retired.id }, null, 2));
writeFileSync(join(out, 'reports.json'), JSON.stringify(reports, null, 2));
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones OK · ${out}`);
await browser.close();

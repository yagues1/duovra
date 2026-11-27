// QA 1.0.11 · refinamiento de la fase 2: preferencias globales de contexto, modo por conversación,
// retirada al eliminar recuerdos y capturas de la interfaz simplificada. No invoca ningún modelo.
// Requisitos: app QA aislada con CDP en 9333 (ver context-engine-webview.mjs).
// Uso: node scripts/qa/context-settings-webview.mjs <carpeta-salida>
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-context-settings');
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 220) : '');
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 400));
  }
};
const status = (id, agent = 'codex') => invoke('context_status', { conversationId: id, agent });

const dir = mkdtempSync(join(tmpdir(), 'duovra-ctx-settings-'));
const project = await invoke('create_project', { name: 'QA Ajustes de contexto', path: dir });
const conv = await invoke('create_conversation', { projectId: project.id, title: 'QA · Preferencias' });
await invoke('memory_save', { input: { conversationId: conv.id, content: 'Restricción de prueba', category: 'constraint', priority: 1 } });
const before = Object.fromEntries(['context.enabled', 'context.mode', 'context.resendAfterCompaction']
  .map((k) => [k, null]));

await check('sin modo propio, la conversación sigue el ajuste global', async () => {
  await invoke('set_setting', { key: 'context.mode', value: 'economy' });
  const s = await status(conv.id);
  assert.equal(s.shared.prefs.mode, 'economy');
  assert.equal(s.shared.override, false);
  return s.shared.prefs.mode;
});

await check('desactivar el contexto compartido apaga la transferencia global', async () => {
  await invoke('set_setting', { key: 'context.enabled', value: false });
  const s = await status(conv.id);
  assert.equal(s.shared.prefs.mode, 'off');
  assert.equal(s.shared.next.mode, 'none');
  await invoke('set_setting', { key: 'context.enabled', value: true });
  return 'off';
});

await check('un modo propio prevalece y se puede devolver al global sin perder datos', async () => {
  await invoke('set_context_prefs', { conversationId: conv.id, prefs: { mode: 'custom', memories: ['m-antigua'], messages: ['x'] } });
  await invoke('set_context_prefs', { conversationId: conv.id, prefs: { mode: 'full' } });
  let s = await status(conv.id);
  assert.equal(s.shared.prefs.mode, 'full');
  assert.equal(s.shared.override, true);
  // Las elecciones del antiguo modo personalizado se conservan.
  assert.deepEqual(s.shared.prefs.memories, ['m-antigua']);
  await invoke('set_context_prefs', { conversationId: conv.id, prefs: { mode: null } });
  s = await status(conv.id);
  assert.equal(s.shared.override, false);
  assert.equal(s.shared.prefs.mode, 'economy');
  assert.deepEqual(s.shared.prefs.messages, ['x']);
  return 'global';
});

await check('un valor global no admitido vuelve a automático', async () => {
  await invoke('set_setting', { key: 'context.mode', value: 'custom' });
  assert.equal((await status(conv.id)).shared.prefs.mode, 'auto');
  return 'auto';
});

await check('eliminar un recuerdo nunca entregado lo borra del todo', async () => {
  const m = await invoke('memory_save', { input: { conversationId: conv.id, content: 'Temporal', category: 'note', priority: 0 } });
  await invoke('memory_delete', { id: m.id });
  const list = await invoke('memory_list', { conversationId: conv.id, includeArchived: true });
  assert(!list.some((x) => x.id === m.id));
  return list.length;
});

for (const [k] of Object.entries(before)) await invoke('set_setting', { key: k, value: k === 'context.mode' ? 'auto' : true });

// ---------- Capturas ----------
await invoke('set_setting', { key: 'ui.lastProjectId', value: project.id });
await page.reload();
await page.waitForTimeout(2500);
const shot = (name) => page.screenshot({ path: join(out, name) });
const conversations = await invoke('bootstrap');
const target = conversations.conversations.find((c) => c.title === 'QA · Context Engine 2.0');
if (target) {
  await invoke('set_setting', { key: 'ui.lastProjectId', value: target.projectId });
  await invoke('set_setting', { key: 'ui.lastConversationId', value: target.id });
  await page.reload();
  await page.waitForTimeout(2500);
}
await page.evaluate(() => window.getSelection()?.removeAllRanges());
await page.locator('.ctx-btn').click();
await page.waitForTimeout(500);
await shot('10-popover.png');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByText('Ajustes', { exact: true }).click();
await page.waitForTimeout(700);
await page.getByRole('tab', { name: 'Contexto y memoria' }).click();
await page.waitForTimeout(700);
await shot('11-ajustes.png');
await page.getByRole('button', { name: 'Gestionar memoria' }).click();
await page.waitForTimeout(800);
await shot('12-memoria.png');

writeFileSync(join(out, 'context-settings-results.json'), JSON.stringify({ results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones correctas · llamadas a modelos: 0`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

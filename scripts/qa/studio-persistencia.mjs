#!/usr/bin/env node
// Verifica WebView2, IPC, título automático y SQLite con un App Server local sin red.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const endpoint = process.env.STUDIO_QA_CDP ?? 'http://127.0.0.1:9355';
const out = resolve(process.argv[2] ?? 'output/qa/studio');
const restart = process.argv.includes('--reinicio');
const resultFile = resolve(out, 'persistencia.json');
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0].pages().find((tab) => new URL(tab.url()).hostname === 'tauri.localhost');
assert(page, 'Arranca el ejecutable QA antes de probar persistencia');
const invoke = (cmd, args = {}) => page.evaluate(([name, payload]) => window.__TAURI_INTERNALS__.invoke(name, payload), [cmd, args]);
const dataDir = await invoke('plugin:path|resolve_directory', { directory: 14 });
assert.match(dataDir, /dev[.]duovra[.]studio[.]qa$/i, 'La base de datos debe estar aislada');
const sqlite = resolve(dataDir, 'studio.sqlite3');
const setSetting = (key, value) => invoke('set_setting', { key, value });
const go = async () => {
  await page.goto(new URL('/?persistencia=1', page.url()).href);
  await page.getByRole('textbox', { name: 'Mensaje' }).waitFor();
};
const saved = async (id) => (await invoke('bootstrap')).conversations.find((entry) => entry.id === id);
const history = async (id) => (await invoke('list_messages', { conversationId: id })).messages;
const waitFor = async (query, message) => {
  for (let i = 0; i < 80; i++) {
    const value = await query();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 125));
  }
  assert.fail(message);
};
const exerciseReadback = async ({ conversationId, title, draft, manualId, runStatuses, directory }) => {
  await go();
  const input = page.getByRole('textbox', { name: 'Mensaje' });
  await page.waitForFunction((want) => document.querySelector('.composer-input')?.value === want, draft);
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('.tree-conv').filter({ hasText: title }).waitFor();
  assert.match(await page.locator('.agent-btn').getAttribute('aria-label'), /Claude Code/);
  await page.waitForFunction(() => document.querySelector('.model-btn')?.textContent?.includes('Haiku'));
  const restored = await saved(conversationId);
  assert.equal(restored.draft, draft);
  assert.equal(restored.lastAgent, 'claude');
  assert.equal(restored.agentPrefs.claude.model, 'haiku');
  assert.equal(restored.agentPrefs.codex.model, 'gpt-6-luna');
  assert.equal((await saved(manualId)).title, 'Nueva conversación');
  const messages = await history(conversationId);
  assert.deepEqual(messages.filter((m) => m.role === 'assistant').map((m) => m.status), runStatuses);
  assert.match(messages[1].content, /proveedor local de QA/);
  const local = await invoke('read_file', { args: { path: 'math.js', root: directory } });
  assert.match(local.content, /export const resta/);
  assert(existsSync(sqlite));
  return { restored, count: messages.length, file: local.path };
};

try {
  if (restart) {
    const previous = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.equal(previous.dataDir, dataDir);
    assert(await saved(previous.conversationId));
    await exerciseReadback(previous);
    writeFileSync(resultFile, JSON.stringify({ ...previous, restart: true }, null, 2));
    console.log('PASS proceso reiniciado: título, historial, borrador y preferencias desde SQLite');
  } else {
    const directory = resolve(out, 'proyecto-' + randomUUID());
    mkdirSync(directory, { recursive: true });
    const attachment = resolve(directory, 'math.js');
    writeFileSync(attachment, 'export const resta = (a, b) => a - b;\n');
    copyFileSync(new URL('./studio-codex-fixture.mjs', import.meta.url), resolve(directory, 'codex-qa.mjs'));
    const fake = resolve(directory, 'codex-qa.cmd');
    writeFileSync(fake, '@echo off\r\n"' + process.execPath + '" "%~dp0codex-qa.mjs" %*\r\n');
    const override = 'agents.codex.path';
    const original = (await invoke('bootstrap')).settings[override] ?? null;
    const project = await invoke('create_project', { name: 'Proyecto de comprobación', path: directory });
    const conversation = await invoke('create_conversation', { projectId: project.id, title: null });
    const manual = await invoke('create_conversation', { projectId: project.id, title: null });
    assert.equal(conversation.title, 'Nueva conversación');
    await invoke('rename_conversation', { id: manual.id, title: 'Nueva conversación' });
    const send = (id, text, attachments = []) => invoke('send_message', {
      request: { conversationId: id, text, attachments, agent: 'codex', model: 'gpt-6-luna', effort: 'high' },
    });
    const end = (id, reply, status) => waitFor(async () => (await history(id))
      .find((m) => m.id === reply.assistantMessage.id && m.status === status), 'El turno local no llegó a ' + status);
    try {
      await setSetting(override, fake);
      assert.equal((await invoke('bootstrap')).settings[override], fake);
      assert(existsSync(fake), 'La CLI simulada debe existir antes de enviar');

      const first = await send(conversation.id, '', [attachment]);
      assert.equal(first.renamedTitle, 'math.js');
      assert.equal(first.userMessage.attachments[0].name, 'math.js');
      await end(conversation.id, first, 'done');
      const next = await send(conversation.id, 'Espera la cancelación de QA');
      assert.equal(next.renamedTitle, null);
      await invoke('cancel_run', { runId: next.runId });
      await end(conversation.id, next, 'interrupted');

      const named = await send(manual.id, 'Este título ya lo eligió el usuario.\nSegunda línea.');
      assert.equal(named.renamedTitle, null);
      await end(manual.id, named, 'done');
      const automatic = await invoke('create_conversation', { projectId: project.id, title: null });
      const fromText = await send(automatic.id, '\n   Revisa la caché \nSegunda línea.');
      assert.equal(fromText.renamedTitle, 'Revisa la caché');
      await end(automatic.id, fromText, 'done');
    } finally {
      await setSetting(override, original);
    }

    const conversationId = conversation.id;
    const draft = 'Borrador nativo de comprobación\nSegunda línea';
    await invoke('set_conversation_prefs', { conversationId, agent: 'codex', model: 'gpt-6-luna', effort: 'high' });
    await invoke('set_conversation_prefs', { conversationId, agent: 'claude', model: 'haiku', effort: 'medium' });
    await setSetting('ui.lastProjectId', project.id);
    await setSetting('ui.lastConversationId', conversationId);
    await go();
    await page.getByRole('textbox', { name: 'Mensaje' }).fill(draft);
    await waitFor(async () => (await saved(conversationId)).draft === draft, 'El borrador no se guardó');
    const title = 'math.js';
    const result = { dataDir, sqlite, directory, conversationId, manualId: manual.id, title, draft,
      runStatuses: ['done', 'interrupted'], restart: false };
    const { restored, count, file } = await exerciseReadback(result);
    writeFileSync(resultFile, JSON.stringify({ ...result, agents: restored.agentPrefs, messages: count, readFile: file }, null, 2));
    console.log('PASS WebView2 / IPC / SQLite: títulos, envío local, cancelación, adjunto, historial, borrador y preferencias');
  }
} finally {
  await browser.close();
}

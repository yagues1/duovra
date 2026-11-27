// QA 1.0.11 · fase 4: UNA prueba real del modo plan de Claude Code desde Duovra (perfil QA aislado).
// Política de pruebas: Claude Code Haiku 5.5 (`haiku` → `claude-haiku-5-5`) / Medio, un turno breve en el
// proyecto temporal de QA, con la cuenta y la configuración reales del usuario (incluido `opusplan`).
// Comprueba qué modelo atendió de verdad cada petición y rechaza el plan: no se implementa nada.
//
// Uso: node scripts/qa/planning-real-claude.mjs <carpeta-salida>
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { steps: [] };
const log = (step, data) => { report.steps.push({ step, ...data }); console.log(step, JSON.stringify(data).slice(0, 400)); };

const boot = await invoke('bootstrap');
const project = boot.projects.find((p) => p.name === 'QA · Planning & Decisions (datos de prueba)');
const previous = boot.settings['accounts.active.claude'] ?? null;
// Cuenta real del usuario: el perfil de la CLI (sin carpeta de configuración propia).
await invoke('set_setting', { key: 'accounts.active.claude', value: null });
try {
  const catalog = await invoke('agent_models', { agent: 'claude', refresh: true });
  const haiku = catalog.models.find((m) => m.id === 'haiku');
  assert.equal(haiku?.exact, 'claude-haiku-5-5');
  log('catálogo', { haiku: haiku.exact, efforts: haiku.efforts });

  const conv = await invoke('create_conversation', { projectId: project.id, title: 'QA · Prueba real · plan de Claude Code (Haiku)' });
  await invoke('set_draft', { conversationId: conv.id, draft: 'qa' });
  await invoke('set_conversation_work_mode', { conversationId: conv.id, agent: 'claude', mode: 'plan' });
  const started = await invoke('submit_message', { id: crypto.randomUUID(), accountId: null, request: {
    conversationId: conv.id, agent: 'claude', model: 'haiku', effort: 'medium', attachments: [], speed: null,
    permissions: { mode: 'manual' }, workMode: 'plan',
    text: 'Propón un plan de un solo paso para añadir la línea "Hola" al final de README.md. No hagas cambios: presenta el plan con ExitPlanMode.',
  } });
  const messageId = started.started.assistantMessage.id;
  log('enviado', { runId: started.started.runId });

  let plan = null;
  let finished = false;
  for (let i = 0; i < 360 && !plan && !finished; i++) {
    await sleep(500);
    plan = (await invoke('list_interactions', { conversationId: conv.id })).find((x) => x.kind === 'plan' && x.status === 'pending') ?? null;
    finished = (await invoke('list_messages', { conversationId: conv.id, includeSessions: false })).messages.every((m) => m.status !== 'running');
  }
  if (plan) {
    log('plan recibido', { version: plan.version, native: plan.native, title: plan.payload.title, text: plan.payload.text.slice(0, 300) });
    await invoke('decide_plan', { interactionId: plan.id, action: 'reject', feedback: null, request: null });
    log('plan rechazado', {});
  } else {
    log('sin plan nativo', { finished });
  }
  for (let i = 0; i < 120; i++) {
    const list = (await invoke('list_messages', { conversationId: conv.id, includeSessions: false })).messages;
    if (list.every((m) => m.status !== 'running')) break;
    await sleep(500);
  }
  const message = (await invoke('list_messages', { conversationId: conv.id, includeSessions: false })).messages.find((m) => m.id === messageId);
  const insights = await invoke('run_insights', { messageId });
  const d = insights?.details ?? {};
  log('resultado', {
    status: message.status, model: message.model, requestedModel: d.requestedModel, sessionModel: d.sessionModel,
    lastRequestModel: d.lastRequestModel, modelChanged: d.modelChanged ?? null, workMode: d.workMode,
    notices: (message.items ?? []).filter((x) => x.kind === 'notice').map((x) => x.text),
    tools: (message.items ?? []).filter((x) => x.tool).map((x) => `${x.tool}:${x.status}`),
    interactions: (await invoke('list_interactions', { conversationId: conv.id })).map((x) => `${x.kind} v${x.version} ${x.status}`),
  });
} finally {
  await invoke('set_setting', { key: 'accounts.active.claude', value: previous });
  writeFileSync(join(out, 'planning-real-claude.json'), JSON.stringify(report, null, 2));
  await browser.close();
}

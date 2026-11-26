// QA 1.0.11 · fase 4: tras reiniciar Duovra, las solicitudes nativas que ya no existen quedan
// interrumpidas; los planes sin solicitud nativa (Codex) siguen pendientes. Después deja una pregunta y
// un plan vivos como datos de prueba para revisar la interfaz. Requiere las APIs simuladas y las cuentas
// QA de `planning-webview.mjs`.
//
// Uso: node scripts/qa/planning-restart-check.mjs <carpeta-qa>
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const qa = process.argv[2];
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 260) : '');
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 400));
  }
};
const boot = await invoke('bootstrap');
const project = boot.projects.find((p) => p.name === 'QA · Planning & Decisions (datos de prueba)');
const byTitle = (t) => boot.conversations.find((c) => c.projectId === project.id && c.title === t && !c.origin?.kind);
const all = async (title) => invoke('list_interactions', { conversationId: byTitle(title).id });

await check('reinicio: la pregunta nativa pendiente pasa a interrumpida y no admite respuesta', async () => {
  const q = (await all('QA · Pregunta pendiente B'))[0];
  assert.equal(q.status, 'interrupted');
  assert.equal(q.native, false);
  await assert.rejects(invoke('answer_question', { interactionId: q.id, answers: [{ selected: ['Postgres'] }, { selected: ['Build'] }] }));
  return { status: q.status };
});
await check('reinicio: el plan de Claude interrumpido conserva su versión y sigue admitiendo decisión', async () => {
  const p = (await all('QA · Plan largo de Claude Code (pendiente)'))[0];
  assert.equal(p.status, 'interrupted');
  return { status: p.status, version: p.version };
});
await check('reinicio: el plan de Codex (sin solicitud nativa) sigue pendiente', async () => {
  const p = (await all('QA · Plan de Codex pendiente (bifurcable)'))[0];
  assert.equal(p.status, 'pending');
  const pending = await invoke('pending_interactions');
  assert(pending.some((x) => x.conversationId === byTitle('QA · Plan de Codex pendiente (bifurcable)').id));
  return { pending: pending.length };
});

// Datos de prueba vivos para la revisión visual.
const accounts = Object.fromEntries(['claude', 'codex'].map((a) => [a, boot.accounts.find((x) => x.agent === a && x.label.startsWith('QA simulada'))?.id]));
const demo = await invoke('create_conversation', { projectId: project.id, title: 'QA · Preguntas pendientes (demo)' });
await invoke('set_draft', { conversationId: demo.id, draft: 'qa' });
await invoke('submit_message', { id: crypto.randomUUID(), accountId: accounts.claude, request: {
  conversationId: demo.id, agent: 'claude', model: 'haiku', effort: 'medium', text: 'QA-WAIT Datos de prueba: pregunta pendiente para revisar la tarjeta.',
  attachments: [], speed: null, permissions: { mode: 'manual' }, workMode: 'build' } });
const plan = await invoke('create_conversation', { projectId: project.id, title: 'QA · Plan pendiente de Claude Code (demo)' });
await invoke('set_draft', { conversationId: plan.id, draft: 'qa' });
await invoke('set_conversation_work_mode', { conversationId: plan.id, agent: 'claude', mode: 'plan' });
await invoke('submit_message', { id: crypto.randomUUID(), accountId: accounts.claude, request: {
  conversationId: plan.id, agent: 'claude', model: 'haiku', effort: 'medium', text: 'QA-LONGPLAN Datos de prueba: plan largo para revisar la tarjeta.',
  attachments: [], speed: null, permissions: { mode: 'manual' }, workMode: 'plan' } });
for (let i = 0; i < 120; i++) {
  const ready = (await invoke('pending_interactions')).filter((p) => [demo.id, plan.id].includes(p.conversationId)).length === 2;
  if (ready) break;
  await sleep(250);
}
await check('datos de prueba vivos para la revisión', async () => {
  const pending = (await invoke('pending_interactions')).filter((p) => [demo.id, plan.id].includes(p.conversationId));
  assert.equal(pending.length, 2);
  return { demo: demo.id, plan: plan.id };
});
writeFileSync(join(qa, 'report', 'planning-restart.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} comprobaciones`);
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

// Comprobación manual del aviso nativo de Windows. Solo habla con la instalación QA (CDP en 127.0.0.1:19333).
//   node scripts/qa/notification-tap.mjs enviar "Título de una conversación QA"
//   (pulsa el aviso de Windows mientras esté visible)
//   node scripts/qa/notification-tap.mjs comprobar
// «enviar» usa el mismo comando nativo que los avisos de agentes (notify_native) con un aviso de prueba.
// «comprobar» verifica que Duovra abrió esa conversación y que no empezaron ejecuciones nuevas.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, title] = process.argv.slice(2);
const usage = 'Uso: node scripts/qa/notification-tap.mjs enviar "Título" | comprobar';
if (!['enviar', 'comprobar'].includes(command) || (command === 'enviar' && !title)) {
  console.error(usage);
  process.exit(2);
}

const stateDir = resolve('output/qa/manual-1.0.2');
const statePath = resolve(stateDir, 'notification-tap.json');
const endpoint = 'http://127.0.0.1:19333';

const browser = await chromium.connectOverCDP(endpoint).catch(() => {
  console.error(`No hay ninguna instalación QA escuchando en ${endpoint}. Ábrela primero (ver docs/qa/manual-1.0.2.md).`);
  process.exit(1);
});
const page = browser.contexts()[0]?.pages()[0];
if (!page) {
  console.error('No se encontró la ventana de la instalación QA.');
  process.exit(1);
}
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const snapshot = await invoke('bootstrap');

if (command === 'enviar') {
  const conversation = snapshot.conversations.find((c) => c.title === title);
  if (!conversation) {
    console.error(`No hay ninguna conversación titulada «${title}» en el perfil QA.`);
    process.exit(1);
  }
  const runs = snapshot.activeRuns.length;
  const key = `manual-1.0.2:${Date.now()}`;
  const shown = await invoke('notify_native', {
    notice: { kind: 'finished', key, conversationId: conversation.id, title, agent: 'codex' },
  });
  if (!shown) {
    console.error('Windows no mostró el aviso. Revisa «Notificaciones de Windows» en Ajustes → Actualizaciones y avisos.');
    process.exit(1);
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ conversationId: conversation.id, title, runs, key, sentAt: new Date().toISOString() }, null, 2));
  console.log('Aviso de prueba enviado. Pulsa la notificación de Windows mientras esté visible.');
  console.log('Después ejecuta: node scripts/qa/notification-tap.mjs comprobar');
  process.exit(0);
}

// comprobar
if (!existsSync(statePath)) {
  console.error('Primero envía el aviso con: node scripts/qa/notification-tap.mjs enviar "Título"');
  process.exit(1);
}
const expected = JSON.parse(readFileSync(statePath, 'utf8'));
const openId = snapshot.settings['ui.lastConversationId'];
const runsNow = snapshot.activeRuns.length;
const results = [
  [`Conversación abierta: «${expected.title}»`, openId === expected.conversationId],
  ['Sin ejecuciones nuevas tras el aviso', runsNow <= expected.runs],
];
for (const [label, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

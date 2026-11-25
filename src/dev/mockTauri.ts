// Arnés de desarrollo para revisar la interfaz en un navegador normal (vite dev, sin Tauri).
// Solo se carga con `import.meta.env.DEV` y fuera de Tauri (ver main.tsx): nunca forma parte de
// la compilación de producción. NO sustituye a las pruebas con los agentes reales; sirve para
// comprobar distribución, materiales y estados de la interfaz a distintos tamaños.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { invoke } from '@tauri-apps/api/core';
import { emitFixture, installFixtureTransport } from '../lib/tauriTransport';
import claudeRaw from '../test/fixtures/claude-catalog-2.1.316.json';

const QS = new URLSearchParams(location.search);
const now = Date.now();
const P = 'C:\\Users\\Demo\\Proyectos\\Demo';
const conv = (id: string, title: string, mins: number, agent: string | null, model: string | null, effort: string | null) => ({
  id, projectId: 'p1', title, createdAt: now - mins * 60000, updatedAt: now - mins * 60000,
  lastAgent: agent, lastModel: model, lastEffort: effort, draft: '',
  agentPrefs: agent ? { claude: { model: 'haiku', effort: 'medium' }, codex: { model: 'gpt-6-luna', effort: 'high' } } : {},
});

const DIFF = `--- a/math.js
+++ b/math.js
@@ -1,3 +1,7 @@
 export function suma(a, b) {
   return a + b;
 }
+
+export function resta(a, b) {
+  return a - b;
+}`;

const LONG = Array.from({ length: 6 }, (_, i) => `${i + 1}. Párrafo de prueba con **texto denso** para comprobar que nada se lee debajo del compositor al hacer scroll. Incluye \`código en línea\` y enlaces.`).join('\n\n');

const CMD = `node -e "import('./math.js').then(m => console.log(m.resta(5, 3)))"`;
const CODEX_TEXT = `Confirmado. La función está correctamente implementada y el resultado es 2.

${LONG}

\`\`\`js
export function resta(a, b) {
  return a - b;
}
\`\`\``;

// Turno de Codex con la forma real de App Server: notas `commentary`, razonamientos sin resumen,
// lecturas clasificadas por `commandActions`, comandos y una edición.
const CODEX_ITEMS = [
  { id: 'k0', kind: 'reasoning', status: 'completed', text: '' },
  { id: 'k1', kind: 'text', status: 'completed', phase: 'commentary', text: 'Reviso `math.js` y ejecuto la función para confirmar el resultado.' },
  { id: 'k2', kind: 'command', status: 'completed', command: 'Get-Content math.js', output: 'export function suma(a, b) {…}', exitCode: 0, durationMs: 180, cwd: P, actions: [{ type: 'read', name: 'math.js', path: `${P}\math.js` }] },
  { id: 'k3', kind: 'reasoning', status: 'completed', text: '' },
  { id: 'k4', kind: 'command', status: 'completed', command: 'rg -n "resta" .', output: 'math.js:5:export function resta(a, b) {', exitCode: 0, durationMs: 95, cwd: P, actions: [{ type: 'search', query: 'resta' }] },
  { id: 'k5', kind: 'reasoning', status: 'completed', text: '**Comprobación de la exportación**\n\nLa función está exportada; falta confirmar el resultado con Node.' },
  { id: 'k6', kind: 'command', status: 'completed', command: CMD, output: '2', exitCode: 0, durationMs: 420, cwd: P },
  { id: 'k7', kind: 'reasoning', status: 'completed', text: '' },
  { id: 'k8', kind: 'text', status: 'completed', phase: 'commentary', text: 'Añado un comentario de documentación a la función.' },
  { id: 'k9', kind: 'file_change', status: 'completed', changes: [{ path: `${P}\math.js`, kind: 'update', diff: DIFF }] },
  { id: 'k10', kind: 'reasoning', status: 'completed', text: '' },
  { id: 'k11', kind: 'command', status: 'completed', command: 'npm test', output: '✓ 4 tests', exitCode: 0, durationMs: 2300, cwd: P },
  { id: 'k12', kind: 'text', status: 'completed', phase: 'final_answer', text: CODEX_TEXT },
];

const messages = [
  { id: 'm1', conversationId: 'c1', seq: 1, role: 'user', agent: 'claude', model: null, effort: null, content: 'Añade una función resta(a, b) en math.js, ejecuta node para comprobarla y dime en una frase qué hiciste.', items: null, status: 'done', error: null, usage: null, contextNote: null, attachments: null, createdAt: now - 600000, completedAt: null },
  { id: 'm2', conversationId: 'c1', seq: 2, role: 'assistant', agent: 'claude', model: 'claude-haiku-5-5', effort: 'medium', content: 'Añadí la función `resta(a, b)` en `math.js`, la exporté y el comando devolvió **2**.', status: 'done', error: null,
    items: [
      { id: 'i1', kind: 'text', status: 'completed', text: 'Revisaré math.js, añadiré resta(a, b) y ejecutaré la comprobación.' },
      { id: 'i2', kind: 'file_change', status: 'completed', changes: [{ path: `${P}\\math.js`, kind: 'update', diff: DIFF }] },
      { id: 'i3', kind: 'command', status: 'completed', command: 'node -e "import(\'./math.js\').then(m => console.log(m.resta(5, 3)))"', output: '2\n', exitCode: 0, durationMs: 420, cwd: P },
      { id: 'i4', kind: 'text', status: 'completed', text: 'Añadí la función `resta(a, b)` en `math.js`, la exporté y el comando devolvió **2**.' },
    ],
    usage: { inputTokens: 5400, outputTokens: 220, costUsd: 0.004, durationMs: 9100 }, contextNote: null, attachments: null, createdAt: now - 590000, completedAt: now - 580000 },
  { id: 'm3', conversationId: 'c1', seq: 3, role: 'user', agent: 'codex', model: null, effort: null, content: 'Revisa el cambio anterior y confírmalo.', items: null, status: 'done', error: null, usage: null, contextNote: { mode: 'shared', messages: 2, agents: ['claude'] }, attachments: null, createdAt: now - 500000, completedAt: null },
  { id: 'm4', conversationId: 'c1', seq: 4, role: 'assistant', agent: 'codex', model: 'gpt-6-luna', effort: 'high', content: CODEX_TEXT, items: CODEX_ITEMS, status: 'done', error: null, usage: { inputTokens: 8200, outputTokens: 310 }, contextNote: null, attachments: null, createdAt: now - 490000, completedAt: now - 480000 },
];

const question = [
  { ...messages[0], id: 'q1', conversationId: 'c2', content: 'Recupera la configuración local.' },
  { ...messages[1], id: 'q2', conversationId: 'c2', items: null,
    content: 'Encontré una configuración incompleta. **¿Quieres que guarde una copia antes de restaurarla?**' },
];

const codexCatalog = {
  source: 'Codex App Server · model/list',
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Modelo predeterminado', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', isDefault: true, inputModalities: ['text', 'image'] },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Rápido y económico', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', isDefault: false, inputModalities: ['text', 'image'], fast: { id: 'priority', label: 'Rápido', description: '1.5x speed' } },
  ],
};

const MOCK_UPDATE = new URLSearchParams(location.search).has('update');
// Ajustes iniciales de las escenas de prueba.
let settings: Record<string, unknown> = {
  'appearance.intensity': QS.get('intensity') ?? 'balanced',
  // Última instantánea de cuota de Claude Code con la forma que guarda el backend (rate_limit_event).
  'quota.claude': { default: { accountId: null, accountLabel: null, receivedAt: now - 20 * 60_000, status: 'allowed',
    windows: { five_hour: { usedPercent: 54, resetsAt: Math.floor(now / 1000) + 3 * 3600, status: 'allowed' }, seven_day: { usedPercent: 74.5, resetsAt: Math.floor(now / 1000) + 2 * 86400, status: 'allowed' } } } },
  ...(QS.get('scale') ? { 'ui.textScale': Number(QS.get('scale')) } : {}),
  ...(QS.get('backdrop') ? { 'appearance.backdrop': QS.get('backdrop') } : {}),
  ...(QS.get('hue') ? { 'appearance.hue': QS.get('hue') } : {}),
  ...(QS.get('lang') ? { 'ui.language': QS.get('lang') } : {}),
};

// ---------- Turno simulado (QA de mascotas y del indicador de trabajo) ----------
// Emite los mismos `run-event` que el backend real, en un guion fijo. Solo sirve para revisar la
// interfaz: no es una prueba de los proveedores.
const STEP = Number(QS.get('step') ?? 1600);
const extra: Record<string, unknown[]> = {};
const projects = [
  { id: 'p1', name: 'Demo', path: P, createdAt: now, updatedAt: now },
  { id: 'p2', name: 'ORBIT DESK', path: 'C:\\Users\\Demo\\Proyectos\\orbit-desk', createdAt: now, updatedAt: now },
  { id: 'p3', name: 'Proyecto con un nombre bastante largo para truncar', path: 'C:\\Users\\Demo\\Proyectos\\largo', createdAt: now, updatedAt: now },
];
const conversations: Array<ReturnType<typeof conv> & { worktreeId?: string | null; started?: boolean }> = [
  conv('c1', 'Añade una función resta(a, b) en math.js y compruébala', 3, 'codex', 'gpt-6-luna', 'high'),
  conv('c2', 'Crear el archivo nota2.txt', 9, 'claude', 'haiku', 'medium'),
  conv('c3', 'Conversación vacía', 60, null, null, null),
  { ...conv('c4', 'Formulario de pagos con validación', 25, 'codex', 'gpt-6-luna', 'high'), worktreeId: 'w1' },
  { ...conv('c5', 'Revisar los textos del checkout', 140, 'claude', 'haiku', 'medium'), worktreeId: 'w1' },
  { ...conv('c6', 'Migrar las pruebas a Vitest', 300, 'claude', 'haiku', 'medium'), worktreeId: 'w2' },
];
// Escena de worktrees: dos espacios del proyecto Demo (solo para revisar la interfaz).
const worktrees = [
  { id: 'w1', projectId: 'p1', path: 'C:\\Users\\Demo\\Proyectos\\Demo.worktrees\\pagos', branch: 'feat/pagos', label: 'pagos', managed: true, baseRef: 'main', retired: false, createdAt: now - 86400000, exists: true },
  { id: 'w2', projectId: 'p1', path: 'C:\\Users\\Demo\\Proyectos\\Demo.worktrees\\migracion-vitest-con-nombre-largo', branch: 'chore/migracion-vitest', label: 'migracion-vitest-con-nombre-largo', managed: false, baseRef: null, retired: false, createdAt: now - 3600000, exists: true },
];
const pendingTitles = new Set(['c3']);
const approvals = new Map<string, (decision: string) => void>();
const runs = new Map<string, () => void>();
const fixtures = [`${P}\\captura.png`, `${P}\\notas.txt`, `${P}\\informe.pdf`, `${P}\\foto-grande.jpg`];
let seq = 100;

function scriptedRun(conversationId: string, agent: string, model: string, effort: string | null, text: string, paths: string[]) {
  const n = ++seq;
  const runId = `run${n}`;
  const approvalId = `ap${n}`;
  const t0 = Date.now();
  const attachments = paths.map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? path, image: /\.(png|jpe?g)$/i.test(path) }));
  const user = { id: `u${n}`, conversationId, seq: n * 2, role: 'user', agent, model: null, effort: null, content: text, items: null, status: 'done', error: null, usage: null, contextNote: null, attachments, createdAt: t0, completedAt: null };
  const asst = { id: `a${n}`, conversationId, seq: n * 2 + 1, role: 'assistant', agent, model, effort, content: '', items: [] as unknown[], status: 'running', error: null, usage: null, contextNote: null, attachments: null, createdAt: t0, completedAt: null };
  (extra[conversationId] ??= []).push(user, asst);
  const conversation = conversations.find((entry) => entry.id === conversationId);
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? attachments[0]?.name;
  const chars = [...(firstLine ?? '')];
  const renamedTitle = conversation && chars.length && pendingTitles.delete(conversationId)
    ? chars.slice(0, 56).join('').trimEnd() + (chars.length > 56 ? '…' : '') : null;
  if (renamedTitle && conversation) conversation.title = renamedTitle;
  const fail = /falla|error/i.test(text);
  const ev = (e: Record<string, unknown>) => emitFixture('run-event', { runId, conversationId, ...e });
  const items: Record<string, Record<string, unknown>> = {};
  const item = (it: Record<string, unknown>) => {
    items[it.id as string] = { ...(items[it.id as string] ?? {}), ...it };
    ev({ type: 'item', item: items[it.id as string] });
  };
  const NL = '\n';
  const CODE = ['```tsx', "it('desactiva el envío mientras responde', () => {", '  render(<Composer conv={running} />);'].join(NL);
  const PART1 = 'Listo. El botón **Enviar** queda desactivado mientras la conversación está en curso. ';
  const PART2 = `He añadido un test que lo comprueba:${NL}${NL}${CODE}`;
  const PART3 = `${NL}});${NL}\`\`\`${NL}${NL}Los tests de \`composer\` pasan.`;
  const sep = String.fromCharCode(92);
  const steps: (() => void | Promise<void>)[] = [
    () => item({ id: 'r1', kind: 'reasoning', status: 'running', text: 'Reviso el compositor y el estado del store antes de tocar nada.' }),
    () => {
      item({ id: 'r1', kind: 'reasoning', status: 'completed' });
      const path = [P, 'src', 'Composer.tsx'].join(sep);
      item(agent === 'claude'
        ? { id: 't1', kind: 'tool', status: 'running', tool: 'Read', input: { file_path: path } }
        : { id: 't1', kind: 'command', status: 'running', command: 'Get-Content src/Composer.tsx', cwd: P,
          actions: [{ type: 'read', name: 'Composer.tsx', path }] });
    },
    () => {
      item({ id: 't1', kind: 'tool', status: 'completed', result: 'ok' });
      item({ id: 'f1', kind: 'file_change', status: 'running', changes: [{ path: [P, 'math.js'].join(sep), kind: 'update', diff: DIFF }] });
    },
    () => {
      item({ id: 'f1', kind: 'file_change', status: 'completed' });
      item({ id: 'x1', kind: 'command', status: 'running', command: 'npm test -- composer', cwd: P });
      ev({ type: 'output', itemId: 'x1', delta: `> vitest run composer${NL}` });
    },
    () => item({ id: 'x1', kind: 'command', status: fail ? 'failed' : 'completed', exitCode: fail ? 1 : 0, durationMs: 2400, output: fail ? ['> vitest run composer', '✕ 1 test falló', '  expected true to be false'].join(NL) : ['> vitest run composer', '✓ 3 tests'].join(NL) }),
    () => new Promise<void>((resolve) => {
      ev({ type: 'approval', approvalId, approval: { agent, kind: 'command', command: 'npm install --save-dev @testing-library/user-event', cwd: P, reason: 'Modifica package.json y package-lock.json.', options: agent === 'claude' ? ['accept', 'decline'] : ['accept', 'acceptForSession', 'decline'] } });
      const done = (decision: string) => {
        window.clearTimeout(auto);
        approvals.delete(approvalId);
        ev({ type: 'approvalResolved', approvalId, decision });
        resolve();
      };
      const auto = QS.has('autoapprove') ? window.setTimeout(() => done('accept'), STEP * 1.6) : 0;
      approvals.set(approvalId, done);
    }),
    () => { item({ id: 'w1', kind: 'text', status: 'running', text: '' }); ev({ type: 'delta', itemId: 'w1', kind: 'text', delta: PART1 }); },
    () => ev({ type: 'delta', itemId: 'w1', kind: 'text', delta: PART2 }),
    () => ev({ type: 'delta', itemId: 'w1', kind: 'text', delta: PART3 }),
  ];
  let stopped = false;
  runs.set(runId, () => { stopped = true; approvals.get(approvalId)?.('decline'); });
  void (async () => {
    for (const st of steps) {
      if (stopped) break;
      await st();
      if (!stopped) await new Promise((r) => setTimeout(r, STEP));
    }
    const finalText = stopped ? String(items.w1?.text ?? '') : PART1 + PART2 + PART3;
    if (finalText) items.w1 = { id: 'w1', kind: 'text', status: 'completed', text: finalText };
    const status = stopped ? 'interrupted' : fail ? 'failed' : 'done';
    Object.assign(asst, { content: finalText, items: Object.values(items), status, error: fail ? 'El comando de tests terminó con código 1.' : stopped ? 'Detenido por el usuario.' : null, usage: { inputTokens: 6400, outputTokens: 380, durationMs: Date.now() - t0 }, completedAt: Date.now() });
    runs.delete(runId);
    ev({ type: 'finished', status, message: asst });
    queueStep(conversationId, status);
  })();
  return { runId, userMessage: user, assistantMessage: { ...asst, items: null }, renamedTitle };
}

// ---------- Cola simulada (QA del envío automático y de la bandeja compacta) ----------
type MockEntry = { id: string; projectId: string; position: number; state: string; detail: null; messageId: null; createdAt: number;
  input: { request: Record<string, unknown>; target: { accountId: null; label: string }; attachments: unknown[]; captureError: null; effectiveEffort: null } };
const queues: Record<string, { entries: MockEntry[]; pauseReason: string | null }> = {};
const busy = new Set<string>();
const queueOf = (cid: string) => (queues[cid] ??= { entries: [], pauseReason: null });
const view = (cid: string) => ({ entries: queueOf(cid).entries.map((e, i) => ({ ...e, position: i })), pauseReason: queueOf(cid).pauseReason, reviewMessageId: null });
const changed = (cid: string) => emitFixture('run-event', { type: 'queueChanged', conversationId: cid });
function startRun(r: { conversationId: string; agent: string; model: string; effort: string | null; text: string; attachments: string[] }) {
  busy.add(r.conversationId);
  return scriptedRun(r.conversationId, r.agent, r.model, r.effort, r.text, r.attachments);
}
function queueStep(cid: string, status: string) {
  busy.delete(cid);
  const q = queueOf(cid);
  if (status !== 'done') { if (q.entries.length) q.pauseReason = status === 'interrupted' ? 'cancelled' : 'failed'; changed(cid); return; }
  const head = q.pauseReason ? undefined : q.entries.shift();
  changed(cid);
  if (!head) return;
  window.setTimeout(() => {
    const started = startRun(head.input.request as Parameters<typeof startRun>[0]);
    emitFixture('run-event', { type: 'started', conversationId: cid, ...started });
    changed(cid);
  }, 300);
}
// Escena «cola»: una ejecución larga con diez encargos pendientes de ambos agentes.
const QUEUE_TEXTS = ['Revisar los cambios del proyecto', 'Añadir pruebas para resta(a, b)', 'Documentar la API pública de math.js', 'Actualizar el README con los nuevos comandos', 'Comprobar el rendimiento del compositor', 'Revisar la accesibilidad del Workbench', 'Preparar las notas de la versión', 'Limpiar dependencias sin uso', 'Comprobar la build de Windows', 'Resumir el estado del proyecto'];
function seedQueue(cid: string, count: number) {
  queueOf(cid).entries = QUEUE_TEXTS.slice(0, count).map((text, i) => ({
    id: 'q' + i, projectId: 'p1', position: i, state: 'pending', detail: null, messageId: null, createdAt: now,
    input: { request: { conversationId: cid, agent: i % 3 === 1 ? 'claude' : 'codex', model: i % 3 === 1 ? 'haiku' : 'gpt-6-luna', effort: i % 3 === 1 ? 'medium' : i % 2 ? 'xhigh' : 'high', text, attachments: [], speed: i % 3 === 1 ? null : i % 4 === 0 ? 'priority' : 'default' },
      target: { accountId: null, label: 'Cuenta predeterminada' }, attachments: [], captureError: null, effectiveEffort: null },
  }));
}

export function install(native = false) {
  const inDatabase = native && QS.has('persistencia');
  const localCommands = new Set(['bootstrap', 'create_project', 'create_conversation', 'list_messages', 'set_draft', 'set_setting', 'rename_project', 'rename_conversation', 'delete_project', 'delete_conversation', 'set_conversation_prefs', 'set_conversation_permissions', 'discard_empty_conversation', 'workspace_read', 'inspect_attachments']);
  if (!native) {
    mockWindows('main');
    mockIPC((cmd, args) => cmd === 'plugin:dialog|open'
      ? (args as { options?: { directory?: boolean } })?.options?.directory ? 'C:\\Users\\Demo\\Proyectos\\Proyecto QA' : fixtures
      : null, { shouldMockEvents: true });
  }
  installFixtureTransport((cmd, args) => {
      if (inDatabase && localCommands.has(cmd)) return invoke(cmd, args);
      if (inDatabase && cmd === 'send_message') throw new Error('Los envíos están deshabilitados en la comprobación de persistencia.');
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case 'distribution_info':
          return { version: '0.1.1', platform: 'Windows (x86_64)', reportingEnabled: false, updaterEnabled: MOCK_UPDATE };
        // Solo para revisar la interfaz (?update=1): simula el canal, no verifica nada.
        case 'check_update':
          return MOCK_UPDATE ? { version: '0.3.0', notes: 'Ajustes rediseñados y más personalización.\nPantalla de actualización nueva.\nReportes de errores integrados.' } : null;
        case 'download_update': {
          const ch = a.events as { onmessage?: (e: unknown) => void };
          const total = 18_400_000;
          return new Promise<void>((resolve) => {
            let received = 0;
            const t = setInterval(() => {
              received = Math.min(total, received + 410_000);
              ch.onmessage?.({ kind: 'progress', received, total });
              if (received >= total) {
                clearInterval(t);
                ch.onmessage?.({ kind: 'verifying' });
                setTimeout(resolve, 1600);
              }
            }, 120);
          });
        }
        case 'install_update':
          return new Promise(() => undefined);
        case 'bootstrap':
          if (QS.get('escena') === 'cola') seedQueue('c1', Number(QS.get('pendientes') ?? 10));
          return {
            projects: projects.map((project) => ({ ...project })),
            conversations: conversations.map((conversation) => ({ ...conversation })),
            worktrees: worktrees.map((worktree) => ({ ...worktree })),
            gitProjects: ['p1'],
            settings: { ...settings, 'ui.lastProjectId': 'p1', 'ui.lastConversationId': QS.get('escena') === 'inicio' ? 'c3' : QS.get('escena') === 'pregunta' ? 'c2' : 'c1' },
            accounts: [],
            activeRuns: [],
            appVersion: '0.1.0-dev',
          };
        case 'message_queue':
          return view(String(a.conversationId));
        case 'submit_message': {
          const r = a.request as Parameters<typeof startRun>[0];
          const q = queueOf(r.conversationId);
          if (busy.has(r.conversationId) || q.entries.length || q.pauseReason) {
            q.entries.push({ id: String(a.id), projectId: 'p1', position: q.entries.length, state: 'pending', detail: null, messageId: null, createdAt: Date.now(),
              input: { request: r, target: { accountId: null, label: 'Cuenta predeterminada' }, attachments: [], captureError: null, effectiveEffort: null } });
            changed(r.conversationId);
            return { mode: 'queued', queue: view(r.conversationId) };
          }
          return { mode: 'started', started: startRun(r) };
        }
        case 'update_message_queue': {
          const cid = String(a.conversationId);
          const q = queueOf(cid);
          const act = a.action as { type: string; id?: string; before?: string | null };
          if (act.type === 'pause') q.pauseReason = 'manual';
          if (act.type === 'resume') { q.pauseReason = null; if (!busy.has(cid)) queueStep(cid, 'done'); }
          if (act.type === 'clear') q.entries = [];
          if (act.type === 'remove') q.entries = q.entries.filter((e) => e.id !== act.id);
          if (act.type === 'move') {
            const moving = q.entries.find((e) => e.id === act.id);
            if (moving) {
              q.entries = q.entries.filter((e) => e !== moving);
              const at = act.before ? q.entries.findIndex((e) => e.id === act.before) : q.entries.length;
              q.entries.splice(at < 0 ? q.entries.length : at, 0, moving);
            }
          }
          changed(cid);
          return view(cid);
        }
        case 'edit_queued_message': {
          const r = a.request as { conversationId: string; text: string };
          const entry = queueOf(r.conversationId).entries.find((e) => e.id === a.id);
          if (entry) entry.input.request = { ...entry.input.request, ...r };
          changed(r.conversationId);
          return view(r.conversationId);
        }
        case 'set_draft_attachments':
          return undefined;
        case 'worktree_status':
          return { exists: true, branch: a.id === 'w1' ? 'feat/pagos' : 'chore/migracion-vitest', head: 'abc123', upstream: null, ahead: a.id === 'w1' ? 2 : 0, behind: 0,
            changed: a.id === 'w1' ? 3 : 0, untracked: a.id === 'w1' ? 1 : 0, conflicted: 0, files: a.id === 'w1' ? ['src/pagos.ts', 'src/checkout.ts', 'README.md', 'notas.txt'] : [] };
        case 'worktree_preflight': {
          const req = a.request as { name: string; path: string; branch: string; newBranch: boolean } | null;
          return { gitVersion: 'git version 2.53.0.windows.1', mainPath: P, mainBranch: 'main', localBranches: ['main', 'feat/pagos', 'chore/migracion-vitest', 'fix/login'], remoteBranches: ['origin/main'],
            busyBranches: ['main', 'feat/pagos', 'chore/migracion-vitest'], baseDir: 'C:\\Users\\Demo\\Proyectos\\Demo.worktrees', suggestedName: 'nuevo-espacio', suggestedBranch: 'nuevo-espacio',
            suggestedPath: 'C:\\Users\\Demo\\Proyectos\\Demo.worktrees\\nuevo-espacio', errors: req && req.newBranch && req.branch === 'main' ? ['La rama «main» ya existe. Elige otro nombre o usa la rama existente.'] : [],
            warnings: [], freeBytes: 48_000_000_000, estimatedBytes: 2_400_000, mainDirty: true };
        }
        case 'worktree_removal_check':
          return a.id === 'w1'
            ? { exists: true, branch: 'feat/pagos', canRemoveDir: false, blockers: ['Tiene 3 archivo(s) con cambios sin commit.', 'Tiene 1 archivo(s) sin seguimiento que se perderían.'], warnings: [], canDeleteBranch: false, branchNote: 'La rama tiene 2 commit(s) que no están en ninguna otra rama: se conservará.', exclusiveCommits: 2, conversations: 2 }
            : { exists: true, branch: 'chore/migracion-vitest', canRemoveDir: true, blockers: [], warnings: ['Se borrarán dependencias o compilaciones regenerables: node_modules/.'], canDeleteBranch: true, branchNote: null, exclusiveCommits: 0, conversations: 1 };
        case 'worktree_importable':
          return [{ path: 'C:\\Users\\Demo\\Proyectos\\Demo-hotfix', head: 'def456', branch: 'hotfix/1.2', detached: false, bare: false, locked: false, prunable: false }];
        case 'worktree_integration':
          return { source: 'feat/pagos', target: 'main', ahead: 2, behind: 1, changed: 3, untracked: 1, files: ['src/pagos.ts', 'src/checkout.ts', 'README.md', 'notas.txt'], conflicts: [], conflictsChecked: true };
        case 'worktree_size':
          return { bytes: 3_150_000, partial: false };
        case 'discard_empty_conversation': {
          const index = conversations.findIndex((entry) => entry.id === a.id && (entry as { started?: boolean }).started === false);
          if (index >= 0) conversations.splice(index, 1);
          return index >= 0;
        }
        case 'list_messages':
          return { messages: [...(a.conversationId === 'c1' ? messages : a.conversationId === 'c2' ? question : []), ...(extra[a.conversationId as string] ?? [])], sessions: [] };
        case 'create_project': {
          const path = String(a.path);
          const project = { id: `p${++seq}`, name: String(a.name || path.split(/[\\/]/).pop()), path, createdAt: Date.now(), updatedAt: Date.now() };
          projects.push(project);
          return project;
        }
        case 'create_conversation': {
          const id = `c${++seq}`;
          const conversation = { ...conv(id, 'Nueva conversación', 0, null, null, null), projectId: String(a.projectId), started: false };
          conversations.push(conversation);
          pendingTitles.add(id);
          return { ...conversation };
        }
        case 'rename_conversation': {
          const conversation = conversations.find((entry) => entry.id === a.id);
          if (conversation) conversation.title = String(a.title).trim();
          pendingTitles.delete(String(a.id));
          return null;
        }
        case 'send_message':
          return startRun(a.request as Parameters<typeof startRun>[0]);
        case 'respond_approval':
          approvals.get(String(a.approvalId))?.(String(a.decision));
          return null;
        case 'cancel_run':
          runs.get(String(a.runId))?.();
          return null;
        case 'agent_models':
          return a.agent === 'claude' ? claudeRaw : codexCatalog;
        case 'detect_agents':
          return [
            { agent: 'claude', installed: true, path: 'C:\\Users\\Demo\\.local\\bin\\claude.exe', version: '2.1.316', working: true },
            { agent: 'codex', installed: true, path: 'C:\\Users\\Demo\\AppData\\Roaming\\npm\\codex.cmd', version: 'codex-cli 0.166.0', working: true },
          ];
        case 'set_setting':
          settings = { ...settings, [a.key as string]: a.value };
          return null;
        case 'agent_account':
          return a.agent === 'codex' ? { account: { type: 'chatgpt', email: 'demo@example.com', planType: 'plus' } } : { status: { loggedIn: true, authMethod: 'claude.ai', email: 'demo@example.com' } };
        case 'codex_rate_limits':
          return { rateLimits: { primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 7200 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null } } };
        case 'usage_summary':
          return { days: 30, rows: [{ agent: 'claude', model: 'claude-haiku-5-5', runs: 4, inputTokens: 21000, cachedInputTokens: 8000, outputTokens: 900, costUsd: 0.02 }] };
        case 'insights_usage':
          return QS.get('estadisticas') === 'vacias' ? [] : [
            { agent: 'codex', model: 'gpt-6-luna', projectId: 'p1', project: 'Demo', conversationId: 'c1', conversation: 'Añade una función resta(a, b) en math.js y compruébala', runs: 14, completed: 13, failed: 1, cancelled: 0, interrupted: 0, running: 0, legacy: 0, partial: 0, durationMs: 1_900_000, durationCount: 14, inputTokens: 2_400_000, inputCount: 14, freshInputTokens: 300_000, freshCount: 14, cachedInputTokens: 2_100_000, cacheReadCount: 14, cacheWriteInputTokens: null, cacheWriteCount: 0, outputTokens: 48_000, outputCount: 14, reportedUsd: null, reportedCount: 0, estimatedUsd: null, estimatedCount: 0 },
            { agent: 'claude', model: 'claude-haiku-5-5', projectId: 'p1', project: 'Demo', conversationId: 'c2', conversation: 'Crear el archivo nota2.txt', runs: 9, completed: 9, failed: 0, cancelled: 0, interrupted: 0, running: 0, legacy: 0, partial: 0, durationMs: 800_000, durationCount: 9, inputTokens: 900_000, inputCount: 9, freshInputTokens: 20_000, freshCount: 9, cachedInputTokens: 780_000, cacheReadCount: 9, cacheWriteInputTokens: 100_000, cacheWriteCount: 9, outputTokens: 30_000, outputCount: 9, reportedUsd: null, reportedCount: 0, estimatedUsd: 1.84, estimatedCount: 9 },
          ];
        case 'insights_timeline': {
          if (QS.get('estadisticas') === 'vacias') return [];
          const scope = a.scope as { since: number; bucketMs: number; offsetMs: number };
          const out: unknown[] = [];
          const pattern = [3, 0, 5, 2, 7, 4, 1, 6, 2, 0, 3, 5];
          const start = Math.max(scope.since, Date.now() - 40 * 86_400_000);
          let i = 0;
          for (let t = Math.floor((start + scope.offsetMs) / scope.bucketMs) * scope.bucketMs - scope.offsetMs; t <= Date.now(); t += scope.bucketMs, i++) {
            const n = pattern[i % pattern.length];
            if (!n) continue;
            for (const agent of ['claude', 'codex']) {
              const runs = agent === 'codex' ? n : Math.max(0, n - 2);
              if (!runs) continue;
              out.push({ bucket: t, agent, runs, completed: runs, failed: 0, durationMs: runs * 95_000, durationCount: runs,
                inputTokens: runs * 160_000, inputCount: runs, freshInputTokens: runs * 18_000, freshCount: runs,
                cachedInputTokens: runs * 132_000, cacheReadCount: runs, cacheWriteInputTokens: agent === 'claude' ? runs * 10_000 : null, cacheWriteCount: agent === 'claude' ? runs : 0,
                outputTokens: runs * 3_400, outputCount: runs, reportedUsd: null, reportedCount: 0,
                estimatedUsd: agent === 'claude' ? runs * 0.21 : null, estimatedCount: agent === 'claude' ? runs : 0 });
            }
          }
          return out;
        }
        case 'run_insights':
          return null;
        case 'inspect_attachments':
          return (a.paths as string[]).map((p) => ({ path: p, exists: !p.includes('falta'), isDir: false, size: p.includes('grande') ? 7e6 : 2048 }));
        case 'workspace_read':
          return { path: `${P}\\math.js`, relative: 'math.js', revision: null, size: 120, truncated: false, binary: false, content: 'export function suma(a, b) {\n  return a + b;\n}\n\nexport function resta(a, b) {\n  return a - b;\n}\n' };
        default:
          return null;
      }
  });
}

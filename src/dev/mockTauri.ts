// Arnés de desarrollo para revisar la interfaz en un navegador normal (vite dev, sin Tauri).
// Solo se carga con `import.meta.env.DEV` y fuera de Tauri (ver main.tsx): nunca forma parte de
// la compilación de producción. NO sustituye a las pruebas con los agentes reales; sirve para
// comprobar distribución, materiales y estados de la interfaz a distintos tamaños.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import claudeRaw from '../test/fixtures/claude-catalog-2.1.316.json';

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

const LONG = Array.from({ length: 6 }, (_, i) => `${i + 1}. Párrafo de prueba con **texto denso** para comprobar que nada se lee a través del cristal del compositor ni de los menús. Incluye \`código en línea\` y enlaces.`).join('\n\n');

const CMD = `node -e "import('./math.js').then(m => console.log(m.resta(5, 3)))"`;
const CODEX_TEXT = `Confirmado. La función está correctamente implementada y el resultado es 2.

${LONG}

\`\`\`js
export function resta(a, b) {
  return a - b;
}
\`\`\``;

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
  { id: 'm4', conversationId: 'c1', seq: 4, role: 'assistant', agent: 'codex', model: 'gpt-6-luna', effort: 'high', content: CODEX_TEXT, items: [{ id: 'k1', kind: 'command', status: 'completed', command: CMD, output: '2', exitCode: 0, cwd: P }, { id: 'k2', kind: 'text', status: 'completed', text: CODEX_TEXT }], status: 'done', error: null, usage: { inputTokens: 8200, outputTokens: 310 }, contextNote: null, attachments: null, createdAt: now - 490000, completedAt: now - 480000 },
];

const codexCatalog = {
  source: 'Codex App Server · model/list',
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Modelo predeterminado', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', isDefault: true, inputModalities: ['text', 'image'] },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Rápido y económico', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', isDefault: false, inputModalities: ['text', 'image'] },
  ],
};

let settings: Record<string, unknown> = { 'appearance.intensity': new URLSearchParams(location.search).get('intensity') ?? 'full' };

export function install() {
  mockWindows('main');
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case 'distribution_info':
          return { version: '0.1.1', platform: 'Windows (x86_64)', reportingEnabled: false, updaterEnabled: false };
        case 'bootstrap':
          return {
            projects: [
              { id: 'p1', name: 'Demo', path: P, createdAt: now, updatedAt: now },
              { id: 'p2', name: 'ORBIT DESK', path: 'C:\\Users\\Demo\\Proyectos\\orbit-desk', createdAt: now, updatedAt: now },
              { id: 'p3', name: 'Proyecto con un nombre bastante largo para truncar', path: 'C:\\Users\\Demo\\Proyectos\\largo', createdAt: now, updatedAt: now },
            ],
            conversations: [
              conv('c1', 'Añade una función resta(a, b) en math.js y compruébala', 3, 'codex', 'gpt-6-luna', 'high'),
              conv('c2', 'Crear el archivo nota2.txt', 9, 'claude', 'haiku', 'medium'),
              conv('c3', 'Conversación vacía', 60, null, null, null),
            ],
            settings: { ...settings, 'ui.lastProjectId': 'p1', 'ui.lastConversationId': 'c1' },
            accounts: [],
            activeRuns: [],
            appVersion: '0.1.0-dev',
          };
        case 'list_messages':
          return { messages: a.conversationId === 'c1' ? messages : [], sessions: [] };
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
        case 'inspect_attachments':
          return (a.paths as string[]).map((p) => ({ path: p, exists: !p.includes('falta'), isDir: false, size: p.includes('grande') ? 7e6 : 2048 }));
        case 'read_file':
          return { path: `${P}\\math.js`, size: 120, truncated: false, binary: false, content: 'export function suma(a, b) {\n  return a + b;\n}\n\nexport function resta(a, b) {\n  return a - b;\n}\n' };
        case 'plugin:dialog|open':
          return [`${P}\\captura.png`, `${P}\\notas.txt`, `${P}\\informe.pdf`, `${P}\\foto-grande.jpg`];
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

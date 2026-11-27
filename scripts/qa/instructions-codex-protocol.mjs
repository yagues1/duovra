// QA 1.0.11 · fase 6: archivos de instrucciones que Codex App Server declara cargados SIN invocar modelos.
//
// Lanza el `codex app-server` instalado con un CODEX_HOME temporal (proveedor simulado, sin red) y un
// proyecto git aislado con AGENTS.md, AGENTS.override.md y un AGENTS.md de subdirectorio. Solo se llama
// a `thread/start` (y a `thread/start` con `cwd` en el subdirectorio): no hay turnos ni peticiones al modelo.
// Se registra `instructionSources` de la respuesta, que es lo que Duovra usa para confirmar la carga.
//
// Uso: node scripts/qa/instructions-codex-protocol.mjs [carpeta-salida]
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-instructions-codex');
mkdirSync(out, { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'duovra-instr-codex-home-'));
writeFileSync(join(home, 'config.toml'), `model = "gpt-6-luna"
model_reasoning_effort = "high"
model_provider = "qa"
[model_providers.qa]
name = "QA (simulado)"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
env_key = "DUOVRA_QA_FAKE_KEY"
request_max_retries = 0
stream_max_retries = 0
`);
writeFileSync(join(home, 'AGENTS.md'), 'QA_MARK_GLOBAL\n');
const project = mkdtempSync(join(tmpdir(), 'duovra-instr-codex-project-'));
execSync('git init -q', { cwd: project });
mkdirSync(join(project, 'pkg'), { recursive: true });
writeFileSync(join(project, 'AGENTS.md'), 'QA_MARK_ROOT\n');
writeFileSync(join(project, 'pkg', 'AGENTS.md'), 'QA_MARK_PKG\n');
writeFileSync(join(project, 'pkg', 'AGENTS.override.md'), 'QA_MARK_PKG_OVERRIDE\n');

const env = { ...process.env, CODEX_HOME: home, DUOVRA_QA_FAKE_KEY: 'qa-not-a-real-key' };
delete env.OPENAI_API_KEY;
const child = spawn('codex', ['app-server'], { env, shell: true });
const pending = new Map();
let next = 1;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const request = (method, params) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  write({ id, method, params });
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method}: sin respuesta`)); }, 20_000);
});

const report = {};
try {
  const init = await request('initialize', { clientInfo: { name: 'duovra', title: 'Duovra QA', version: '1.0.11' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  write({ method: 'initialized' });
  report.userAgent = init.userAgent;
  for (const [name, cwd] of [['root', project], ['pkg', join(project, 'pkg')]]) {
    const r = await request('thread/start', { model: 'gpt-6-luna', cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    report[name] = { cwd, instructionSources: r.instructionSources, hasField: 'instructionSources' in r };
  }
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(out, 'instructions-codex-protocol.json'), JSON.stringify(report, null, 2));
child.kill();
process.exit(0);

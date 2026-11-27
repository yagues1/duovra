// QA 1.0.11 · fase 6: qué archivos de instrucciones carga Claude Code SIN invocar modelos.
//
// Lanza la CLI instalada (`claude -p` + stream-json, argumentos de Duovra) contra una API de Anthropic
// simulada en 127.0.0.1, con configuración y proyecto aislados. Cada archivo candidato lleva un marcador
// único; se comprueba qué marcadores llegan en la petición a la API (carga efectiva) y qué campos
// comunica el mensaje `init` (lo único que Duovra ve en producción).
//
// Uso: node scripts/qa/instructions-claude-protocol.mjs [carpeta-salida]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-instructions-claude');
mkdirSync(out, { recursive: true });
const bodies = [];

function sse(res, model) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { message: { id: 'msg_qa', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', {});
  res.end();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 12 }));
    }
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      bodies.push(raw);
      const body = JSON.parse(raw || '{}');
      return sse(res, body.model);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const config = mkdtempSync(join(tmpdir(), 'duovra-instr-claude-config-'));
writeFileSync(join(config, 'settings.json'), '{}');
writeFileSync(join(config, 'CLAUDE.md'), 'QA_MARK_GLOBAL_CLAUDE\n');
mkdirSync(join(config, 'rules'), { recursive: true });
writeFileSync(join(config, 'rules', 'global-rule.md'), 'QA_MARK_GLOBAL_RULE\n');
const parent = mkdtempSync(join(tmpdir(), 'duovra-instr-claude-parent-'));
writeFileSync(join(parent, 'CLAUDE.md'), 'QA_MARK_PARENT_CLAUDE\n');
const project = join(parent, 'project');
mkdirSync(join(project, '.claude', 'rules'), { recursive: true });
mkdirSync(join(project, 'sub'), { recursive: true });
// Con QA_IMPORT=1, CLAUDE.md importa AGENTS.md con la sintaxis de Claude Code (`@AGENTS.md`).
writeFileSync(join(project, 'CLAUDE.md'), process.env.QA_IMPORT ? 'QA_MARK_PROJECT_CLAUDE\n@AGENTS.md\n' : 'QA_MARK_PROJECT_CLAUDE\n');
writeFileSync(join(project, '.claude', 'CLAUDE.md'), 'QA_MARK_DOTCLAUDE_CLAUDE\n');
writeFileSync(join(project, 'CLAUDE.local.md'), 'QA_MARK_LOCAL_CLAUDE\n');
writeFileSync(join(project, '.claude', 'rules', 'style.md'), 'QA_MARK_PROJECT_RULE\n');
writeFileSync(join(project, 'AGENTS.md'), 'QA_MARK_AGENTS\n');
writeFileSync(join(project, 'sub', 'CLAUDE.md'), 'QA_MARK_SUBDIR_CLAUDE\n');

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k))),
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'qa-not-a-real-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};

const events = await new Promise((resolve) => {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--model', 'claude-haiku-5-5'];
  const child = spawn('claude', args, { cwd: project, env, shell: true });
  const list = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    list.push(m);
    if (m.type === 'result') child.stdin.end();
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  child.on('exit', () => { clearTimeout(timer); resolve(list); });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hola' }] }, parent_tool_use_id: null, session_id: '' }) + '\n');
});

const all = bodies.join('\n');
const marks = ['GLOBAL_CLAUDE', 'GLOBAL_RULE', 'PARENT_CLAUDE', 'PROJECT_CLAUDE', 'DOTCLAUDE_CLAUDE', 'LOCAL_CLAUDE', 'PROJECT_RULE', 'AGENTS', 'SUBDIR_CLAUDE'];
const loaded = Object.fromEntries(marks.map((m) => [m, all.includes(`QA_MARK_${m}`)]));
const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
const tools = bodies.length ? (JSON.parse(bodies[0]).tools ?? []).map((t) => t.name).sort() : [];
const report = { version: init.claude_code_version, requests: bodies.length, loaded, tools, initKeys: Object.keys(init).sort(),
  initMemory: Object.fromEntries(Object.entries(init).filter(([k]) => /memory|instruction|claude_md|rules/i.test(k))) };
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(out, 'instructions-claude-protocol.json'), JSON.stringify(report, null, 2));
server.close();
process.exit(0);

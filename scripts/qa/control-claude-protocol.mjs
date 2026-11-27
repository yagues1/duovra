// QA 1.0.11 · fase 5: comandos rápidos y mensajes durante la ejecución de Claude Code SIN invocar modelos.
//
// Lanza la CLI instalada con los argumentos de Duovra (`claude -p` + stream-json) contra una API de
// Anthropic simulada en 127.0.0.1 (configuración aislada, clave ficticia). Para cada comando de una
// lista corta se observa si la CLI lo resuelve en local (sin petición a la API), si lo convierte en un
// turno del modelo (petición a la API simulada) o si lo rechaza. No se prueban los 149 comandos.
//
// Uso: node scripts/qa/control-claude-protocol.mjs [carpeta-salida]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-control-claude');
mkdirSync(out, { recursive: true });
const requests = [];
let delayMs = 0;

const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

function sse(res, model, text) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { message: { id: 'msg_qa', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
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
      const body = JSON.parse(raw || '{}');
      const users = (body.messages ?? []).filter((m) => m.role === 'user').map((m) => textOf(m.content));
      requests.push({ at: Date.now(), model: body.model, lastUser: users.at(-1)?.slice(-300) ?? '', users: users.length,
        system: textOf(body.system).slice(0, 120) });
      const reply = () => sse(res, body.model, `respuesta simulada ${requests.length}`);
      return delayMs ? setTimeout(reply, delayMs) : reply();
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const config = mkdtempSync(join(tmpdir(), 'duovra-control-claude-config-'));
writeFileSync(join(config, 'settings.json'), '{}');
const project = mkdtempSync(join(tmpdir(), 'duovra-control-claude-project-'));
writeFileSync(join(project, 'README.md'), '# Proyecto QA\n');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k))),
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'qa-not-a-real-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};

/** Una sesión con los argumentos de Duovra; envía los mensajes en orden y espera un `result` por mensaje. */
function session(messages, { gapMs = 0, resume } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--model', 'claude-haiku-5-5'];
    if (resume) args.push('--resume', resume);
    const child = spawn('claude', args, { cwd: project, env, shell: true });
    const events = [];
    const results = [];
    const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    const user = (text) => write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      events.push(m);
      if (m.type === 'result') {
        results.push({ subtype: m.subtype, isError: m.is_error, result: String(m.result ?? '').slice(0, 240), numTurns: m.num_turns, errors: m.errors });
        if (results.length >= messages.length) child.stdin.end();
      }
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('exit', () => { clearTimeout(timer); resolve({ events, results, session: events.find((e) => e.session_id)?.session_id }); });
    (async () => {
      for (const text of messages) {
        user(text);
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    })();
  });
}

const report = {};
// 1. Comandos de una lista corta. Cada uno en una sesión que ya tiene un turno previo.
const COMMANDS = ['/context', '/compact', '/usage', '/cost', '/goal', '/code-review', '/model', '/effort high', '/fast', '/clear', '/review', '/status', '/help', '/permissions', '/memory', '/inexistente-qa'];
for (const command of COMMANDS) {
  const before = requests.length;
  const s = await session(['Hola SCENARIO:previo', command]);
  const apiCalls = requests.length - before;
  const local = s.events.filter((e) => e.type === 'user' && typeof e.message?.content === 'string' && /local-command-stdout|command-name/.test(e.message.content));
  const r = s.results.at(-1);
  report[command] = { apiCallsTotal: apiCalls, apiCallsForCommand: apiCalls - 1, result: r, localOutput: local.length > 0,
    lastRequest: apiCalls > 1 ? requests.at(-1).lastUser.slice(0, 160) : null };
  console.log(command.padEnd(18), JSON.stringify(report[command]).slice(0, 300));
}

// 2. Mensaje adicional durante un turno activo (sin prioridad): ¿se aplica dentro del turno o después?
delayMs = 2500;
const before = requests.length;
const s = await session(['Primer mensaje SCENARIO:largo', 'Segundo mensaje durante el turno'], { gapMs: 600 });
delayMs = 0;
const calls = requests.slice(before);
report.midTurn = {
  apiCalls: calls.length,
  results: s.results,
  secondSeenInCall: calls.findIndex((c) => c.lastUser.includes('Segundo mensaje')),
  callsUserCounts: calls.map((c) => c.users),
};
console.log('midTurn', JSON.stringify(report.midTurn));

writeFileSync(join(out, 'control-claude-protocol.json'), JSON.stringify({ version: 'claude-cli', report, requests }, null, 2));
server.close();
process.exit(0);

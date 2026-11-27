// QA 1.0.11 · fase 4: protocolo de planificación y preguntas de Claude Code SIN invocar modelos.
//
// Lanza la CLI instalada con los mismos argumentos que Duovra (`claude -p` + stream-json +
// `--permission-prompt-tool stdio`) contra una API de Anthropic simulada en 127.0.0.1. La configuración
// es aislada (CLAUDE_CONFIG_DIR temporal, `"model": "opusplan"` para reproducir la del usuario) y la
// clave es ficticia: ninguna petición sale del equipo y ningún modelo responde de verdad.
//
// Uso: node scripts/qa/planning-claude-protocol.mjs [carpeta-salida]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const out = process.argv[2] ?? join(tmpdir(), 'duovra-qa-1.0.11-planning-claude');
mkdirSync(out, { recursive: true });
const requests = [];
const results = [];

// ---------- API simulada ----------
const PLAN = '# Plan de QA\n1. Leer `README.md`.\n2. Añadir una sección de prueba.';
const QUESTIONS = [
  { question: '¿Qué base de datos usamos?', header: 'Base', multiSelect: false,
    options: [{ label: 'SQLite', description: 'Archivo local' }, { label: 'Postgres', description: 'Servidor' }] },
  { question: '¿Qué comprobaciones ejecuto?', header: 'QA', multiSelect: true,
    options: [{ label: 'Tests', description: 'Unitarios' }, { label: 'Lint', description: 'Estilo' }] },
];
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(16).slice(2, 14)}`, name, input });
const SCENARIOS = {
  model: () => null,
  'exit-allow': () => tool('ExitPlanMode', { plan: PLAN }),
  'exit-deny': () => tool('ExitPlanMode', { plan: PLAN }),
  ask: () => tool('AskUserQuestion', { questions: QUESTIONS }),
  'ask-cancel': () => tool('AskUserQuestion', { questions: QUESTIONS }),
  write: () => tool('Write', { file_path: 'qa-plan-write.txt', content: 'no debería escribirse' }),
  bash: () => tool('Bash', { command: 'echo qa > qa-bash.txt', description: 'Escribe un archivo' }),
  read: () => tool('Read', { file_path: 'README.md' }),
  'mcp-write': () => tool('mcp__qa__qa_write', { value: 'x' }),
  'mcp-read': () => tool('mcp__qa__qa_read', {}),
};
const textOf = (content) => typeof content === 'string' ? content
  : (content ?? []).map((b) => b.type === 'text' ? b.text : b.type === 'tool_result' ? `[tool_result${b.is_error ? ' error' : ''}] ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}` : '').join('\n');

function reply(body) {
  const first = body.messages?.find((m) => m.role === 'user');
  const scenario = /SCENARIO:([\w-]+)/.exec(textOf(first?.content))?.[1];
  // La CLI puede añadir recordatorios después del resultado: se busca el último resultado de herramienta.
  const toolResult = (body.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_result').at(-1);
  requests.push({
    scenario: scenario ?? null, model: body.model, stream: !!body.stream,
    tools: (body.tools ?? []).map((t) => t.name), toolResult: toolResult ? { isError: !!toolResult.is_error, text: textOf([toolResult]) } : null,
    planReminder: JSON.stringify(body).includes('Plan mode is active'),
  });
  const build = scenario && Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : null;
  const block = !toolResult && build ? build() : null;
  if (!block) return [{ type: 'text', text: scenario ? `Fin del escenario ${scenario}.` : 'ok' }];
  return [block];
}

function sse(res, model, content) {
  const id = `msg_${Math.random().toString(16).slice(2, 14)}`;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 8 } });
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
      const content = reply(body);
      if (body.stream) return sse(res, body.model, content);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_plain', type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 12, output_tokens: 8 } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- Entorno aislado ----------
const config = mkdtempSync(join(tmpdir(), 'duovra-plan-claude-config-'));
writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'opusplan' }, null, 2));
const project = mkdtempSync(join(tmpdir(), 'duovra-plan-claude-project-'));
writeFileSync(join(project, 'README.md'), '# Proyecto QA\n');
// Servidor MCP mínimo (stdio): una herramienta marcada como de solo lectura y otra que no.
const mcpServer = join(config, 'qa-mcp.mjs');
writeFileSync(mcpServer, `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'qa', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'qa_read', description: 'Lee un valor', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'qa_write', description: 'Escribe un valor', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } } ] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'mcp ' + m.params.name + ' ejecutada' }] } });
  else send({ jsonrpc: '2.0', id: m.id, result: {} }); });
`);
const mcpConfig = join(config, 'mcp.json');
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { qa: { command: process.execPath, args: [mcpServer] } } }));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k))),
  CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'qa-not-a-real-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};

/** Una ejecución con los argumentos de Duovra. `onControl` decide cada `can_use_tool`. */
function runClaude({ scenario, model, mode = 'plan', onControl, mcp = false, timeout = 60_000 }) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--permission-mode', mode, '--model', model];
    if (mcp) args.push('--mcp-config', mcpConfig, '--strict-mcp-config');
    const child = spawn('claude', args, { cwd: project, env, shell: true });
    const log = { scenario, model, mode, init: null, controls: [], toolUses: [], result: null, stderr: '' };
    const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stderr.on('data', (d) => { log.stderr += d; });
    readline.createInterface({ input: child.stdout }).on('line', async (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'system' && m.subtype === 'init') log.init = { model: m.model, permissionMode: m.permissionMode, tools: m.tools };
      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message?.content ?? []) if (b.type === 'tool_use') log.toolUses.push({ id: b.id, name: b.name, input: b.input });
      }
      if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
        log.controls.push({ tool: m.request.tool_name, id: m.request.tool_use_id, input: m.request.input, suggestions: m.request.permission_suggestions ?? null,
          announced: log.toolUses.some((t) => t.id === m.request.tool_use_id) });
        const response = await onControl?.(m.request, write);
        if (response) write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      }
      if (m.type === 'result') { log.result = { subtype: m.subtype, isError: m.is_error, text: m.result }; child.stdin.end(); }
    });
    const timer = setTimeout(() => { log.timeout = true; child.kill(); }, timeout);
    child.on('exit', (code) => { clearTimeout(timer); log.exit = code; resolve(log); });
    write({ type: 'user', session_id: '', message: { role: 'user', content: [{ type: 'text', text: `SCENARIO:${scenario}` }] }, parent_tool_use_id: null });
  });
}

const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log('OK  ', name, detail ? JSON.stringify(detail).slice(0, 300) : '');
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log('FAIL', name, String(error?.message ?? error).slice(0, 500));
  }
};
const modelsOf = (scenario) => [...new Set(requests.filter((r) => r.scenario === scenario).map((r) => r.model))];

// ---------- Escenarios ----------
await check('modo plan con el alias «haiku»: la CLI sustituye el modelo (comportamiento a evitar)', async () => {
  const log = await runClaude({ scenario: 'model', model: 'haiku' });
  const models = modelsOf('model');
  assert(log.result, `sin resultado (${log.stderr.slice(0, 200)})`);
  assert(models.length && !models.every((m) => m.includes('haiku')), `modelos: ${models}`);
  return { init: log.init?.model, requested: models };
});
requests.length = 0;
await check('modo plan con el ID exacto: la CLI pide Haiku (lo que hace Duovra)', async () => {
  const log = await runClaude({ scenario: 'model', model: 'claude-haiku-5-5' });
  const models = modelsOf('model');
  assert(log.result && models.length, `sin peticiones (${log.stderr.slice(0, 200)})`);
  assert(models.every((m) => m.includes('haiku')), `modelos: ${models}`);
  return { init: log.init?.model, requested: models, permissionMode: log.init?.permissionMode };
});
requests.length = 0;
await check('modo manual con el alias: Haiku sin sustitución', async () => {
  await runClaude({ scenario: 'model', model: 'haiku', mode: 'manual' });
  const models = modelsOf('model');
  assert(models.every((m) => m.includes('haiku')), `modelos: ${models}`);
  return { requested: models };
});

await check('ExitPlanMode llega como can_use_tool con el plan; allow + setMode sale del modo plan', async () => {
  const log = await runClaude({ scenario: 'exit-allow', model: 'claude-haiku-5-5',
    onControl: (req) => ({ behavior: 'allow', updatedInput: req.input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }) });
  const control = log.controls.find((c) => c.tool === 'ExitPlanMode');
  assert(control, 'sin solicitud ExitPlanMode');
  writeFileSync(join(out, 'exit-plan-mode-input.json'), JSON.stringify({ control: control.input, toolUse: log.toolUses.find((t) => t.id === control.id)?.input }, null, 2));
  // 2.1.325 no repite el plan en can_use_tool: Duovra lo toma del bloque tool_use, que llega antes.
  assert(control.announced, 'la solicitud llegó antes que el bloque tool_use');
  assert.equal(log.toolUses.find((t) => t.id === control.id)?.input.plan, PLAN);
  const after = requests.filter((r) => r.scenario === 'exit-allow' && r.toolResult);
  assert(after.length && !after.at(-1).toolResult.isError, JSON.stringify(after.at(-1)));
  return { controlInputKeys: Object.keys(control.input), toolResult: after.at(-1).toolResult.text.slice(0, 200), planReminderAfter: after.at(-1).planReminder };
});

await check('ExitPlanMode denegado con cambios: el agente recibe la petición y no sale del modo plan', async () => {
  const feedback = 'Añade un paso de pruebas antes de implementar.';
  await runClaude({ scenario: 'exit-deny', model: 'claude-haiku-5-5',
    onControl: () => ({ behavior: 'deny', message: `El usuario pide cambios en el plan antes de aprobarlo:\n${feedback}` }) });
  const after = requests.filter((r) => r.scenario === 'exit-deny' && r.toolResult).at(-1);
  assert(after?.toolResult.isError && after.toolResult.text.includes(feedback), JSON.stringify(after));
  return { toolResult: after.toolResult.text.slice(0, 200), planReminderAfter: after.planReminder };
});

await check('AskUserQuestion: respuestas estructuradas (una y varias opciones, personalizada)', async () => {
  const answers = { [QUESTIONS[0].question]: 'SQLite', [QUESTIONS[1].question]: 'Tests, Lint, Revisión manual' };
  const log = await runClaude({ scenario: 'ask', model: 'claude-haiku-5-5', mode: 'manual',
    onControl: (req) => ({ behavior: 'allow', updatedInput: { ...req.input, answers } }) });
  const control = log.controls.find((c) => c.tool === 'AskUserQuestion');
  assert(control, 'sin solicitud AskUserQuestion');
  assert.deepEqual(control.input.questions.map((q) => q.multiSelect), [false, true]);
  const after = requests.filter((r) => r.scenario === 'ask' && r.toolResult).at(-1);
  assert(after && !after.toolResult.isError && after.toolResult.text.includes('SQLite') && after.toolResult.text.includes('Revisión manual'), JSON.stringify(after));
  return { inputKeys: Object.keys(control.input), toolResult: after.toolResult.text.slice(0, 300) };
});

await check('cancelación con una pregunta pendiente: se deniega y se interrumpe sin respuesta inventada', async () => {
  const log = await runClaude({ scenario: 'ask-cancel', model: 'claude-haiku-5-5', mode: 'manual', timeout: 30_000,
    onControl: (_req, write) => {
      write({ type: 'control_request', request_id: 'qa-interrupt', request: { subtype: 'interrupt' } });
      return { behavior: 'deny', message: 'La ejecución se canceló desde Duovra.' };
    } });
  assert(log.result || log.exit !== null, 'la CLI no terminó');
  const answered = requests.filter((r) => r.scenario === 'ask-cancel' && r.toolResult && !r.toolResult.isError);
  assert.equal(answered.length, 0);
  return { result: log.result?.subtype ?? null, exit: log.exit, timeout: !!log.timeout };
});

for (const [scenario, toolName] of [['write', 'Write'], ['bash', 'Bash'], ['read', 'Read']]) {
  await check(`modo plan · ${toolName}: ¿pide aprobación al host?`, async () => {
    const log = await runClaude({ scenario, model: 'claude-haiku-5-5', onControl: () => ({ behavior: 'deny', message: 'QA: denegado' }) });
    const asked = log.controls.some((c) => c.tool === toolName);
    const after = requests.filter((r) => r.scenario === scenario && r.toolResult).at(-1);
    return { askedHost: asked, toolResult: after?.toolResult.text.slice(0, 160) ?? null, fileWritten: existsSync(join(project, 'qa-plan-write.txt')) || existsSync(join(project, 'qa-bash.txt')) };
  });
}

for (const [scenario, toolName] of [['mcp-write', 'mcp__qa__qa_write'], ['mcp-read', 'mcp__qa__qa_read']]) {
  await check(`modo plan · MCP ${toolName}: ¿pide aprobación al host?`, async () => {
    const log = await runClaude({ scenario, model: 'claude-haiku-5-5', mcp: true, onControl: () => ({ behavior: 'deny', message: 'QA: denegado' }) });
    const after = requests.filter((r) => r.scenario === scenario && r.toolResult).at(-1);
    return { offered: requests.some((r) => r.scenario === scenario && r.tools.includes(toolName)), askedHost: log.controls.some((c) => c.tool === toolName),
      toolResult: after?.toolResult.text.slice(0, 160) ?? null };
  });
}

server.close();
const report = { cli: 'claude 2.1.325 (instalada)', api: 'simulada en 127.0.0.1', results,
  requests: requests.map((r) => ({ scenario: r.scenario, model: r.model, toolResult: r.toolResult?.text.slice(0, 120) ?? null })) };
writeFileSync(join(out, 'planning-claude-protocol.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones · informe en ${join(out, 'planning-claude-protocol.json')}`);
process.exit(failed ? 1 : 0);

// Prueba optativa con una sola inferencia de la política de QA. No escribe en el proyecto.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'output', 'qa', 'execution-queue', 'evidencia');
mkdirSync(out, { recursive: true });
const project = join(out, 'proyecto-steer-real');
mkdirSync(project, { recursive: true });
const check = spawnSync(process.execPath, ['scripts/qa/check-test-models.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
const allowed = check.stdout?.includes('OK   Codex Luna 6.0 / Alto:') && check.stdout?.includes('OK   Codex admite «high»');
if (!allowed) {
  console.error('NOT TESTED: el catálogo no confirmó gpt-6-luna / high.');
  process.exit(2);
}

const codex = spawn('codex.exe', ['app-server'], { cwd: project, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const lines = createInterface({ input: codex.stdout });
const marker = 'DUOVRA_STEER_CONTROLADO_834';
const transcript = [];
let thread, turn, acknowledged, status, inputSent, outputContainsMarker = false;
let complete, fail;
const finished = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
const timer = setTimeout(() => fail(new Error('El turno excedió el límite de 60 segundos')), 60_000);
const write = (message) => codex.stdin.write(JSON.stringify(message) + '\n');
const send = (id, method, params) => write({ id, method, params });

codex.on('error', fail);
codex.on('exit', (code) => fail(new Error('App Server salió con código ' + code)));
function steer() {
  if (!thread || !turn || inputSent) return;
  inputSent = true;
  send(4, 'turn/steer', { threadId: thread, expectedTurnId: turn, input: [
    { type: 'text', text: 'Interrumpe la lista. Responde con esta clave exacta en tu mensaje final: ' + marker, text_elements: [] },
  ] });
}

lines.on('line', (line) => {
  try {
    const event = JSON.parse(line);
    if (event.error) {
      if (event.id === 99) {
        assert.match(event.error.message, /thread not found/i);
        send(2, 'thread/start', { cwd: project, model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'read-only' });
        return;
      }
      fail(new Error('RPC ' + event.id + ' rechazado: ' + event.error.message));
      return;
    }
    if (event.id === 1) {
      write({ method: 'initialized' });
      const probe = '00000000-0000-4000-8000-000000000000';
      send(99, 'turn/steer', { threadId: probe, expectedTurnId: probe, input: [{ type: 'text', text: '', text_elements: [] }] });
    } else if (event.id === 2) {
      thread = event.result.thread.id;
      send(3, 'turn/start', { threadId: thread, model: 'gpt-6-luna', effort: 'high', input: [
        { type: 'text', text: 'Sin herramientas y sin archivos, escribe una lista numerada de 80 nombres de fruta. Atiende cualquier nueva instrucción que llegue durante tu turno.', text_elements: [] },
      ] });
    } else if (event.id === 4) {
      acknowledged = event.result.turnId;
    }
    if (event.params?.threadId !== thread || !thread) return;
    if (event.method === 'turn/started') {
      turn = event.params.turn.id;
      transcript.push('turn/started');
      setTimeout(steer, 350);
    } else if (event.method === 'item/agentMessage/delta') {
      transcript.push('item/agentMessage/delta');
      steer();
    } else if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') {
      outputContainsMarker ||= event.params.item.text.includes(marker);
    } else if (event.method === 'turn/completed') {
      assert.equal(event.params.turn.id, turn);
      status = event.params.turn.status;
      complete();
    }
  } catch (err) {
    fail(err);
  }
});

let failure;
try {
  send(1, 'initialize', { clientInfo: { name: 'duovra_qa_steer', title: 'Duovra Steer QA', version: '0.6.0' }, capabilities: { experimentalApi: false } });
  await finished;
  assert.equal(acknowledged, turn, 'Codex no confirmó el ID del turno activo');
  assert.equal(status, 'completed');
  assert(outputContainsMarker, 'No apareció el efecto observable de la intervención');
  console.log('PASS Codex real: ACK del mismo turno y clave de intervención en la respuesta. Una inferencia inicial con gpt-6-luna / high.');
} catch (err) {
  failure = err;
  console.error(err);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (thread && turn && !status) send(5, 'turn/interrupt', { threadId: thread, turnId: turn });
  lines.close();
  codex.stdin.end();
  codex.kill();
  writeFileSync(join(out, 'steer-codex-real.json'), JSON.stringify({
    ok: !failure, model: 'gpt-6-luna', effort: 'high', confirmedSameTurn: !!turn && acknowledged === turn,
    status, outputContainsMarker, startedTurns: transcript.filter((item) => item === 'turn/started').length,
    error: failure?.message ?? null,
  }, null, 2));
}

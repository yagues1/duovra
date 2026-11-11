#!/usr/bin/env node
// Comprueba que los modelos autorizados para pruebas reales (docs/qa/test-model-policy.md)
// existen en los catálogos que informan las CLIs instaladas y admiten el nivel requerido.
// NO invoca ningún modelo: solo `initialize` (Claude Code) y `model/list` (Codex App Server).
// Uso: node scripts/qa/check-test-models.mjs
import { spawn } from 'node:child_process';
import os from 'node:os';

const POLICY = {
  codex: { match: (m) => /^gpt-6-luna$/i.test(m.model), effort: 'high', label: 'Luna 6.0 / Alto' },
  claude: { match: (m) => m.resolvedModel === 'claude-haiku-5-5', effort: 'medium', label: 'Haiku 5.5 / Medio' },
};

function rpc(cmd, args, onLine, setup, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: process.platform === 'win32', cwd: os.homedir() });
    const done = (v, e) => {
      clearTimeout(t);
      p.kill();
      e ? reject(e) : resolve(v);
    };
    const t = setTimeout(() => done(null, new Error(`${cmd} no respondió en ${timeoutMs / 1000} s`)), timeoutMs);
    let buf = '';
    p.on('error', (e) => done(null, e));
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        let v;
        try {
          v = JSON.parse(l);
        } catch {
          continue;
        }
        onLine(v, (x) => p.stdin.write(JSON.stringify(x) + '\n'), (r) => done(r));
      }
    });
    setup((x) => p.stdin.write(JSON.stringify(x) + '\n'));
  });
}

async function codexModels() {
  return rpc(
    'codex',
    ['app-server'],
    (v, send, finish) => {
      if (v.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'model/list', params: { includeHidden: false } });
      } else if (v.id === 2) finish(v.result?.data ?? []);
    },
    (send) => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ccs_qa_check', title: 'QA', version: '0' }, capabilities: { experimentalApi: false } } }),
  );
}

async function claudeModels() {
  return rpc(
    'claude',
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    (v, _send, finish) => {
      if (v.type === 'control_response' && v.response?.request_id === 'qa') finish({ version: v.response.response.claude_code_version, models: v.response.response.models ?? [] });
    },
    (send) => send({ type: 'control_request', request_id: 'qa', request: { subtype: 'initialize' } }),
  );
}

let failed = false;
const report = (ok, text) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${text}`);
};

try {
  const list = await codexModels();
  const m = list.find(POLICY.codex.match);
  const efforts = m?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [];
  report(!!m, `Codex ${POLICY.codex.label}: ${m ? `id «${m.model}» (${m.displayName})` : 'no figura en model/list'}`);
  if (m) report(efforts.includes(POLICY.codex.effort), `Codex admite «${POLICY.codex.effort}»: [${efforts.join(', ')}]`);
} catch (e) {
  report(false, `Codex: ${e.message}`);
}

try {
  const { version, models } = await claudeModels();
  const m = models.find(POLICY.claude.match);
  report(!!m, `Claude Code ${version} ${POLICY.claude.label}: ${m ? `id «${m.value}» → ${m.resolvedModel}` : 'no figura en initialize'}`);
  if (m) report((m.supportedEffortLevels ?? []).includes(POLICY.claude.effort), `Claude admite «${POLICY.claude.effort}»: [${(m.supportedEffortLevels ?? []).join(', ')}]`);
} catch (e) {
  report(false, `Claude Code: ${e.message}`);
}

if (failed) {
  console.log('\nNo ejecutes pruebas reales con otro modelo: registra NOT TESTED (docs/qa/test-model-policy.md §5).');
  process.exit(1);
}

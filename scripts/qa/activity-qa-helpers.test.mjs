import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { parseActivityArgs, taskTurn, assertTaskRejections } from './activity-qa-helpers.mjs';

const oldId = '00000000-0000-4000-8000-000000000001';
const newId = '00000000-0000-4000-8000-000000000002';
const codexId = '00000000-0000-4000-8000-000000000003';
const prompt = (id) => `QA-TASKS qa-run:${id} organiza el trabajo.`;
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const call = (id, name = 'TaskCreate') => ({ role: 'assistant', content: [{ type: 'tool_use', id, name }] });
const rejected = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'TaskCreate is disabled for this session' }] });
const functionCall = (id) => ({ type: 'function_call', name: 'update_plan', call_id: id });
const output = (id) => ({ type: 'function_call_output', call_id: id, output: 'unsupported call: update_plan' });

test('resume visual sin salida usa report-fase6, y con salida conserva la ruta', () => {
  assert.equal(parseActivityArgs(['qa', '--resume-visual']).out, join('qa', 'report-fase6'));
  assert.deepEqual(parseActivityArgs(['qa', 'destino', '--resume-visual']), {
    qa: 'qa', out: 'destino', resumeVisual: true, reviewActivity: false, reviewTasks: false,
  });
  assert.equal(parseActivityArgs(['--resume-visual', 'qa', '--review-tasks', 'destino']).out, 'destino');
  assert.equal(parseActivityArgs(['qa']).out, join('qa', 'report-fase6'));
  assert.throws(() => parseActivityArgs(['qa', '--review-tasks']));
  assert.throws(() => parseActivityArgs(['qa', '--unknown']));
});

test('Claude: el historial de seis herramientas no consume el límite del turno nuevo', () => {
  const history = [user(prompt(oldId)), ...Array.from({ length: 6 }, (_, i) => [call(`old-${i}`), rejected(`old-${i}`)]).flat()];
  const current = user(`<duovra_context>${prompt(oldId)}</duovra_context>\n${prompt(newId)}`);
  const fresh = taskTurn([current], 'anthropic');
  assert.equal(fresh.id, newId);
  assert.equal(fresh.calls.length, 0);
  const resumed = taskTurn([...history, current], 'anthropic');
  assert.equal(resumed.id, newId);
  assert.equal(resumed.calls.length, 0);
  assert.equal(resumed.last, undefined);
  const withResult = taskTurn([...history, current, call('new'), rejected('new'), rejected('old-5')], 'anthropic');
  assert.equal(withResult.calls.length, 1);
  assert.equal(withResult.last.tool_use_id, 'new');
  assert.equal(taskTurn([...history, user('otro encargo')], 'anthropic'), null);
});

test('Codex: el historial de dos update_plan no consume el límite del turno nuevo', () => {
  const history = [user(prompt(oldId)), functionCall('old-1'), output('old-1'), functionCall('old-2'), output('old-2')];
  const current = { role: 'user', content: [{ type: 'input_text', text: prompt(codexId) }] };
  assert.equal(taskTurn([current], 'responses').calls.length, 0);
  const resumed = taskTurn([...history, current], 'responses');
  assert.equal(resumed.id, codexId);
  assert.equal(resumed.calls.length, 0);
  assert.equal(resumed.last, undefined);
  const withResult = taskTurn([...history, current, functionCall('new'), output('new'), output('old-2')], 'responses');
  assert.equal(withResult.calls.length, 1);
  assert.equal(withResult.last.call_id, 'new');
});

const a = { api: 'anthropic', scenario: 'QA-TASKS', taskRunId: newId, taskResultId: 'a', toolResult: { error: true, text: 'TaskCreate is disabled for this session' } };
const c = { api: 'responses', scenario: 'QA-TASKS', taskRunId: codexId, taskResultId: 'c', output: 'unsupported call: update_plan', tools: [] };
const ids = { claude: newId, codex: codexId };
test('solo se cuentan rechazos actuales, correlacionados y únicos', () => {
  const result = assertTaskRejections([a, a, c, c, { ...a, taskRunId: oldId }, { ...c, taskRunId: oldId }], ids);
  assert.equal(result.claudeRejected, 1);
  assert.equal(result.codexRejected, 1);
  assert.equal(result.claudeRequests, 2);
  assert.equal(result.codexRequests, 2);
});
test('falla si solo hay rechazos históricos, incluso de ambos proveedores', () => {
  assert.throws(() => assertTaskRejections([{ ...a, taskRunId: oldId }, { ...c, taskRunId: oldId }], ids), /Claude/);
  assert.throws(() => assertTaskRejections([a, { ...c, taskRunId: oldId }], ids), /Codex/);
});
test('falla sin rechazo actual de una herramienta correlacionada', () => {
  assert.throws(() => assertTaskRejections([{ ...a, taskResultId: null }, c], ids), /Claude/);
  assert.throws(() => assertTaskRejections([{ ...a, toolResult: { ...a.toolResult, error: false } }, c], ids), /Claude/);
  assert.throws(() => assertTaskRejections([a, { ...c, output: 'ok' }], ids), /Codex/);
  assert.throws(() => assertTaskRejections([a, { ...c, taskResultId: null }], ids), /Codex/);
});

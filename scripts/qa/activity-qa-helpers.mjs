import assert from 'node:assert/strict';
import { join } from 'node:path';

export function parseActivityArgs(args) {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  for (const flag of flags) assert.ok(['--resume-visual', '--review-activity', '--review-tasks'].includes(flag), `Flag desconocido: ${flag}`);
  const [qa, output, ...extra] = args.filter((arg) => !arg.startsWith('--'));
  assert.ok(qa && !extra.length, 'Uso: activity-webview.mjs <carpeta-qa> [carpeta-salida] [flags]');
  const resumeVisual = flags.has('--resume-visual');
  const reviewActivity = flags.has('--review-activity');
  const reviewTasks = flags.has('--review-tasks');
  assert.ok(!(reviewActivity || reviewTasks) || resumeVisual, 'La revisión dirigida requiere --resume-visual');
  assert.ok(!(reviewActivity && reviewTasks), 'Elige una única revisión dirigida');
  return { qa, out: output ?? join(qa, 'report-fase6'), resumeVisual, reviewActivity, reviewTasks };
}

const blocks = (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
const withoutContext = (text) => text.replace(/<duovra_context[\s\S]*?<\/duovra_context>/g, '');

// Los resultados de herramientas no abren un turno. El último mensaje humano
// separa el escenario actual de todos los tool_use/function_call de la sesión.
export function taskTurn(items, api) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.role !== 'user') continue;
    const content = blocks(item.content);
    if (content.some((b) => b.type === 'tool_result')) continue;
    const human = withoutContext(content.filter((b) => b.type === 'text' || b.type === 'input_text').map((b) => b.text).join('\n'));
    if (!/\bQA-TASKS(?:LOW)?\b/.test(human)) return null;
    const scope = items.slice(i + 1);
    const calls = api === 'anthropic'
      ? scope.filter((m) => m.role === 'assistant').flatMap((m) => blocks(m.content)).filter((b) => b.type === 'tool_use' && /^Task(Create|Update)$/.test(b.name))
      : scope.filter((b) => b.type === 'function_call' && b.name === 'update_plan');
    const ids = new Set(calls.map((c) => api === 'anthropic' ? c.id : c.call_id));
    const results = api === 'anthropic'
      ? scope.flatMap((m) => blocks(m.content)).filter((b) => b.type === 'tool_result' && ids.has(b.tool_use_id))
      : scope.filter((b) => b.type === 'function_call_output' && ids.has(b.call_id));
    return { id: /\bqa-run:([a-f0-9-]{36})\b/i.exec(human)?.[1] ?? null, human, calls, last: results.at(-1) };
  }
  return null;
}

export function assertTaskRejections(requests, runIds) {
  const claude = requests.filter((r) => r.api === 'anthropic' && r.scenario === 'QA-TASKS' && r.taskRunId === runIds.claude);
  const codex = requests.filter((r) => r.api === 'responses' && r.scenario === 'QA-TASKS' && r.taskRunId === runIds.codex);
  const claudeRejected = new Set(claude.filter((r) => r.taskResultId && r.toolResult?.error && /(?:TaskCreate|TaskUpdate) is disabled for this session/.test(r.toolResult.text)).map((r) => r.taskResultId)).size;
  const codexRejected = new Set(codex.filter((r) => r.taskResultId && /unsupported call: update_plan/.test(r.output ?? '')).map((r) => r.taskResultId)).size;
  assert.ok(claudeRejected > 0, 'Claude: el escenario actual no rechazó herramientas de tareas');
  assert.ok(codexRejected > 0, 'Codex: el escenario actual no rechazó update_plan');
  return { runIds, claudeRequests: claude.length, codexRequests: codex.length, claudeRejected, codexRejected, codexTools: codex.at(-1)?.tools };
}

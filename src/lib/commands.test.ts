import { describe, expect, it } from 'vitest';
import { buildCommandRegistry, commandAvailability, mayRunWithoutConfirmation, parseArgumentHint } from './commands';
import type { AgentCapabilities, Capability, CapabilityStatus } from './types';

const cap = (id: Capability['id'], status: CapabilityStatus): Capability => ({ id, status, level: 'installation', integrated: 'no', source: 'test' });
const report = (agent: 'claude' | 'codex', caps: Capability[], commands: AgentCapabilities['commands'] = []): AgentCapabilities => ({
  agent, checkedAt: 1, stale: false, error: null, models: [], capabilities: caps, commands,
  installation: { agent, path: null, available: true, auth: { state: 'unknown' } },
});

describe('Command Registry', () => {
  it('sin informe solo hay acciones locales', () => {
    expect(buildCommandRegistry('claude', null)).toEqual([]);
  });

  it('las operaciones nativas dependen de su capacidad', () => {
    const r = report('codex', [cap('compact', 'supported'), cap('codeReview', 'unknown'), cap('goals', 'experimental')]);
    const ids = buildCommandRegistry('codex', r).map((c) => c.id);
    expect(ids).toContain('codex:native:thread/compact/start');
    expect(ids).toContain('codex:native:thread/goal/set');
    expect(ids).not.toContain('codex:native:review/start');
  });

  it('los comandos comunicados por la CLI se describen sin duplicar los nativos', () => {
    const r = report('claude', [cap('compact', 'supported'), cap('quickCommands', 'supported')], [
      { name: 'compact', builtin: true, argumentHint: '<optional custom summarization instructions>' },
      { name: 'superpowers:brainstorming', builtin: false, description: 'Ideas' },
      { name: 'loop', builtin: true, argumentHint: '[interval] [prompt]' },
    ]);
    const list = buildCommandRegistry('claude', r);
    expect(list.filter((c) => c.name === '/compact')).toHaveLength(1);
    const custom = list.find((c) => c.id === 'claude:custom:superpowers:brainstorming')!;
    expect(custom).toMatchObject({ origin: 'custom', requiresConfirmation: true, integrated: false, action: 'prompt' });
    expect(list.find((c) => c.name === '/loop')!.args.map((a) => a.name)).toEqual(['interval', 'prompt']);
  });

  it('ningún comando descubierto puede ejecutarse solo ni está disponible antes de integrarse', () => {
    const r = report('claude', [cap('compact', 'supported'), cap('quickCommands', 'supported')], [{ name: 'deploy', builtin: false }]);
    for (const c of buildCommandRegistry('claude', r)) {
      expect(mayRunWithoutConfirmation(c)).toBe(false);
      expect(commandAvailability(c, { running: false, report: r })).toEqual({ available: false, reason: 'notIntegrated' });
    }
  });

  it('respeta el estado de ejecución y la capacidad', () => {
    const r = report('codex', [cap('interrupt', 'supported')]);
    const stop = { ...buildCommandRegistry('codex', r).find((c) => c.name === '/stop')!, integrated: true };
    expect(commandAvailability(stop, { running: true, report: r }).available).toBe(true);
    expect(commandAvailability(stop, { running: false, report: r }).reason).toBe('idle');
    expect(commandAvailability(stop, { running: true, report: report('codex', [cap('interrupt', 'unknown')]) }).reason).toBe('capability');
  });

  it('interpreta las pistas de argumentos', () => {
    expect(parseArgumentHint('[on|off]')).toEqual([{ name: 'on|off', required: false, choices: ['on', 'off'] }]);
    expect(parseArgumentHint('<instruction>')).toEqual([{ name: 'instruction', required: true }]);
    expect(parseArgumentHint(null)).toEqual([]);
  });
});

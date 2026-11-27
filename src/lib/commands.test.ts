import { describe, expect, it } from 'vitest';
import {
  buildCommandRegistry, classifyClaudeCommand, commandAvailability, isImmediate, LOCAL_COMMANDS, localId, mayRunWithoutConfirmation,
  parseArgumentHint, providerCommandText, slashEntries, slashToken, type CommandContext,
} from './commands';
import type { AgentCapabilities, Capability, CapabilityStatus } from './types';

const cap = (id: Capability['id'], status: CapabilityStatus): Capability => ({ id, status, level: 'installation', integrated: 'no', source: 'test' });
const report = (agent: 'claude' | 'codex', caps: Capability[], commands: AgentCapabilities['commands'] = []): AgentCapabilities => ({
  agent, checkedAt: 1, stale: false, error: null, models: [], capabilities: caps, commands,
  installation: { agent, path: null, available: true, auth: { state: 'unknown' } },
});
const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  agent: 'claude', running: false, report: null, hasChat: true, hasProject: true, hasMessages: true,
  hasEffort: true, hasFast: false, queueBusy: false, ...over,
});
const CLAUDE_CAPS = [cap('compact', 'supported'), cap('quickCommands', 'supported'), cap('codeReview', 'supported'), cap('interrupt', 'supported'), cap('planning', 'supported'), cap('goals', 'supported')];
const claude = report('claude', CLAUDE_CAPS, [
  { name: 'compact', builtin: true, argumentHint: '<optional custom summarization instructions>' },
  { name: 'context', builtin: true },
  { name: 'code-review', builtin: true, argumentHint: '[<pr#>|<branch>|<path>]' },
  { name: 'config', builtin: true },
  { name: 'simplify', builtin: true },
  { name: 'superpowers:brainstorming', builtin: false, description: 'Ideas' },
]);

describe('Command Registry', () => {
  it('declara los 20 comandos de Duovra', () => {
    expect(LOCAL_COMMANDS.map((c) => c.name).sort()).toEqual([
      '/build', '/compact', '/context', '/diff', '/effort', '/fast', '/fork', '/goal', '/help', '/memory', '/model', '/new',
      '/permissions', '/plan', '/resume', '/review', '/status', '/stop', '/tasks', '/usage',
    ]);
    // Abrir vistas nunca consume créditos ni pide confirmación.
    for (const name of ['/status', '/tasks', '/memory']) {
      const c = LOCAL_COMMANDS.find((x) => x.name === name)!;
      expect([c.consumesCredits, c.requiresConfirmation, c.action]).toEqual([false, false, 'ui']);
    }
    // Ningún comando local consume cuota sin confirmación propia.
    for (const c of LOCAL_COMMANDS) if (c.consumesCredits) expect(c.requiresConfirmation).toBe(true);
  });

  it('clasifica los comandos de Claude Code y resuelve los conflictos de nombre', () => {
    expect(classifyClaudeCommand({ name: 'context', builtin: true })).toBe('duovra');
    expect(classifyClaudeCommand({ name: 'goal', builtin: true })).toBe('duovra');
    expect(classifyClaudeCommand({ name: 'config', builtin: true })).toBe('terminal');
    expect(classifyClaudeCommand({ name: 'code-review', builtin: true })).toBe('duovra');
    expect(classifyClaudeCommand({ name: 'simplify', builtin: true })).toBe('unknown');
    expect(classifyClaudeCommand({ name: 'superpowers:brainstorming', builtin: false })).toBe('custom');
    const list = buildCommandRegistry('claude', claude);
    // Un solo «/compact» en el menú: el de Duovra.
    const menu = slashEntries(list, 'compact', ctx({ report: claude }));
    expect(menu.filter((e) => e.cmd.name === '/compact').map((e) => e.cmd.origin)).toEqual(['local']);
  });

  it('sin consulta solo muestra comandos de Duovra; los del proveedor aparecen al escribir', () => {
    const list = buildCommandRegistry('claude', claude);
    const all = slashEntries(list, '', ctx({ report: claude }));
    expect(all.every((e) => e.group === 'duovra')).toBe(true);
    const found = slashEntries(list, 'brain', ctx({ report: claude }));
    expect(found.map((e) => e.cmd.id)).toContain('claude:custom:superpowers:brainstorming');
    // Los de terminal y los que gestiona Duovra no se ofrecen, solo en la ayuda con su motivo.
    // El nombre exacto aparece, pero no disponible y con su motivo (Enter no lo envía como texto).
    expect(slashEntries(list, 'config', ctx({ report: claude })).map((e) => [e.cmd.id, e.available, e.reason])).toEqual([['claude:custom:config', false, 'terminal']]);
    expect(slashEntries(list, 'conf', ctx({ report: claude }))).toHaveLength(0);
    const help = slashEntries(list, 'config', ctx({ report: claude }), true).find((e) => e.cmd.id === 'claude:custom:config')!;
    expect(help).toMatchObject({ available: false, reason: 'terminal' });
  });

  it('filtra por estado de ejecución, capacidad y conversación', () => {
    const list = buildCommandRegistry('codex', report('codex', [cap('interrupt', 'supported'), cap('compact', 'supported'), cap('codeReview', 'unknown')]));
    const r = report('codex', [cap('interrupt', 'supported'), cap('compact', 'supported'), cap('codeReview', 'unknown')]);
    const idle = slashEntries(list, '', ctx({ agent: 'codex', report: r })).map((e) => e.cmd.name);
    expect(idle).not.toContain('/stop');
    expect(idle).not.toContain('/review'); // capacidad desconocida
    expect(idle).toContain('/compact');
    const running = slashEntries(list, '', ctx({ agent: 'codex', report: r, running: true })).map((e) => e.cmd.name);
    expect(running).toContain('/stop');
    expect(running).not.toContain('/compact');
    expect(slashEntries(list, 'fork', ctx({ agent: 'codex', report: r, hasMessages: false })).filter((e) => e.available)).toHaveLength(0);
    expect(slashEntries(list, 'fast', ctx({ agent: 'codex', report: r, hasFast: false }))[0]).toMatchObject({ available: false, reason: 'context' });
    // Codex no publica comandos propios.
    expect(list.filter((c) => c.origin === 'custom')).toHaveLength(0);
  });

  it('elegir una sugerencia nunca ejecuta algo que consuma o interrumpa', () => {
    const stop = LOCAL_COMMANDS.find((c) => c.name === '/stop')!;
    expect(isImmediate(stop)).toBe(false);
    for (const c of buildCommandRegistry('claude', claude).filter((x) => x.origin === 'custom')) {
      expect(isImmediate(c)).toBe(false);
      expect(mayRunWithoutConfirmation(c)).toBe(false);
    }
    // Lo inmediato solo abre interfaces existentes (compactar y revisar abren su confirmación).
    expect(localId(LOCAL_COMMANDS.find((c) => c.name === '/review')!)).toBe('review');
  });

  it('respeta el estado de ejecución y la capacidad', () => {
    const r = report('codex', [cap('interrupt', 'supported')]);
    const stop = buildCommandRegistry('codex', r).find((c) => c.id === 'codex:native:turn/interrupt')!;
    expect(commandAvailability(stop, { running: true, report: r }).available).toBe(true);
    expect(commandAvailability(stop, { running: false, report: r }).reason).toBe('idle');
    expect(commandAvailability(stop, { running: true, report: report('codex', [cap('interrupt', 'unknown')]) }).reason).toBe('capability');
  });

  it('texto del comando y token del menú', () => {
    const cmd = buildCommandRegistry('claude', claude).find((c) => c.id === 'claude:custom:superpowers:brainstorming')!;
    expect(providerCommandText(cmd, '  idea  ')).toBe('/superpowers:brainstorming idea');
    expect(providerCommandText(cmd, '')).toBe('/superpowers:brainstorming');
    expect(slashToken('/superpowers:br', 15)).toEqual({ query: 'superpowers:br', end: 15 });
    expect(slashToken('hola /x', 7)).toBeNull();
  });

  it('interpreta las pistas de argumentos', () => {
    expect(parseArgumentHint('[on|off]')).toEqual([{ name: 'on|off', required: false, choices: ['on', 'off'] }]);
    expect(parseArgumentHint('<instruction>')).toEqual([{ name: 'instruction', required: true }]);
    expect(parseArgumentHint(null)).toEqual([]);
  });
});

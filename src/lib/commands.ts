/**
 * Fundamentos del Command Registry (1.0.11, fase 1).
 *
 * Solo estructuras y reglas de compatibilidad: el menú «/» y la ejecución llegan en la fase 5.
 * Tres orígenes, siempre distinguibles:
 *  1. `local`: acciones de Duovra (no hablan con el proveedor).
 *  2. `native`: operaciones del proveedor que Duovra conoce y mapea a una capacidad del registro
 *     (`/compact` de Claude Code, `thread/compact/start` de Codex…).
 *  3. `custom`: comandos que la CLI comunica (skills, plugins, comandos del usuario). Se describen,
 *     nunca se ejecutan solos: `requiresConfirmation` siempre es verdadero.
 *
 * Nada de este módulo invoca al proveedor.
 */
import type { AgentCapabilities, AgentId, Capability, CapabilityId, ProviderCommand } from './types';

export type CommandOrigin = 'local' | 'native' | 'custom';
/** Cómo se ejecutaría: acción de la interfaz, método del protocolo o texto enviado al agente. */
export type CommandAction = 'ui' | 'protocol' | 'prompt';

export interface CommandArg {
  name: string;
  required: boolean;
  hint?: string;
  choices?: string[];
}

export interface CommandSpec {
  /** Único en todo el registro: `duovra:…`, `claude:native:compact`, `claude:custom:<nombre>`. */
  id: string;
  name: string;
  description: string | null;
  /** `null` en las acciones locales de Duovra. */
  provider: AgentId | null;
  origin: CommandOrigin;
  /** Capacidad del registro que debe estar disponible; `null` si no depende de ninguna. */
  capability: CapabilityId | null;
  args: CommandArg[];
  action: CommandAction;
  /** Estados de ejecución en los que tiene sentido. */
  when: { idle: boolean; running: boolean };
  requiresConfirmation: boolean;
  consumesCredits: boolean;
  /** Duovra ya sabe ejecutarlo. En la fase 1 ninguno lo está. */
  integrated: boolean;
}

/** Acciones locales: se declararán en la fase 5. */
export const LOCAL_COMMANDS: readonly CommandSpec[] = [];

type Native = Omit<CommandSpec, 'id' | 'provider' | 'origin' | 'integrated'> & { providerName: string };

/** Operaciones nativas conocidas por proveedor. Cada una exige su capacidad en el registro. */
const NATIVE: Record<AgentId, Native[]> = {
  claude: [
    { providerName: 'compact', name: '/compact', description: null, capability: 'compact', action: 'prompt', args: [{ name: 'instrucciones', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true },
    { providerName: 'code-review', name: '/code-review', description: null, capability: 'codeReview', action: 'prompt', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true },
    { providerName: 'goal', name: '/goal', description: null, capability: 'goals', action: 'prompt', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: false },
  ],
  codex: [
    { providerName: 'thread/compact/start', name: '/compact', description: null, capability: 'compact', action: 'protocol', args: [], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true },
    { providerName: 'review/start', name: '/review', description: null, capability: 'codeReview', action: 'protocol', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true },
    { providerName: 'thread/goal/set', name: '/goal', description: null, capability: 'goals', action: 'protocol', args: [{ name: 'objetivo', required: true }], when: { idle: true, running: true }, requiresConfirmation: true, consumesCredits: false },
    { providerName: 'turn/interrupt', name: '/stop', description: null, capability: 'interrupt', action: 'protocol', args: [], when: { idle: false, running: true }, requiresConfirmation: false, consumesCredits: false },
  ],
};

const usable = (c: Capability | undefined) => c?.status === 'supported' || c?.status === 'experimental';

/** Argumentos a partir de la pista de la CLI (`[interval] [prompt]`, `<instruction>`). */
export function parseArgumentHint(hint: string | null | undefined): CommandArg[] {
  if (!hint) return [];
  return [...hint.matchAll(/([[<])([^\]>]+)[\]>]/g)].map(([, open, body]) => {
    const choices = body.includes('|') ? body.split('|').map((x) => x.trim()).filter(Boolean) : undefined;
    return { name: choices ? choices.join('|') : body.trim(), required: open === '<', ...(choices ? { choices } : {}) };
  });
}

/** Registro de comandos de un proveedor según su informe de capacidades. Sin informe, solo locales. */
export function buildCommandRegistry(agent: AgentId, report: AgentCapabilities | null): CommandSpec[] {
  const out: CommandSpec[] = [...LOCAL_COMMANDS];
  if (!report || report.agent !== agent) return out;
  const caps = new Map(report.capabilities.map((c) => [c.id, c]));
  const covered = new Set<string>();
  for (const n of NATIVE[agent]) {
    if (!usable(caps.get(n.capability!))) continue;
    const { providerName, ...spec } = n;
    covered.add(providerName);
    out.push({ ...spec, id: `${agent}:native:${providerName}`, provider: agent, origin: 'native', integrated: false });
  }
  for (const c of report.commands ?? []) out.push(...describeProviderCommand(agent, c, covered));
  return out;
}

function describeProviderCommand(agent: AgentId, c: ProviderCommand, covered: Set<string>): CommandSpec[] {
  if (!c?.name || covered.has(c.name)) return [];
  return [{
    id: `${agent}:custom:${c.name}`,
    name: `/${c.name}`,
    description: c.description ?? null,
    provider: agent,
    // Los integrados de la CLI que Duovra no mapea también se tratan como texto para el agente.
    origin: 'custom',
    capability: 'quickCommands',
    args: parseArgumentHint(c.argumentHint),
    action: 'prompt',
    when: { idle: true, running: false },
    requiresConfirmation: true,
    consumesCredits: true,
    integrated: false,
  }];
}

export interface Availability {
  available: boolean;
  reason?: 'notIntegrated' | 'running' | 'idle' | 'capability';
}

/** Si un comando puede ofrecerse ahora. Un comando no integrado nunca está disponible. */
export function commandAvailability(cmd: CommandSpec, ctx: { running: boolean; report: AgentCapabilities | null }): Availability {
  if (cmd.capability && cmd.provider) {
    const cap = ctx.report?.agent === cmd.provider ? ctx.report.capabilities.find((c) => c.id === cmd.capability) : undefined;
    if (!usable(cap)) return { available: false, reason: 'capability' };
  }
  if (ctx.running && !cmd.when.running) return { available: false, reason: 'running' };
  if (!ctx.running && !cmd.when.idle) return { available: false, reason: 'idle' };
  if (!cmd.integrated) return { available: false, reason: 'notIntegrated' };
  return { available: true };
}

/** Ningún comando descubierto se ejecuta sin una acción explícita y confirmada del usuario. */
export function mayRunWithoutConfirmation(cmd: CommandSpec): boolean {
  return cmd.origin === 'local' && !cmd.requiresConfirmation && !cmd.consumesCredits;
}

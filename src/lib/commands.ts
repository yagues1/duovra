/**
 * Command Registry (1.0.11, fases 1 y 5).
 *
 * Tres orígenes, siempre distinguibles:
 *  1. `local`: comandos de Duovra. Reutilizan interfaces existentes (selectores, Workbench, memoria…)
 *     o métodos oficiales del proveedor (`review/start`, `thread/compact/start`, `turn/interrupt`).
 *  2. `native`: operaciones del proveedor que Duovra conoce y mapea a una capacidad del registro.
 *  3. `custom`: comandos que la CLI comunica. Solo Claude Code los publica (`initialize.commands`).
 *
 * Clasificación real de Claude Code 2.1.325 en modo `-p` + stream-json, comprobada con la CLI instalada
 * contra una API simulada (`scripts/qa/control-claude-protocol.mjs`, sin modelos):
 *  - `/context`, `/usage`, `/cost`, `/model`, `/effort`, `/goal`, `/fast`, `/clear`: se resuelven en la CLI
 *    sin petición a la API. `/fast` responde «not available in the Agent SDK». Duovra ya ofrece estas
 *    funciones con su propia interfaz, así que gana el comando de Duovra (conflicto explícito).
 *  - `/compact` y `/code-review` (`/review` es un alias): generan peticiones al modelo.
 *  - `/status`, `/help`, `/permissions`, `/memory`: «isn't available in this environment» (no figuran en
 *    `initialize.commands`).
 *  - Un comando inexistente se envía al modelo como texto: por eso Duovra nunca envía un «/algo»
 *    desconocido como comando.
 * El resto de comandos integrados no se ha ejecutado: su compatibilidad no está verificada.
 *
 * Nada de este módulo invoca al proveedor.
 */
import type { AgentCapabilities, AgentId, Capability, CapabilityId, ProviderCommand } from './types';
import { fuzzy } from './fuzzy';
import { tr } from '../i18n';

export type CommandOrigin = 'local' | 'native' | 'custom';
/** Cómo se ejecuta: acción de la interfaz, método del protocolo o texto enviado al agente. */
export type CommandAction = 'ui' | 'protocol' | 'prompt';
/** Compatibilidad de un comando del proveedor con la integración de Duovra. */
export type ProviderSupport = 'integrated' | 'duovra' | 'terminal' | 'custom' | 'unknown';

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
  /** `null` en los comandos de Duovra. */
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
  /** Duovra sabe ejecutarlo. */
  integrated: boolean;
  /** Comandos del proveedor: clasificación (fase 5). */
  support?: ProviderSupport;
  /** Comando de Duovra que atiende este nombre cuando el proveedor también lo publica. */
  handledBy?: string;
  /** Alias del proveedor. */
  aliases?: string[];
}

// ---------- Comandos de Duovra ----------

export type LocalCommandId =
  | 'compact' | 'context' | 'plan' | 'build' | 'model' | 'effort' | 'fast' | 'permissions' | 'review' | 'diff'
  | 'fork' | 'resume' | 'new' | 'memory' | 'usage' | 'tasks' | 'status' | 'stop' | 'goal' | 'help';

interface LocalDef {
  id: LocalCommandId;
  description: () => string;
  /** Selección inmediata: abre una interfaz existente o cambia un ajuste local reversible. El resto se
   * prepara en el compositor y requiere un envío explícito (Enter o botón). */
  immediate: boolean;
  when: { idle: boolean; running: boolean };
  capability?: CapabilityId;
  consumesCredits?: boolean;
  requiresConfirmation?: boolean;
  action?: CommandAction;
}

const LOCAL_DEFS: LocalDef[] = [
  { id: 'compact', description: () => tr('Compactar el contexto nativo del agente'), immediate: true, when: { idle: true, running: false }, capability: 'compact', consumesCredits: true, requiresConfirmation: true, action: 'protocol' },
  { id: 'context', description: () => tr('Ver la ocupación del contexto'), immediate: true, when: { idle: true, running: true } },
  { id: 'plan', description: () => tr('Activar el modo Planificar'), immediate: true, when: { idle: true, running: true }, capability: 'planning' },
  { id: 'build', description: () => tr('Activar el modo Construir'), immediate: true, when: { idle: true, running: true } },
  { id: 'model', description: () => tr('Elegir el modelo'), immediate: true, when: { idle: true, running: true } },
  { id: 'effort', description: () => tr('Elegir el nivel de razonamiento'), immediate: true, when: { idle: true, running: true } },
  { id: 'fast', description: () => tr('Elegir la velocidad del próximo mensaje'), immediate: true, when: { idle: true, running: true } },
  { id: 'permissions', description: () => tr('Abrir los permisos'), immediate: true, when: { idle: true, running: true } },
  { id: 'review', description: () => tr('Solicitar una revisión de código'), immediate: true, when: { idle: true, running: false }, capability: 'codeReview', consumesCredits: true, requiresConfirmation: true, action: 'protocol' },
  { id: 'diff', description: () => tr('Ver los cambios en Workbench'), immediate: true, when: { idle: true, running: true } },
  { id: 'fork', description: () => tr('Bifurcar la conversación'), immediate: true, when: { idle: true, running: false } },
  { id: 'resume', description: () => tr('Recuperar una sesión del agente'), immediate: true, when: { idle: true, running: true } },
  { id: 'new', description: () => tr('Nueva conversación'), immediate: true, when: { idle: true, running: true } },
  { id: 'memory', description: () => tr('Abrir la memoria compartida'), immediate: true, when: { idle: true, running: true } },
  { id: 'usage', description: () => tr('Consultar el uso'), immediate: true, when: { idle: true, running: true } },
  { id: 'tasks', description: () => tr('Ver las tareas del turno'), immediate: true, when: { idle: true, running: true } },
  { id: 'status', description: () => tr('Ver la actividad de los agentes'), immediate: true, when: { idle: true, running: true } },
  { id: 'stop', description: () => tr('Detener la ejecución'), immediate: false, when: { idle: false, running: true }, capability: 'interrupt', action: 'protocol' },
  { id: 'goal', description: () => tr('Gestionar el objetivo de la conversación'), immediate: true, when: { idle: true, running: true } },
  { id: 'help', description: () => tr('Ver los comandos disponibles'), immediate: true, when: { idle: true, running: true } },
];

export const LOCAL_COMMANDS: readonly CommandSpec[] = LOCAL_DEFS.map((d) => ({
  id: `duovra:${d.id}`,
  name: `/${d.id}`,
  get description() { return d.description(); },
  provider: null,
  origin: 'local' as const,
  capability: d.capability ?? null,
  args: [],
  action: d.action ?? 'ui',
  when: d.when,
  requiresConfirmation: d.requiresConfirmation ?? false,
  consumesCredits: d.consumesCredits ?? false,
  integrated: true,
}));

export function localId(cmd: CommandSpec): LocalCommandId | null {
  return cmd.origin === 'local' ? (cmd.id.slice('duovra:'.length) as LocalCommandId) : null;
}

export function isImmediate(cmd: CommandSpec): boolean {
  const id = localId(cmd);
  return !!id && !!LOCAL_DEFS.find((d) => d.id === id)?.immediate;
}

// ---------- Clasificación de Claude Code ----------

/** Nombres de Claude Code que atiende un comando de Duovra (conflictos resueltos de forma explícita). */
export const CLAUDE_HANDLED_BY: Readonly<Record<string, LocalCommandId>> = {
  compact: 'compact', context: 'context', model: 'model', effort: 'effort', fast: 'fast', goal: 'goal',
  usage: 'usage', cost: 'usage', 'code-review': 'review', review: 'review', clear: 'new',
};

/**
 * Integrados de Claude Code que gestionan la propia CLI (configuración, sesión, cuenta, interfaz de la
 * terminal, flujos remotos). Duovra no los envía: cambiarían el estado de la CLI por detrás de la app.
 */
export const CLAUDE_TERMINAL_ONLY: ReadonlySet<string> = new Set([
  'agents', 'config', 'color', 'focus', 'heapdump', 'mcp', 'import', 'rename', 'output-style', 'advisor', 'autocompact',
  'auto-mode-setup', 'reload-plugins', 'reload-skills', '__remote-workflow', 'workflow-launch-exec', 'design-consent',
  'design-revoke', 'usage-credits', 'extra-usage', 'doctor', 'skill-doctor', 'list-agents', 'team-onboarding', 'schedule',
  'update-config', 'fewer-permission-prompts', 'ultrareview', 'loop', 'plugin-authoring', 'run-skill-generator',
  'status', 'help', 'permissions', 'memory', 'resume', 'login', 'logout', 'exit', 'quit', 'init', 'install-github-app',
]);

/** Integrados que la CLI resuelve en modo stream-json y Duovra puede enviar tal cual (verificados con la API simulada). */
export const CLAUDE_VERIFIED_PROMPT: ReadonlySet<string> = new Set(['code-review', 'review']);

export function classifyClaudeCommand(c: ProviderCommand): ProviderSupport {
  if (CLAUDE_HANDLED_BY[c.name]) return 'duovra';
  if (CLAUDE_TERMINAL_ONLY.has(c.name)) return 'terminal';
  if (CLAUDE_VERIFIED_PROMPT.has(c.name)) return 'integrated';
  return c.builtin ? 'unknown' : 'custom';
}

// ---------- Operaciones nativas por proveedor ----------

type Native = Omit<CommandSpec, 'id' | 'provider' | 'origin' | 'integrated'> & { providerName: string; integrated: boolean };

/** Operaciones nativas conocidas por proveedor. Cada una exige su capacidad en el registro. */
const NATIVE: Record<AgentId, Native[]> = {
  claude: [
    { providerName: 'compact', name: '/compact', description: null, capability: 'compact', action: 'prompt', args: [{ name: 'instrucciones', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true, integrated: true },
    { providerName: 'code-review', name: '/code-review', description: null, capability: 'codeReview', action: 'prompt', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true, integrated: true },
    // `/goal` de Claude Code inicia trabajo autónomo hasta cumplir una condición: Duovra no lo usa.
    { providerName: 'goal', name: '/goal', description: null, capability: 'goals', action: 'prompt', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true, integrated: false },
  ],
  codex: [
    { providerName: 'thread/compact/start', name: '/compact', description: null, capability: 'compact', action: 'protocol', args: [], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true, integrated: true },
    { providerName: 'review/start', name: '/review', description: null, capability: 'codeReview', action: 'protocol', args: [{ name: 'objetivo', required: false }], when: { idle: true, running: false }, requiresConfirmation: true, consumesCredits: true, integrated: true },
    // Verificado con la API simulada: un objetivo activo inicia turnos autónomos al instante.
    { providerName: 'thread/goal/set', name: '/goal', description: null, capability: 'goals', action: 'protocol', args: [{ name: 'objetivo', required: true }], when: { idle: true, running: true }, requiresConfirmation: true, consumesCredits: true, integrated: false },
    { providerName: 'turn/interrupt', name: '/stop', description: null, capability: 'interrupt', action: 'protocol', args: [], when: { idle: false, running: true }, requiresConfirmation: false, consumesCredits: false, integrated: true },
  ],
};

const usable = (c: Capability | undefined) => c?.status === 'supported' || c?.status === 'experimental';

/** Argumentos a partir de la pista de la CLI (`[interval] [prompt]`, `<instruction>`). */
export function parseArgumentHint(hint: string | null | undefined): CommandArg[] {
  if (!hint) return [];
  return [...hint.matchAll(/([[<])([^\]>]+)[\]>]/g)].map(([, open, raw]) => {
    // `[<target>]`: el corchete exterior marca opcional; el nombre va sin `<`.
    const body = raw.replace(/^[<[]+/, '');
    const choices = body.includes('|') ? body.split('|').map((x) => x.trim()).filter(Boolean) : undefined;
    return { name: choices ? choices.join('|') : body.trim(), required: open === '<', ...(choices ? { choices } : {}) };
  });
}

/** Registro completo de un proveedor: comandos de Duovra, operaciones nativas y comandos comunicados. */
export function buildCommandRegistry(agent: AgentId, report: AgentCapabilities | null): CommandSpec[] {
  const out: CommandSpec[] = [...LOCAL_COMMANDS];
  if (!report || report.agent !== agent) return out;
  const caps = new Map(report.capabilities.map((c) => [c.id, c]));
  const covered = new Set<string>();
  for (const n of NATIVE[agent]) {
    if (!usable(caps.get(n.capability!))) continue;
    const { providerName, ...spec } = n;
    covered.add(providerName);
    out.push({ ...spec, id: `${agent}:native:${providerName}`, provider: agent, origin: 'native',
      ...(agent === 'claude' ? { support: classifyClaudeCommand({ name: providerName, builtin: true }), handledBy: CLAUDE_HANDLED_BY[providerName] ? `duovra:${CLAUDE_HANDLED_BY[providerName]}` : undefined } : {}) });
  }
  for (const c of report.commands ?? []) out.push(...describeProviderCommand(agent, c, covered));
  return out;
}

function describeProviderCommand(agent: AgentId, c: ProviderCommand, covered: Set<string>): CommandSpec[] {
  if (!c?.name || covered.has(c.name)) return [];
  const support = agent === 'claude' ? classifyClaudeCommand(c) : 'unknown';
  const handled = agent === 'claude' ? CLAUDE_HANDLED_BY[c.name] : undefined;
  return [{
    id: `${agent}:custom:${c.name}`,
    name: `/${c.name}`,
    description: c.description ?? null,
    provider: agent,
    origin: 'custom',
    capability: 'quickCommands',
    args: parseArgumentHint(c.argumentHint),
    action: 'prompt',
    when: { idle: true, running: false },
    requiresConfirmation: true,
    consumesCredits: true,
    integrated: support === 'integrated' || support === 'custom' || support === 'unknown',
    support,
    ...(handled ? { handledBy: `duovra:${handled}` } : {}),
    ...(c.aliases?.length ? { aliases: c.aliases } : {}),
  }];
}

export type UnavailableReason = 'notIntegrated' | 'running' | 'idle' | 'capability' | 'context' | 'terminal' | 'duovra';

export interface Availability {
  available: boolean;
  reason?: UnavailableReason;
}

/** Contexto de la conversación activa con el que se decide qué comandos se ofrecen. */
export interface CommandContext {
  agent: AgentId;
  running: boolean;
  report: AgentCapabilities | null;
  hasChat: boolean;
  hasProject: boolean;
  /** Hay mensajes desde los que bifurcar. */
  hasMessages: boolean;
  /** El modelo elegido ofrece niveles de razonamiento o modo rápido. */
  hasEffort: boolean;
  hasFast: boolean;
  /** Una compactación o revisión no puede empezar con la cola ocupada. */
  queueBusy: boolean;
}

/** Si un comando puede ofrecerse ahora. */
export function commandAvailability(cmd: CommandSpec, ctx: Pick<CommandContext, 'running' | 'report'> & Partial<CommandContext>): Availability {
  if (cmd.support === 'terminal') return { available: false, reason: 'terminal' };
  if (cmd.support === 'duovra') return { available: false, reason: 'duovra' };
  if (cmd.capability && (cmd.provider || cmd.origin === 'local')) {
    const agent = cmd.provider ?? ctx.agent ?? ctx.report?.agent;
    const cap = ctx.report && ctx.report.agent === agent ? ctx.report.capabilities.find((c) => c.id === cmd.capability) : undefined;
    if (!usable(cap)) return { available: false, reason: 'capability' };
  }
  if (ctx.running && !cmd.when.running) return { available: false, reason: 'running' };
  if (!ctx.running && !cmd.when.idle) return { available: false, reason: 'idle' };
  if (!cmd.integrated) return { available: false, reason: 'notIntegrated' };
  const id = localId(cmd);
  if (id && ctx.hasChat !== undefined) {
    const needsChat = !['new', 'help', 'usage', 'status', 'resume'].includes(id);
    if (needsChat && !ctx.hasChat) return { available: false, reason: 'context' };
    if ((id === 'new' || id === 'resume' || id === 'diff') && !ctx.hasProject) return { available: false, reason: 'context' };
    if (id === 'fork' && !ctx.hasMessages) return { available: false, reason: 'context' };
    if (id === 'effort' && !ctx.hasEffort) return { available: false, reason: 'context' };
    if (id === 'fast' && !ctx.hasFast) return { available: false, reason: 'context' };
    if ((id === 'compact' || id === 'review') && ctx.queueBusy) return { available: false, reason: 'running' };
  }
  return { available: true };
}

/** Ningún comando descubierto se ejecuta sin una acción explícita y confirmada del usuario. */
export function mayRunWithoutConfirmation(cmd: CommandSpec): boolean {
  return cmd.origin === 'local' && !cmd.requiresConfirmation && !cmd.consumesCredits;
}

// ---------- Menú «/» ----------

export interface SlashEntry {
  cmd: CommandSpec;
  group: 'duovra' | 'provider';
  available: boolean;
  reason?: UnavailableReason;
  score: number;
}

/** Máximo de comandos del proveedor sin búsqueda: el menú no muestra listas enormes por defecto. */
export const PROVIDER_PREVIEW = 0;

function score(query: string, cmd: CommandSpec): number {
  if (!query) return 0;
  const name = cmd.name.slice(1).toLowerCase();
  const q = query.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - name.length;
  if (cmd.aliases?.some((a) => a.toLowerCase().startsWith(q))) return 600;
  const m = fuzzy(q, name);
  if (m) return 300 + m.score;
  // En la descripción solo cuenta una coincidencia literal: la difusa traería demasiado ruido.
  const at = q.length >= 3 && cmd.description ? cmd.description.toLowerCase().indexOf(q) : -1;
  return at >= 0 ? 100 - Math.min(at, 99) : -1;
}

/**
 * Entradas del menú para una consulta. Sin `help` solo aparecen las compatibles; con `help`, todas
 * (las no disponibles con su motivo). Los comandos del proveedor solo aparecen al escribir.
 */
export function slashEntries(registry: CommandSpec[], query: string, ctx: CommandContext, help = false): SlashEntry[] {
  const q = query.trim();
  const out: SlashEntry[] = [];
  for (const cmd of registry) {
    if (cmd.origin === 'native') continue; // Los atiende el comando de Duovra equivalente.
    const s = score(q, cmd);
    if (q && s < 0) continue;
    const group = cmd.origin === 'local' ? 'duovra' : 'provider';
    if (group === 'provider' && !q && !help) continue;
    const a = commandAvailability(cmd, ctx);
    // Fuera de la ayuda, lo no disponible solo aparece si el nombre coincide exactamente (con su motivo):
    // así Enter nunca envía «/review» como texto cuando el comando existe pero no se puede usar ahora.
    if (!a.available && !help && s !== 1000) continue;
    out.push({ cmd, group, available: a.available, reason: a.reason, score: s });
  }
  const order = (e: SlashEntry) => (e.group === 'duovra' ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b) || b.score - a.score || Number(b.available) - Number(a.available)
    || a.cmd.name.localeCompare(b.cmd.name));
}

/** Texto con el comando elegido y sus argumentos, tal como se enviaría al proveedor. */
export function providerCommandText(cmd: CommandSpec, args: string): string {
  const rest = args.trim();
  return rest ? `${cmd.name} ${rest}` : cmd.name;
}

/** El texto empieza por «/palabra» al principio del mensaje y el cursor está dentro de esa palabra. */
export function slashToken(text: string, caret: number): { query: string; end: number } | null {
  const m = /^\/([\p{L}\p{N}:_.-]*)/u.exec(text);
  if (!m || caret < 1 || caret > m[0].length) return null;
  return { query: m[1], end: m[0].length };
}

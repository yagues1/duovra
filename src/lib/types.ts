import type { Permissions } from './permissions';
// Tipos compartidos con el backend (src-tauri). Los nombres siguen el JSON en camelCase.

export type AgentId = 'claude' | 'codex';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastAgent: AgentId | null;
  lastModel: string | null;
  lastEffort: string | null;
  /** Última combinación usada con cada agente en esta conversación (AUD-004). */
  agentPrefs?: Partial<Record<AgentId, AgentPref>>;
  draft: string;
  draftAttachments?: string[];
  /** Permisos elegidos en el compositor para cada agente (1.0.9). */
  permissionPrefs?: Partial<Record<AgentId, Permissions>>;
  /** Tiene mensajes. Sin ellos es un chat provisional que no aparece en la lista (1.0.9). */
  started?: boolean;
  /** Worktree en el que trabaja (1.0.9). Sin él: directorio principal del proyecto. */
  worktreeId?: string | null;
  /** Transferencia de contexto compartido (1.0.11). Vacío: modo automático. */
  contextPrefs?: Partial<import('./context').ContextPrefs>;
  /** Fijada en la barra lateral (1.0.11, fase 3): momento en que se fijó. */
  pinnedAt?: number | null;
  /** Archivada (1.0.11, fase 3): fuera de la lista habitual; se conserva todo. */
  archivedAt?: number | null;
  /** Procedencia (1.0.11, fase 3): bifurcación o importación. Vacío en las demás. */
  origin?: ConversationOrigin;
  /** Modo de trabajo de cada agente (1.0.11, fase 4). Sin entrada: Construir. */
  workModes?: Partial<Record<AgentId, import('./interactions').WorkMode>>;
}

/** Continuación nativa de un agente en una bifurcación o importación (interno). */
export interface NativeContinuation {
  state: 'pending' | 'native' | 'rebuild' | 'rebuilt';
  reason?: string;
}

export type ConversationOrigin =
  | Record<string, never>
  | { kind: 'fork'; purpose: 'fork' | 'edit' | 'regenerate'; conversationId: string; title: string; messageId: string; seq: number; createdAt: number; native?: Partial<Record<AgentId, NativeContinuation>> }
  | { kind: 'import'; agent: AgentId; sessionId: string; importedAt: number; meta?: { cwd?: string | null; title?: string | null; model?: string | null }; native?: Partial<Record<AgentId, NativeContinuation>> };

export interface AgentPref {
  model: string;
  effort: string | null;
}

export type ItemKind =
  | 'text'
  | 'reasoning'
  | 'command'
  | 'file_change'
  | 'tool'
  | 'web_search'
  | 'plan'
  | 'plan_proposal'
  | 'question'
  | 'notice'
  | 'diff';

export type ItemStatus = 'running' | 'completed' | 'failed' | 'declined' | 'interrupted';

export interface FileChange {
  path: string;
  kind: string;
  diff?: string | null;
  oldText?: string | null;
  newText?: string | null;
}

export interface TimelineItem {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  text?: string | null;
  command?: string | null;
  description?: string | null;
  cwd?: string | null;
  output?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: FileChange[];
  tool?: string | null;
  input?: unknown;
  result?: unknown;
  query?: unknown;
  diff?: string | null;
  /** Plan o pregunta (fase 4): estado reflejado desde la interacción. */
  decision?: string | null;
  version?: number | null;
}

export type MessageStatus = 'done' | 'running' | 'interrupted' | 'cancelled' | 'failed';

export interface Usage {
  source?: AgentId;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  costUsd?: number | null;
  costKind?: 'estimate' | 'reported';
  durationMs?: number;
  turns?: number;
}

export interface ContextNote {
  mode: 'none' | 'shared';
  messages?: number;
  omitted?: number;
  agents?: AgentId[];
  chars?: number;
  sharedChars?: number;
  freshSession?: boolean;
  steer?: 'accepted' | 'unconfirmed';
  parentMessageId?: string;
  /** Fase 4: turno en modo Planificar o que implementa un plan aprobado. */
  workMode?: import('./interactions').WorkMode;
  approvedPlan?: { id: string; version: number; agent: AgentId };
  /** Context Engine 2.0 (1.0.11). */
  transfer?: import('./context').TransferMode;
  /** Entrega: preparada, confirmada, incierta o no enviada. */
  state?: 'prepared' | 'confirmed' | 'uncertain' | 'notSent';
  rebuilt?: boolean;
  budgetChars?: number;
  budgetSource?: 'default' | 'provider' | 'off';
  pendingMessages?: number;
  memories?: number;
  memoriesKnown?: number;
  memoriesUpdated?: number;
  instructions?: number;
  retracted?: number;
  estimatedTokens?: number;
  uncertainResend?: boolean;
  warnings?: import('./context').ContextWarning[];
  /** Encargo de memoria de Duovra (resumen o reorganización). */
  purpose?: import('./context').MemoryPurpose;
}

export interface Attachment {
  path: string;
  name: string;
  image: boolean;
  projectReference?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  agent: AgentId | null;
  model: string | null;
  effort: string | null;
  content: string;
  items: TimelineItem[] | null;
  status: MessageStatus;
  error: string | null;
  usage: Usage | null;
  contextNote: ContextNote | null;
  attachments: Attachment[] | null;
  createdAt: number;
  completedAt: number | null;
}

export interface SendRequest {
  conversationId: string;
  agent: AgentId;
  model: string;
  effort: string | null;
  text: string;
  attachments: string[];
  /** Velocidad capturada al enviar: null si el modelo no la ofrece, `default` o el modo rápido. */
  speed?: string | null;
  /** Permisos explícitos de este mensaje (1.0.9). Ausentes en encargos anteriores: ajustes globales. */
  permissions?: Permissions;
  /** Encargo de memoria (1.0.11): siempre directo y en solo lectura. */
  purpose?: import('./context').MemoryPurpose;
  /** Modo de trabajo (1.0.11, fase 4). Ausente: Construir. */
  workMode?: import('./interactions').WorkMode;
}

export interface QueueEntry {
  id: string;
  projectId: string;
  position: number;
  state: 'pending' | 'running' | 'blocked' | 'review';
  detail: string | null;
  messageId: string | null;
  createdAt: number;
  input: {
    request: SendRequest;
    target: { accountId: string | null; label: string };
    attachments: Attachment[];
    captureError: string | null;
    effectiveEffort: string | null;
  };
}

export interface QueueView {
  entries: QueueEntry[];
  pauseReason: string | null;
  reviewMessageId: string | null;
}

export type QueueAction =
  | { type: 'pause' | 'resume' | 'clear' }
  | { type: 'remove' | 'retry'; id: string }
  | { type: 'move'; id: string; before: string | null };

export interface ProviderSession {
  conversationId: string;
  agent: AgentId;
  sessionId: string;
  lastSeq: number;
  accountId: string | null;
  uncertainSeq?: number | null;
  nativeContext?: Record<string, unknown>;
}

export interface Account {
  id: string;
  agent: AgentId;
  label: string;
  configDir: string | null;
  createdAt: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string | null;
  resolved?: string | null;
  efforts: string[];
  defaultEffort?: string | null;
  isDefault?: boolean;
  notice?: string | null;
  /** Solo Codex lo informa (`inputModalities`); null cuando el proveedor no lo indica. */
  inputModalities?: string[] | null;
  /** Modo rápido que publica el proveedor para este modelo (Codex `serviceTiers`, Claude `supportsFastMode`). */
  fast?: { id: string; label: string; description?: string | null } | null;
  /** Identificador exacto según el proveedor (Claude `resolvedModel`, Codex `model`). */
  exact?: string | null;
  /** `id` es un alias que el proveedor resuelve a `exact` (`opus`, `default`…). */
  alias?: boolean;
  /** Modelo que el proveedor propone como sustituto (Codex `upgrade`). */
  upgrade?: string | null;
  /** Ventana de contexto, solo si el proveedor la informa en el catálogo. */
  contextWindow?: number | null;
  /** Rasgos declarados por el proveedor; ausentes cuando no los comunica. */
  traits?: Partial<Record<'effort' | 'adaptiveThinking' | 'autoMode' | 'thinkingOff', boolean>> & { multiAgent?: string | null };
}

export interface ModelCatalog {
  source: string;
  models: ModelInfo[];
  account?: unknown;
  version?: string;
  permissionMode?: string;
  /** Entradas descartadas por no tener un identificador válido. */
  skipped?: number;
  /** Momento de la última consulta confirmada (ms). */
  checkedAt?: number;
  /** La última consulta falló: son los últimos datos válidos, no información confirmada ahora. */
  stale?: boolean;
  staleReason?: string;
}

/** Registro de capacidades (1.0.11). `status` describe al proveedor; `integrated`, a Duovra. */
export type CapabilityStatus = 'supported' | 'unsupported' | 'experimental' | 'unknown';
export type CapabilityLevel = 'installation' | 'account' | 'model' | 'run';
export type CapabilityId =
  | 'streaming' | 'imageInput' | 'resume' | 'fork' | 'sessionList' | 'sessionRead' | 'compact' | 'planning'
  | 'interactiveQuestions' | 'steering' | 'interrupt' | 'quickCommands' | 'tasks' | 'subagents' | 'codeReview'
  | 'goals' | 'usageInfo' | 'rateLimits';

export interface Capability {
  id: CapabilityId;
  level: CapabilityLevel;
  status: CapabilityStatus;
  integrated: 'yes' | 'partial' | 'no';
  source: string;
  note?: string | null;
  checkedAt?: number;
}

/** Comando que comunica la CLI (Claude Code `initialize.commands`). Nunca se ejecuta solo. */
export interface ProviderCommand {
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  aliases?: string[] | null;
  builtin: boolean;
}

export interface AgentCapabilities {
  agent: AgentId;
  checkedAt: number;
  stale: boolean;
  error: string | null;
  source?: string;
  installation: {
    agent: AgentId;
    path: string | null;
    version?: string | null;
    available: boolean;
    protocol?: string;
    protocolVersion?: string | null;
    account?: { id: string | null; label: string | null; source: 'profile' | 'cli' };
    auth: { state: 'signedIn' | 'signedOut' | 'unknown'; method?: string | null; plan?: string | null };
    permissionMode?: string | null;
    methods?: number | null;
    experimentalMethods?: number;
    checkedAt?: number;
  };
  models: ModelInfo[];
  capabilities: Capability[];
  commands: ProviderCommand[];
  limitations?: { id: string; detail?: unknown }[];
}

export interface AgentDetection {
  agent: AgentId;
  installed: boolean;
  path: string | null;
  version: string | null;
  working: boolean;
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalInfo {
  agent: AgentId;
  kind: string;
  tool?: string;
  itemId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: unknown;
  changes?: FileChange[] | null;
  input?: unknown;
  permissions?: unknown;
  options: ApprovalDecision[];
  /** La ejecución está en modo plan (Claude Code pide aprobación para lo que no es de solo lectura). */
  planMode?: boolean;
}

export interface Approval {
  approvalId: string;
  info: ApprovalInfo;
}

export interface RunView {
  ready?: boolean;
  steerable?: boolean;
  runId: string;
  conversationId: string;
  messageId: string;
  agent: AgentId;
  model: string;
  items: TimelineItem[];
  usage: Usage | null;
  approvals: Approval[];
  resolvedModel?: string;
  startedAt: number;
  stopping?: boolean;
}

export interface UsageRow {
  agent: AgentId;
  model: string;
  runs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type Intensity = 'reduced' | 'balanced' | 'full';

export interface Settings {
  'appearance.intensity'?: Intensity | 'auto';
  'appearance.animations'?: boolean;
  'appearance.background'?: boolean;
  /** Ajuste anterior a los presets. Solo «off» desactiva el fondo. */
  'appearance.backdrop'?: string;
  'appearance.fontScale'?: number;
  'ui.sidebarCollapsed'?: boolean;
  'ui.lastProjectId'?: string | null;
  'ui.lastConversationId'?: string | null;
  'codex.approvalPolicy'?: string;
  'codex.sandbox'?: string;
  'claude.permissionMode'?: string;
  'agents.claude.path'?: string;
  'agents.codex.path'?: string;
  'accounts.active.claude'?: string | null;
  'accounts.active.codex'?: string | null;
  'defaults.agent'?: AgentId;
  'defaults.model.claude'?: string;
  'defaults.model.codex'?: string;
  'defaults.effort.claude'?: string;
  'defaults.effort.codex'?: string;
  [key: string]: unknown;
}

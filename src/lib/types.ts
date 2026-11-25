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
}

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
}

export interface ModelCatalog {
  source: string;
  models: ModelInfo[];
  account?: unknown;
  version?: string;
  permissionMode?: string;
  /** Entradas descartadas por no tener un identificador válido. */
  skipped?: number;
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

// Envoltorios tipados de los comandos Tauri.
import { invoke } from './tauriTransport';
import type { InsightUsageRow, RunInsights, UsageScope } from './insights';
import type { BackupSummary, RestoreNotice } from './backups';
import type { NativeNotice } from './nativeNotices';
import type { Permissions } from './permissions';
import type { Answer, Interaction, PlanAction, WorkMode } from './interactions';
import type { GitWorktree, Integration, RemovalCheck, Worktree, WorktreeCreateRequest, WorktreePreflight, WorktreeStatus } from './worktrees';
import type {
  Account,
  AgentDetection,
  AgentId,
  ApprovalDecision,
  Conversation,
  Message,
  ModelCatalog,
  AgentCapabilities,
  Project,
  ProviderSession,
  QueueAction,
  QueueView,
  SendRequest,
  Settings,
  UsageRow,
} from './types';
import { trBackend } from '../i18n/backend';
import type { ContextPrefs, ContextStatus, Memory, MemoryCategory, ProposedMemory } from './context';

export interface Bootstrap {
  projects: Project[];
  conversations: Conversation[];
  worktrees?: Worktree[];
  /** Proyectos dentro de un repositorio Git (comprobación de disco). */
  gitProjects?: string[];
  settings: Settings;
  accounts: Account[];
  activeRuns: Array<{ runId: string; conversationId: string; messageId: string; agent: AgentId; model: string; items: never[] }>;
  appVersion: string;
  qaMode?: 'native' | 'fixture' | null;
  /** Resultado de la última restauración aplicada al iniciar; se muestra una vez. */
  restoreNotice?: RestoreNotice | null;
}

export interface SendResult {
  runId: string;
  userMessage: Message;
  assistantMessage: Message;
  renamedTitle: string | null;
}

/** Enviar inicia el turno si la conversación está libre; si no, el backend lo encola. */
export type SubmitResult = { mode: 'started'; started: SendResult } | { mode: 'queued'; queue: QueueView };

export interface ConversationMatch { conversationId: string; messageId: string; title: string; project: string; snippet: string }
export interface WorkspaceEntry { path: string; name: string; directory: boolean }
export interface WorkspaceListing { entries: WorkspaceEntry[]; limited: boolean }
export interface WorkspaceDocument {
  path: string; relative: string; revision: string | null; size: number; truncated: boolean; binary: boolean; content: string;
}
export interface GitEntry { path: string; index: string; worktree: string }
export interface GitStatus { repository: boolean; branch: string; initial: boolean; limited: boolean; entries: GitEntry[] }
export type GitScope = 'staged' | 'unstaged' | 'untracked';

export const api = {
  bootstrap: () => invoke<Bootstrap>('bootstrap'),
  createProject: (name: string, path: string) => invoke<Project>('create_project', { name, path }),
  renameProject: (id: string, name: string) => invoke<void>('rename_project', { id, name }),
  deleteProject: (id: string) => invoke<void>('delete_project', { id }),
  createConversation: (projectId: string, title?: string, worktreeId?: string | null) =>
    invoke<Conversation>('create_conversation', { projectId, title, worktreeId: worktreeId ?? null }),
  worktreePreflight: (projectId: string, request?: WorktreeCreateRequest) =>
    invoke<WorktreePreflight>('worktree_preflight', { projectId, request: request ?? null }),
  worktreeCreate: (projectId: string, request: WorktreeCreateRequest) => invoke<Worktree>('worktree_create', { projectId, request }),
  worktreeImportable: (projectId: string) => invoke<GitWorktree[]>('worktree_importable', { projectId }),
  worktreeImport: (projectId: string, path: string) => invoke<Worktree>('worktree_import', { projectId, path }),
  worktreeRename: (id: string, label: string) => invoke<void>('worktree_rename', { id, label }),
  worktreeStatus: (id: string) => invoke<WorktreeStatus>('worktree_status', { id }),
  worktreeSize: (id: string) => invoke<{ bytes: number; partial: boolean }>('worktree_size', { id }),
  worktreeRemovalCheck: (id: string) => invoke<RemovalCheck>('worktree_removal_check', { id }),
  worktreeRemove: (id: string, deleteDir: boolean, deleteBranch: boolean) =>
    invoke<void>('worktree_remove', { id, deleteDir, deleteBranch }),
  worktreeRepair: (id: string, path: string) => invoke<Worktree>('worktree_repair', { id, path }),
  worktreeIntegration: (id: string) => invoke<Integration>('worktree_integration', { id }),
  renameConversation: (id: string, title: string) => invoke<void>('rename_conversation', { id, title }),
  deleteConversation: (id: string) => invoke<void>('delete_conversation', { id }),
  listMessages: (conversationId: string) =>
    invoke<{ messages: Message[]; sessions?: ProviderSession[] }>('list_messages', { conversationId, includeSessions: false }),
  searchConversations: (query: string) => invoke<ConversationMatch[]>('search_conversations', { query }),
  setDraft: (conversationId: string, draft: string) => invoke<void>('set_draft', { conversationId, draft }),
  setDraftAttachments: (conversationId: string, paths: string[]) => invoke<void>('set_draft_attachments', { conversationId, paths }),
  setConversationPrefs: (conversationId: string, agent: AgentId, model: string, effort: string | null) =>
    invoke<void>('set_conversation_prefs', { conversationId, agent, model, effort }),
  setConversationPermissions: (conversationId: string, agent: AgentId, permissions: Permissions) =>
    invoke<void>('set_conversation_permissions', { conversationId, agent, permissions }),
  discardEmptyConversation: (id: string) => invoke<boolean>('discard_empty_conversation', { id }),
  forgetProviderSession: (conversationId: string, agent: AgentId) =>
    invoke<void>('forget_provider_session', { conversationId, agent }),
  setSetting: (key: string, value: unknown) => invoke<void>('set_setting', { key, value }),
  detectAgents: () => invoke<AgentDetection[]>('detect_agents'),
  agentModels: (agent: AgentId, refresh = false) => invoke<ModelCatalog>('agent_models', { agent, refresh }),
  agentCapabilities: (agent: AgentId, refresh = false) => invoke<AgentCapabilities>('agent_capabilities', { agent, refresh }),
  agentAccount: (agent: AgentId) => invoke<Record<string, unknown>>('agent_account', { agent }),
  codexRateLimits: () => invoke<Record<string, unknown>>('codex_rate_limits'),
  startLogin: (agent: AgentId) => invoke<Record<string, unknown>>('start_login', { agent }),
  usageSummary: (days = 30) => invoke<{ days: number; rows: UsageRow[] }>('usage_summary', { days }),
  runInsights: (messageId: string) => invoke<RunInsights | null>('run_insights', { messageId }),
  insightsUsage: (scope: UsageScope) => invoke<InsightUsageRow[]>('insights_usage', { scope }),
  insightsTimeline: (scope: { since: number; bucketMs: number; offsetMs: number }) =>
    invoke<import('./stats').TimelineRow[]>('insights_timeline', { scope }),
  addAccount: (agent: AgentId, label: string, configDir: string | null) =>
    invoke<{ accounts: Account[] }>('add_account', { agent, label, configDir }),
  removeAccount: (id: string) => invoke<{ accounts: Account[] }>('remove_account', { id }),
  sendMessage: (request: SendRequest) => invoke<SendResult>('send_message', { request }),
  submitMessage: (id: string, request: SendRequest, accountId: string | null) =>
    invoke<SubmitResult>('submit_message', { id, request, accountId }),
  messageQueue: (conversationId: string) => invoke<QueueView>('message_queue', { conversationId }),
  enqueueMessage: (id: string, request: SendRequest, accountId: string | null, defer: boolean) =>
    invoke<QueueView>('enqueue_message', { id, request, accountId, defer }),
  editQueuedMessage: (id: string, request: SendRequest, replaceTarget: boolean, accountId: string | null) =>
    invoke<QueueView>('edit_queued_message', { id, request, replaceTarget, accountId }),
  updateMessageQueue: (conversationId: string, action: QueueAction) =>
    invoke<QueueView>('update_message_queue', { conversationId, action }),
  reconcileQueuedMessage: (conversationId: string, id: string) =>
    invoke<string>('reconcile_queued_message', { conversationId, id }),
  /** `confirmed` con acuse del turno; `uncertain` sin acuse (queda registrada como no confirmada). */
  steerRun: (runId: string, text: string, attachments: string[]) => invoke<'confirmed' | 'uncertain'>('steer_run', { runId, text, attachments }),
  interruptAndSubmit: (runId: string, request: SendRequest) => invoke<SubmitResult>('interrupt_and_submit', { runId, request }),
  goalSet: (conversationId: string, content: string) => invoke<import('./context').Memory>('goal_set', { conversationId, content }),
  cancelRun: (runId: string) => invoke<void>('cancel_run', { runId }),
  respondApproval: (approvalId: string, decision: ApprovalDecision) =>
    invoke<void>('respond_approval', { approvalId, decision }),
  setConversationWorkMode: (conversationId: string, agent: AgentId, mode: WorkMode) =>
    invoke<void>('set_conversation_work_mode', { conversationId, agent, mode }),
  listInteractions: (conversationId: string) => invoke<Interaction[]>('list_interactions', { conversationId }),
  pendingInteractions: () => invoke<Array<{ conversationId: string; count: number }>>('pending_interactions'),
  answerQuestion: (interactionId: string, answers: Answer[]) => invoke<void>('answer_question', { interactionId, answers }),
  dismissQuestion: (interactionId: string) => invoke<void>('dismiss_question', { interactionId }),
  decidePlan: (interactionId: string, action: PlanAction, feedback: string | null, request: SendRequest | null) =>
    invoke<{ mode: 'native' | 'resolved' | 'started'; started?: SendResult }>('decide_plan', { interactionId, action, feedback, request }),
  inspectAttachments: (paths: string[]) =>
    invoke<Array<{ path: string; exists: boolean; isDir: boolean; size: number }>>('inspect_attachments', { paths }),
  workspaceList: (projectId: string, path = '') => invoke<WorkspaceListing>('workspace_list', { projectId, path }),
  workspaceCatalog: (projectId: string) => invoke<WorkspaceListing>('workspace_catalog', { projectId }),
  workspaceRead: (projectId: string, path: string, revision?: string) =>
    invoke<WorkspaceDocument | null>('workspace_read', { projectId, path, revision }),
  gitStatus: (projectId: string) => invoke<GitStatus>('workspace_git_status', { projectId }),
  gitDiff: (projectId: string, path: string, scope: GitScope) =>
    invoke<{ diff: string; limited: boolean }>('workspace_git_diff', { projectId, path, scope }),
  /** Ruta del archivo escrito, o `null` si el usuario cancela el selector. */
  exportConversation: (id: string, options?: ExportOptions) => invoke<string | null>('export_conversation', { id, options: options ?? null }),
  // Session Manager (1.0.11, fase 3)
  forkConversation: (request: ForkRequest) => invoke<Conversation>('fork_conversation', { request }),
  setConversationPinned: (id: string, pinned: boolean) => invoke<Conversation>('set_conversation_pinned', { id, pinned }),
  setConversationArchived: (id: string, archived: boolean) => invoke<Conversation>('set_conversation_archived', { id, archived }),
  importList: (target: ImportTarget, query: string, cursor: string | null) =>
    invoke<{ items: ExternalSession[]; nextCursor: string | null }>('import_list', { target, query, cursor }),
  importPreview: (target: ImportTarget, sessionId: string) =>
    invoke<{ messages: Array<{ role: 'user' | 'assistant'; text: string; model: string | null; createdAt: number }> }>('import_preview', { target, sessionId }),
  importSessions: (target: ImportTarget, projectId: string, worktreeId: string | null, sessions: string[], native: boolean) =>
    invoke<{ created: Conversation[]; failed: Array<{ sessionId: string; error: string }> }>('import_sessions', { target, projectId, worktreeId, sessions, native }),
  backupCreate: () => invoke<string | null>('backup_create'),
  backupPickRestore: () => invoke<BackupSummary | null>('backup_pick_restore'),
  /** Reinicia Duovra para aplicar la copia elegida; la promesa no llega a resolverse con éxito. */
  backupConfirmRestore: () => invoke<void>('backup_confirm_restore'),
  notifyNative: (notice: NativeNotice) => invoke<boolean>('notify_native', { notice }),
  // Context Engine 2.0 (1.0.11)
  memoryList: (conversationId: string, includeArchived = true) => invoke<Memory[]>('memory_list', { conversationId, includeArchived }),
  memorySave: (input: { id?: string; conversationId: string; content: string; category: MemoryCategory; priority: number; origin?: 'manual' | 'message'; sourceMessages?: string[] }) =>
    invoke<Memory>('memory_save', { input }),
  memoryArchive: (id: string, archived: boolean) => invoke<Memory>('memory_archive', { id, archived }),
  memoryDelete: (id: string) => invoke<void>('memory_delete', { id }),
  memoryHistory: (id: string) => invoke<MemoryHistory>('memory_history', { id }),
  memoryImport: (conversationId: string, sourceMessageId: string, items: ProposedMemory[], archive: string[]) =>
    invoke<Memory[]>('memory_import', { conversationId, sourceMessageId, items, archive }),
  setContextPrefs: (conversationId: string, prefs: Partial<Omit<ContextPrefs, 'mode'>> & { mode: ContextPrefs['mode'] | null }) =>
    invoke<Partial<ContextPrefs>>('set_context_prefs', { conversationId, prefs }),
  contextStatus: (conversationId: string, agent: AgentId, includeBlock = false) =>
    invoke<ContextStatus>('context_status', { conversationId, agent, includeBlock }),
  compactNative: (conversationId: string, agent: AgentId) => invoke<void>('compact_native', { conversationId, agent }),
};

export type ExportFormat = 'markdown' | 'json' | 'html' | 'memory';
export interface ExportOptions { format: ExportFormat; includeAttachments: boolean }
export interface ForkRequest {
  conversationId: string;
  messageId: string;
  purpose: 'fork' | 'edit' | 'regenerate';
  /** `same` (predeterminado), `main` o el id de un worktree. */
  space?: string;
  text?: string;
}
export interface ImportTarget { agent: AgentId; accountId: string | null }
export interface ExternalSession {
  sessionId: string;
  title: string;
  preview: string;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** Conversación de Duovra que ya contiene esta sesión. */
  conversationId: string | null;
}

export interface MemoryHistory {
  memory: Memory;
  revisions: Array<{ revision: number; category: MemoryCategory; content: string; priority: number; archived: boolean; anchorSeq: number; createdAt: number }>;
  sources: Array<{ id: string; seq: number; role: 'user' | 'assistant'; agent: AgentId | null; model: string | null; createdAt: number; excerpt: string }>;
}

/** Texto de un error para mostrarlo. Los mensajes fijos del backend se traducen (src/i18n/backend.ts). */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return trBackend(e);
  if (e instanceof Error) return trBackend(e.message);
  return JSON.stringify(e);
}

// Envoltorios tipados de los comandos Tauri.
import { invoke } from './tauriTransport';
import type { InsightUsageRow, RunInsights, UsageScope } from './insights';
import type { BackupSummary, RestoreNotice } from './backups';
import type { NativeNotice } from './nativeNotices';
import type {
  Account,
  AgentDetection,
  AgentId,
  ApprovalDecision,
  Conversation,
  Message,
  ModelCatalog,
  Project,
  ProviderSession,
  QueueAction,
  QueueView,
  SendRequest,
  Settings,
  UsageRow,
} from './types';
import { trBackend } from '../i18n/backend';

export interface Bootstrap {
  projects: Project[];
  conversations: Conversation[];
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
  createConversation: (projectId: string, title?: string) =>
    invoke<Conversation>('create_conversation', { projectId, title }),
  renameConversation: (id: string, title: string) => invoke<void>('rename_conversation', { id, title }),
  deleteConversation: (id: string) => invoke<void>('delete_conversation', { id }),
  listMessages: (conversationId: string) =>
    invoke<{ messages: Message[]; sessions?: ProviderSession[] }>('list_messages', { conversationId, includeSessions: false }),
  searchConversations: (query: string) => invoke<ConversationMatch[]>('search_conversations', { query }),
  setDraft: (conversationId: string, draft: string) => invoke<void>('set_draft', { conversationId, draft }),
  setDraftAttachments: (conversationId: string, paths: string[]) => invoke<void>('set_draft_attachments', { conversationId, paths }),
  setConversationPrefs: (conversationId: string, agent: AgentId, model: string, effort: string | null) =>
    invoke<void>('set_conversation_prefs', { conversationId, agent, model, effort }),
  forgetProviderSession: (conversationId: string, agent: AgentId) =>
    invoke<void>('forget_provider_session', { conversationId, agent }),
  setSetting: (key: string, value: unknown) => invoke<void>('set_setting', { key, value }),
  detectAgents: () => invoke<AgentDetection[]>('detect_agents'),
  agentModels: (agent: AgentId, refresh = false) => invoke<ModelCatalog>('agent_models', { agent, refresh }),
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
  steerRun: (runId: string, text: string, attachments: string[]) => invoke<void>('steer_run', { runId, text, attachments }),
  cancelRun: (runId: string) => invoke<void>('cancel_run', { runId }),
  respondApproval: (approvalId: string, decision: ApprovalDecision) =>
    invoke<void>('respond_approval', { approvalId, decision }),
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
  exportConversation: (id: string) => invoke<string | null>('export_conversation', { id }),
  backupCreate: () => invoke<string | null>('backup_create'),
  backupPickRestore: () => invoke<BackupSummary | null>('backup_pick_restore'),
  /** Reinicia Duovra para aplicar la copia elegida; la promesa no llega a resolverse con éxito. */
  backupConfirmRestore: () => invoke<void>('backup_confirm_restore'),
  notifyNative: (notice: NativeNotice) => invoke<boolean>('notify_native', { notice }),
};

/** Texto de un error para mostrarlo. Los mensajes fijos del backend se traducen (src/i18n/backend.ts). */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return trBackend(e);
  if (e instanceof Error) return trBackend(e.message);
  return JSON.stringify(e);
}

// Envoltorios tipados de los comandos Tauri.
import { invoke } from '@tauri-apps/api/core';
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
  Settings,
  UsageRow,
} from './types';

export interface Bootstrap {
  projects: Project[];
  conversations: Conversation[];
  settings: Settings;
  accounts: Account[];
  activeRuns: Array<{ runId: string; conversationId: string; messageId: string; agent: AgentId; model: string; items: never[] }>;
  appVersion: string;
}

export interface SendResult {
  runId: string;
  userMessage: Message;
  assistantMessage: Message;
  renamedTitle: string | null;
}

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
    invoke<{ messages: Message[]; sessions: ProviderSession[] }>('list_messages', { conversationId }),
  setDraft: (conversationId: string, draft: string) => invoke<void>('set_draft', { conversationId, draft }),
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
  addAccount: (agent: AgentId, label: string, configDir: string | null) =>
    invoke<{ accounts: Account[] }>('add_account', { agent, label, configDir }),
  removeAccount: (id: string) => invoke<{ accounts: Account[] }>('remove_account', { id }),
  sendMessage: (request: {
    conversationId: string;
    agent: AgentId;
    model: string;
    effort: string | null;
    text: string;
    attachments: string[];
  }) => invoke<SendResult>('send_message', { request }),
  cancelRun: (runId: string) => invoke<void>('cancel_run', { runId }),
  respondApproval: (approvalId: string, decision: ApprovalDecision) =>
    invoke<void>('respond_approval', { approvalId, decision }),
  inspectAttachments: (paths: string[]) =>
    invoke<Array<{ path: string; exists: boolean; isDir: boolean; size: number }>>('inspect_attachments', { paths }),
  readFile: (path: string, root?: string) =>
    invoke<{ path: string; size: number; truncated: boolean; binary: boolean; content: string }>('read_file', {
      args: { path, root },
    }),
};

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

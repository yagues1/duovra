/**
 * Context Engine 2.0 (1.0.11, fase 2): tipos y reglas puras del frontend.
 *
 * - La memoria compartida vive en SQLite (backend). Aquí solo hay tipos, etiquetas y validación.
 * - Las propuestas de un agente (resumen o reorganización) son **datos**: se buscan en un bloque
 *   ```duovra-memory``` de su respuesta, se validan y el usuario decide qué conservar. Ningún texto
 *   generado por un modelo se interpreta como una orden para Duovra.
 * - Nada de este módulo invoca al proveedor.
 */
import type { AgentId } from './types';
import { tr } from '../i18n';

export type MemoryCategory = 'instruction' | 'goal' | 'decision' | 'constraint' | 'status' | 'task' | 'file' | 'result' | 'issue' | 'note';
export type TransferMode = 'auto' | 'economy' | 'full' | 'custom' | 'off';
export type MemoryPurpose = 'memorySummary' | 'memoryCompact';

export const CATEGORIES: MemoryCategory[] = ['instruction', 'goal', 'decision', 'constraint', 'status', 'task', 'file', 'result', 'issue', 'note'];
export const MODES: TransferMode[] = ['auto', 'economy', 'full', 'custom', 'off'];
export const MAX_MEMORY_CHARS = 4000;
const MAX_PROPOSED = 40;

/** Prioridad reservada al objetivo de la conversación (1.0.11, fase 5). */
export const GOAL_PRIORITY = 2;

export function isConversationGoal(m: Pick<Memory, 'category' | 'priority' | 'author'>): boolean {
  return m.category === 'goal' && m.priority >= GOAL_PRIORITY && m.author === 'user';
}

/** Objetivo activo de una conversación (uno como máximo). */
export function activeGoal(list: Memory[] | undefined): Memory | null {
  return list?.filter((m) => isConversationGoal(m) && !m.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export interface Memory {
  id: string;
  conversationId: string;
  scope: string;
  category: MemoryCategory;
  content: string;
  /** 0 normal, 1 fijado, 2 objetivo de la conversación (fase 5). */
  priority: number;
  author: 'user' | 'agent';
  origin: 'manual' | 'message' | 'summary';
  sourceAgent: AgentId | null;
  sourceModel: string | null;
  sourceMessages: string[];
  anchorSeq: number;
  revision: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryDraft {
  id?: string;
  content: string;
  category: MemoryCategory;
  priority: number;
  origin?: 'manual' | 'message';
  sourceMessages?: string[];
  /** Autoría que tendrá (la decide el backend según el mensaje de origen). */
  author?: 'user' | 'agent';
}

export interface ContextPrefs {
  mode: TransferMode;
  memories: string[];
  messages: string[];
}

export interface ContextWarning {
  id: 'contextNearlyFull' | 'priorityUnselected' | 'priorityOverBudget' | 'memoriesOmitted' | 'messagesOmitted'
    | 'attachmentsMissing' | 'attachmentsOutside' | 'attachmentsSensitive' | 'transferOff' | string;
  count?: number;
  chars?: number;
  budget?: number;
}

export interface Compaction {
  state: 'requested' | 'accepted' | 'started' | 'running' | 'completed' | 'failed' | 'unknown';
  at?: number;
  error?: string | null;
  trigger?: string;
  preTokens?: number | null;
  postTokens?: number | null;
}

export interface ContextStatus {
  conversationId: string;
  agent: AgentId;
  native: {
    hasSession: boolean;
    otherAccount: boolean;
    model: string | null;
    contextTokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    source: 'provider' | 'compaction' | 'none';
    updatedAt: number | null;
    compaction: Compaction | null;
    uncertain: boolean;
  };
  activeCompaction: { agent: AgentId; state: Compaction['state'] } | null;
  shared: {
    prefs: ContextPrefs;
    /** La conversación eligió su propio modo (si no, sigue el ajuste global). */
    override: boolean;
    memories: number;
    pinned: number;
    instructions: number;
    byCategory: Partial<Record<MemoryCategory, number>>;
    next: import('./types').ContextNote;
    block: string | null;
  };
}

export interface ProposedMemory {
  content: string;
  category: MemoryCategory;
  priority: number;
}

export interface Proposal {
  items: ProposedMemory[];
  /** Recuerdos existentes que la propuesta sustituye (solo reorganización). */
  replaces: string[];
}

export function prefsOf(value: Partial<ContextPrefs> | null | undefined): ContextPrefs {
  const mode = MODES.includes(value?.mode as TransferMode) ? (value!.mode as TransferMode) : 'auto';
  return {
    mode,
    memories: Array.isArray(value?.memories) ? value!.memories.filter((x) => typeof x === 'string') : [],
    messages: Array.isArray(value?.messages) ? value!.messages.filter((x) => typeof x === 'string') : [],
  };
}

export const isInstruction = (m: Pick<Memory, 'author' | 'category'>) => m.author === 'user' && (m.category === 'instruction' || m.category === 'constraint');

export function categoryLabel(c: MemoryCategory): string {
  return ({
    instruction: tr('Instrucción'), goal: tr('Objetivo'), decision: tr('Decisión'), constraint: tr('Restricción'),
    status: tr('Estado del trabajo'), task: tr('Tarea pendiente'), file: tr('Archivo o componente'), result: tr('Resultado'),
    issue: tr('Problema pendiente'), note: tr('Nota'),
  } as Record<MemoryCategory, string>)[c];
}

export function modeLabel(m: TransferMode): string {
  return ({ auto: tr('Automático'), economy: tr('Económico'), full: tr('Completo'), custom: tr('Personalizado'), off: tr('Desactivado') } as Record<TransferMode, string>)[m];
}

export function modeHint(m: TransferMode): string {
  return ({
    auto: tr('Recuerdos e instrucciones pendientes y los mensajes que el agente no conoce, con un presupuesto adaptable.'),
    economy: tr('Presupuesto reducido: objetivos, restricciones y decisiones.'),
    full: tr('Más historial dentro de los límites conocidos; avisa si algo queda fuera.'),
    custom: tr('Selección manual de versiones anteriores. Se conserva, pero ya no se ofrece.'),
    off: tr('No se transfiere memoria ni historial de Duovra. El agente puede desconocer el trabajo del otro.'),
  } as Record<TransferMode, string>)[m];
}


/** Arco del indicador circular. Sin porcentaje fiable no hay arco (estado neutral). */
export function ringArc(percent: number | null, radius: number): { dash: string; tone: 'ok' | 'warn' | 'danger' } | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  const p = Math.min(100, Math.max(0, percent));
  const circumference = 2 * Math.PI * radius;
  const filled = (p / 100) * circumference;
  return { dash: `${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}`, tone: p >= 90 ? 'danger' : p >= 70 ? 'warn' : 'ok' };
}

// ---------- Propuestas de memoria ----------

const FENCE = /```(duovra-memory|json)?[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Extrae la propuesta del último bloque válido de la respuesta. Devuelve `null` si no hay ninguno.
 * Solo acepta categorías conocidas, textos no vacíos y recortados al máximo, y sustituciones que
 * apuntan a recuerdos activos que se enviaron para reorganizar.
 */
export function parseProposal(text: string, replaceable: ReadonlySet<string> = new Set()): Proposal | null {
  let found: Proposal | null = null;
  for (const match of text.matchAll(FENCE)) {
    let data: unknown;
    try {
      data = JSON.parse(match[2]);
    } catch {
      continue;
    }
    const memories = (data as { memories?: unknown })?.memories;
    if (!Array.isArray(memories)) continue;
    const items: ProposedMemory[] = [];
    for (const raw of memories.slice(0, MAX_PROPOSED)) {
      const content = typeof raw?.content === 'string' ? raw.content.trim().slice(0, MAX_MEMORY_CHARS) : '';
      if (!content) continue;
      // Lo que propone un agente nunca es una instrucción del usuario.
      let category: MemoryCategory = CATEGORIES.includes(raw?.category) ? raw.category : 'note';
      if (category === 'instruction') category = 'constraint';
      items.push({ content, category, priority: raw?.priority === 1 ? 1 : 0 });
    }
    const replacesRaw = (data as { replaces?: unknown }).replaces;
    const replaces = Array.isArray(replacesRaw)
      ? [...new Set(replacesRaw.filter((id): id is string => typeof id === 'string' && replaceable.has(id)))]
      : [];
    found = { items, replaces };
  }
  return found;
}

const FORMAT = [
  '```duovra-memory',
  '{"memories":[{"category":"goal","content":"…","priority":0}]}',
  '```',
].join('\n');

const RULES = [
  'Categories: goal, decision, constraint, status, task, file, result, issue, note.',
  'At most 20 items. Each item must be self-contained and under 400 characters.',
  'Use priority 1 only for critical constraints or decisions; otherwise 0.',
  'Only include facts stated or verified in this conversation; mark anything uncertain as uncertain.',
  'Never include secrets, tokens, passwords or credentials.',
].join('\n');

/**
 * Texto del encargo de memoria. Es una solicitud explícita del usuario, en solo lectura; el resultado
 * es una propuesta que Duovra muestra para revisar.
 */
export function memoryRequestText(purpose: MemoryPurpose, current: Memory[]): string {
  const head = purpose === 'memorySummary'
    ? tr('Duovra · Propuesta de memoria compartida (solo lectura)')
    : tr('Duovra · Reorganización de la memoria compartida (solo lectura)');
  const common = 'Read-only task: do not run commands, edit files or use tools. Your reply is a proposal that the user will review; it is not applied automatically.';
  if (purpose === 'memorySummary') {
    return [
      head, '',
      common,
      'Summarize this conversation into structured shared memory that another coding agent could rely on: goals, decisions, constraints, work status, pending tasks, relevant files and components, known results and open problems.',
      'Reply with one short sentence and then exactly one fenced block in this format:', '', FORMAT, '', RULES,
    ].join('\n');
  }
  const list = current.filter((m) => !m.archived && !isInstruction(m))
    .map((m) => `- [${m.id}] (${m.category}${m.priority ? ', pinned' : ''}) ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`);
  return [
    head, '',
    common,
    'Reorganize the shared memory below: merge duplicates, drop obsolete items and keep everything that still matters. User instructions are not listed and stay unchanged.',
    '', 'Current shared memory:', ...list, '',
    'Reply with one short sentence and then exactly one fenced block. Add "replaces" with the ids of the current items that your new items supersede:', '',
    '```duovra-memory',
    '{"memories":[{"category":"decision","content":"…","priority":0}],"replaces":["<id>"]}',
    '```', '', RULES,
  ].join('\n');
}

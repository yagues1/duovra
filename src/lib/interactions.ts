import type { AgentId } from './types';

/**
 * Planes y preguntas de los agentes (1.0.11, fase 4 · Planning & Decisions). Solo se muestran los que
 * el proveedor comunica mediante sus mecanismos nativos; Duovra no añade pasos, archivos ni tiempos.
 */
export type WorkMode = 'build' | 'plan';

export type PlanStatus =
  | 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'superseded' | 'interrupted' | 'cancelled' | 'historical';
export type QuestionStatus = 'pending' | 'answered' | 'dismissed' | 'interrupted' | 'cancelled' | 'historical';

export interface QuestionOption {
  label: string;
  description: string | null;
}

export interface Question {
  id: string;
  question: string;
  header: string | null;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Admite una respuesta escrita por el usuario. */
  custom: boolean;
  /** Codex: la respuesta no se guarda en el historial. */
  secret: boolean;
}

export interface Answer {
  selected: string[];
  custom?: string | null;
}

interface Base {
  id: string;
  conversationId: string;
  messageId: string;
  runId: string | null;
  agent: AgentId;
  itemId: string | null;
  version: number;
  native: boolean;
  createdAt: number;
  resolvedAt: number | null;
}

export interface PlanInteraction extends Base {
  kind: 'plan';
  status: PlanStatus;
  payload: { text: string; title: string | null; source: string; planFile?: string | null };
  response: { action?: 'approve' | 'changes' | 'reject'; agent?: AgentId; version?: number; feedback?: string } | null;
}

export interface QuestionInteraction extends Base {
  kind: 'question';
  status: QuestionStatus;
  payload: { questions: Question[]; source: string };
  response: { answers?: Answer[] } | null;
}

export type Interaction = PlanInteraction | QuestionInteraction;

export type PlanAction = 'approve' | 'changes' | 'reject';

/** Un plan admite decisiones mientras espera o si su solicitud nativa se interrumpió. */
export function planActionable(plan: PlanInteraction): boolean {
  return plan.status === 'pending' || plan.status === 'interrupted';
}

/** Solo una pregunta con su solicitud nativa abierta se puede responder. */
export function questionAnswerable(q: QuestionInteraction): boolean {
  return q.status === 'pending' && q.native;
}

/** Algo de la conversación espera al usuario (indicador de la barra lateral). */
export function waitsForUser(i: Interaction): boolean {
  return i.status === 'pending';
}

/** Texto del plan para la tarjeta: sin el encabezado inicial cuando ya se muestra como título. */
export function planBody(text: string, title: string | null): string {
  if (!title) return text;
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && /^#{1,6}\s/.test(lines[first].trim()) && lines[first].replace(/^\s*#+\s*/, '').trim() === title) {
    return lines.slice(first + 1).join('\n').replace(/^\s*\n/, '');
  }
  return text;
}

/** Resumen de una respuesta para la tarjeta ya respondida. */
export function answerText(answer: Answer | undefined): string {
  if (!answer) return '';
  return [...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(', ');
}

/** Comprueba en la interfaz lo mismo que valida el backend antes de enviar. */
export function answerComplete(q: Question, a: Answer | undefined): boolean {
  if (!a) return false;
  const custom = !!a.custom?.trim();
  const count = a.selected.length + (custom ? 1 : 0);
  if (count === 0) return false;
  if (!q.multiSelect && count > 1) return false;
  if (custom && !q.custom) return false;
  return a.selected.every((s) => q.options.some((o) => o.label === s));
}

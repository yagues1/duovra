/**
 * Presentación común de la actividad de un turno (Claude Code y Codex).
 *
 * Todo sale de los elementos reales que entregó el proveedor. Las agrupaciones («3 comandos ·
 * 2 lecturas») son de presentación: clasifican por el tipo observado de cada elemento y nunca se
 * presentan como pasos planificados por el agente. Un mismo elemento cuenta una sola vez aunque
 * el protocolo envíe varias actualizaciones (el store ya lo actualiza por `id`).
 */
import type { TimelineItem } from './types';

/** Herramientas de Claude Code que solo leen o buscan. */
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

export type OperationKind = 'command' | 'read' | 'search' | 'edit' | 'web' | 'tool' | 'plan';

interface CommandAction { type?: string }

/** Acciones que Codex App Server publica para un comando (`commandActions`). */
function commandActions(item: TimelineItem): CommandAction[] {
  const actions = (item as { actions?: unknown }).actions;
  return Array.isArray(actions) ? actions as CommandAction[] : [];
}

/** Tipo observado de una operación, o null si el elemento no es una operación. */
export function operationKind(item: TimelineItem): OperationKind | null {
  switch (item.kind) {
    case 'command': {
      const actions = commandActions(item);
      if (actions.length && actions.every((a) => a.type === 'read')) return 'read';
      if (actions.length && actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search')) return 'search';
      return 'command';
    }
    case 'file_change':
      return 'edit';
    case 'web_search':
      return 'web';
    case 'plan':
      return 'plan';
    case 'tool':
      if (item.tool && READ_TOOLS.has(item.tool)) return 'read';
      if (item.tool && SEARCH_TOOLS.has(item.tool)) return 'search';
      if (item.tool && WEB_TOOLS.has(item.tool)) return 'web';
      if (item.tool && EDIT_TOOLS.test(item.tool)) return 'edit';
      if (item.tool === 'Bash') return 'command';
      return 'tool';
    default:
      return null;
  }
}

/** Un resumen de razonamiento solo se muestra si el proveedor entregó texto legible. */
export function visibleReasoning(item: TimelineItem): boolean {
  return item.kind === 'reasoning' && !!item.text?.trim();
}

/** Fallo de una operación: estado fallido o comando con código distinto de cero. */
export function operationFailed(item: TimelineItem): boolean {
  if (item.status === 'failed') return true;
  return item.kind === 'command' && item.status !== 'running' && item.exitCode != null && item.exitCode !== 0;
}

/** Lo que no debe quedar oculto en la vista contraída. */
export function pinned(item: TimelineItem): boolean {
  return operationFailed(item) || item.status === 'declined';
}

export interface TurnLayout {
  /** Elementos de la tarjeta de actividad, en orden cronológico. */
  activity: TimelineItem[];
  /** Texto de la respuesta (o el texto que se está escribiendo al final del turno). */
  answer: TimelineItem | null;
}

const phaseOf = (item: TimelineItem) => (item as { phase?: string }).phase;

/**
 * Separa la respuesta de la actividad.
 * - La respuesta es el último texto. Codex lo marca con `phase: final_answer`; sus notas de trabajo
 *   llegan como `commentary` y van siempre a la actividad.
 * - En curso, un texto seguido de operaciones es una nota; el texto final se ve como respuesta
 *   mientras se escribe.
 * - Los razonamientos sin texto y el diff acumulado del turno no son entradas de la actividad.
 */
export function layoutTurn(items: readonly TimelineItem[], live: boolean): TurnLayout {
  let lastText = -1;
  let lastOperation = -1;
  items.forEach((item, i) => {
    if (item.kind === 'text') {
      if ((item.text ?? '').length || item.status === 'running') lastText = i;
    } else if (item.kind !== 'diff' && item.kind !== 'reasoning') lastOperation = i;
  });
  const finalIndex = items.findLastIndex((item) => item.kind === 'text' && phaseOf(item) === 'final_answer' && (item.text ?? '').length > 0);
  let answerIndex = finalIndex >= 0 ? finalIndex : lastText;
  if (answerIndex >= 0 && phaseOf(items[answerIndex]) === 'commentary') answerIndex = -1;
  if (live && answerIndex >= 0 && answerIndex < lastOperation) answerIndex = -1;
  const activity: TimelineItem[] = [];
  items.forEach((item, i) => {
    if (i === answerIndex || item.kind === 'diff') return;
    if (item.kind === 'reasoning' && !visibleReasoning(item)) return;
    if (item.kind === 'text' && !(item.text ?? '').trim()) return;
    activity.push(item);
  });
  return { activity, answer: answerIndex >= 0 ? items[answerIndex] : null };
}

export interface ActivitySummary {
  operations: number;
  commands: number;
  reads: number;
  searches: number;
  web: number;
  tools: number;
  /** Archivos distintos con cambios aplicados (sin contar rechazados, fallidos ni en curso). */
  files: number;
  failed: number;
  declined: number;
  notes: number;
  reasoning: number;
  /** Suma de las duraciones comunicadas por el proveedor (solo si alguna existe). */
  durationMs: number | null;
}

export function summarizeActivity(items: readonly TimelineItem[]): ActivitySummary {
  const summary: ActivitySummary = {
    operations: 0, commands: 0, reads: 0, searches: 0, web: 0, tools: 0, files: 0,
    failed: 0, declined: 0, notes: 0, reasoning: 0, durationMs: null,
  };
  const files = new Set<string>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.kind === 'text') { summary.notes++; continue; }
    if (item.kind === 'reasoning') { if (visibleReasoning(item)) summary.reasoning++; continue; }
    const kind = operationKind(item);
    if (!kind) continue;
    summary.operations++;
    if (kind === 'command') summary.commands++;
    else if (kind === 'read') summary.reads++;
    else if (kind === 'search') summary.searches++;
    else if (kind === 'web') summary.web++;
    else if (kind === 'tool' || kind === 'plan') summary.tools++;
    if (operationFailed(item)) summary.failed++;
    if (item.status === 'declined') summary.declined++;
    if (typeof item.durationMs === 'number') summary.durationMs = (summary.durationMs ?? 0) + item.durationMs;
    if (item.kind === 'file_change' && item.status === 'completed') {
      for (const change of item.changes ?? []) files.add(change.path);
    } else if (kind === 'edit' && item.kind === 'tool' && item.status === 'completed') {
      const input = (item.input ?? {}) as Record<string, unknown>;
      const path = input.file_path ?? input.notebook_path;
      if (typeof path === 'string') files.add(path);
    }
  }
  summary.files = files.size;
  return summary;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «6 operaciones realizadas · 1 archivo modificado». */
export function summaryHeadline(s: ActivitySummary): string {
  const parts = [s.operations ? plural(s.operations, 'operación realizada', 'operaciones realizadas') : s.notes ? plural(s.notes, 'nota de trabajo', 'notas de trabajo') : 'Razonamiento'];
  if (s.files) parts.push(plural(s.files, 'archivo modificado', 'archivos modificados'));
  return parts.join(' · ');
}

/** Desglose por tipo observado: «3 comandos · 2 lecturas · 1 búsqueda». */
export function summaryBreakdown(s: ActivitySummary): string[] {
  const parts: string[] = [];
  if (s.commands) parts.push(plural(s.commands, 'comando', 'comandos'));
  if (s.reads) parts.push(plural(s.reads, 'lectura', 'lecturas'));
  if (s.searches) parts.push(plural(s.searches, 'búsqueda', 'búsquedas'));
  if (s.web) parts.push(plural(s.web, 'consulta web', 'consultas web'));
  if (s.tools) parts.push(plural(s.tools, 'herramienta', 'herramientas'));
  if (s.reasoning) parts.push(plural(s.reasoning, 'resumen de razonamiento', 'resúmenes de razonamiento'));
  if (s.notes) parts.push(plural(s.notes, 'nota', 'notas'));
  return parts;
}

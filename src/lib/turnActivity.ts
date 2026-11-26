/**
 * Presentación común de la actividad de un turno (Claude Code y Codex).
 *
 * Todo sale de los elementos reales que entregó el proveedor. Las agrupaciones («3 comandos ·
 * 2 lecturas») son de presentación: clasifican por el tipo observado de cada elemento y nunca se
 * presentan como pasos planificados por el agente. Un mismo elemento cuenta una sola vez aunque
 * el protocolo envíe varias actualizaciones (el store ya lo actualiza por `id`).
 */
import type { TimelineItem } from './types';
import { tr } from '../i18n';

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

/**
 * Tramo del turno en orden cronológico:
 * - `note`: mensaje de progreso que el agente escribió para el usuario (texto visible, nunca razonamiento).
 * - `answer`: la respuesta del turno (o el texto que se está escribiendo al final).
 * - `group`: operaciones técnicas consecutivas (comandos, lecturas, cambios, herramientas, resúmenes de
 *   razonamiento) que se presentan juntas en un desplegable compacto.
 */
export type TurnSegment =
  | { kind: 'note' | 'answer'; key: string; item: TimelineItem }
  /** Plan propuesto o pregunta al usuario (1.0.11, fase 4): tarjeta propia dentro del turno. */
  | { kind: 'decision'; key: string; item: TimelineItem }
  | { kind: 'group'; key: string; items: TimelineItem[] };

export interface TurnLayout {
  /** Elementos que no son la respuesta (notas y operaciones), en orden cronológico. */
  activity: TimelineItem[];
  /** Texto de la respuesta (o el texto que se está escribiendo al final del turno). */
  answer: TimelineItem | null;
  /** Notas, grupos de operaciones y respuesta intercalados en el orden real de los eventos. */
  segments: TurnSegment[];
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
  const segments: TurnSegment[] = [];
  items.forEach((item, i) => {
    if (i === answerIndex) {
      segments.push({ kind: 'answer', key: item.id, item });
      return;
    }
    if (item.kind === 'diff') return;
    if (item.kind === 'reasoning' && !visibleReasoning(item)) return;
    if (item.kind === 'text' && !(item.text ?? '').trim()) return;
    if (item.kind === 'plan_proposal' || item.kind === 'question') {
      segments.push({ kind: 'decision', key: item.id, item });
      return;
    }
    activity.push(item);
    // Los textos son comunicación visible del agente (Claude: bloques `text`; Codex: `agentMessage`
    // con `phase: commentary`). Se distinguen por el tipo del elemento, no por su contenido.
    if (item.kind === 'text') {
      segments.push({ kind: 'note', key: item.id, item });
      return;
    }
    const last = segments[segments.length - 1];
    if (last?.kind === 'group') last.items.push(item);
    else segments.push({ kind: 'group', key: 'group:' + item.id, items: [item] });
  });
  return { activity, answer: answerIndex >= 0 ? items[answerIndex] : null, segments };
}

export interface ActivitySummary {
  operations: number;
  /** Archivos distintos leídos (por ruta cuando el proveedor la informa). */
  readFiles: number;
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
    operations: 0, readFiles: 0, commands: 0, reads: 0, searches: 0, web: 0, tools: 0, files: 0,
    failed: 0, declined: 0, notes: 0, reasoning: 0, durationMs: null,
  };
  const files = new Set<string>();
  const readFiles = new Set<string>();
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
    else if (kind === 'read') { summary.reads++; readFiles.add(readPath(item) ?? item.id); }
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
  summary.readFiles = readFiles.size;
  return summary;
}

/** Ruta leída por una operación de lectura, si el proveedor la publica. */
function readPath(item: TimelineItem): string | null {
  if (item.kind === 'tool') {
    const input = (item.input ?? {}) as Record<string, unknown>;
    const path = input.file_path ?? input.notebook_path;
    return typeof path === 'string' ? path : null;
  }
  const paths = commandActions(item).map((a) => (a as { path?: unknown; name?: unknown }).path ?? (a as { name?: unknown }).name);
  return paths.length && paths.every((p) => typeof p === 'string') ? paths.join('|') : null;
}

/** `one` y `many` llevan `{n}` sin sustituir: `tr` solo lo reemplaza si recibe parámetros. */
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many).replace('{n}', String(n));

/** «6 operaciones realizadas · 1 archivo modificado». */
export function summaryHeadline(s: ActivitySummary): string {
  const parts = [s.operations ? plural(s.operations, tr('{n} operación realizada'), tr('{n} operaciones realizadas')) : s.notes ? plural(s.notes, tr('{n} nota de trabajo'), tr('{n} notas de trabajo')) : tr('Razonamiento')];
  if (s.files) parts.push(plural(s.files, tr('{n} archivo modificado'), tr('{n} archivos modificados')));
  return parts.join(' · ');
}

/**
 * Titular de un grupo de operaciones técnicas, en lenguaje natural:
 * «3 archivos consultados», «2 archivos modificados · 1 comando ejecutado».
 */
export function groupHeadline(s: ActivitySummary): string {
  const parts: string[] = [];
  if (s.readFiles) parts.push(plural(s.readFiles, tr('{n} archivo consultado'), tr('{n} archivos consultados')));
  if (s.files) parts.push(plural(s.files, tr('{n} archivo modificado'), tr('{n} archivos modificados')));
  if (s.commands) parts.push(plural(s.commands, tr('{n} comando ejecutado'), tr('{n} comandos ejecutados')));
  if (s.searches) parts.push(plural(s.searches, tr('{n} búsqueda'), tr('{n} búsquedas')));
  if (s.web) parts.push(plural(s.web, tr('{n} consulta web'), tr('{n} consultas web')));
  if (s.tools) parts.push(plural(s.tools, tr('{n} herramienta usada'), tr('{n} herramientas usadas')));
  if (s.reasoning) parts.push(plural(s.reasoning, tr('{n} resumen de razonamiento'), tr('{n} resúmenes de razonamiento')));
  // Ediciones que no llegaron a aplicarse (rechazadas o fallidas) no suman archivos modificados.
  return parts.length ? parts.join(' · ') : summaryHeadline(s);
}

/** Desglose por tipo observado: «3 comandos · 2 lecturas · 1 búsqueda». */
export function summaryBreakdown(s: ActivitySummary): string[] {
  const parts: string[] = [];
  if (s.commands) parts.push(plural(s.commands, tr('{n} comando'), tr('{n} comandos')));
  if (s.reads) parts.push(plural(s.reads, tr('{n} lectura'), tr('{n} lecturas')));
  if (s.searches) parts.push(plural(s.searches, tr('{n} búsqueda'), tr('{n} búsquedas')));
  if (s.web) parts.push(plural(s.web, tr('{n} consulta web'), tr('{n} consultas web')));
  if (s.tools) parts.push(plural(s.tools, tr('{n} herramienta'), tr('{n} herramientas')));
  if (s.reasoning) parts.push(plural(s.reasoning, tr('{n} resumen de razonamiento'), tr('{n} resúmenes de razonamiento')));
  if (s.notes) parts.push(plural(s.notes, tr('{n} nota'), tr('{n} notas')));
  return parts;
}

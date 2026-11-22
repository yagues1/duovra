/**
 * Estado de actividad de un agente, derivado solo de eventos reales del turno (diseño 0.6.0, §5.2).
 *
 * Las mascotas y el indicador de trabajo lo consumen. No se simula progreso: cada estado sale de un
 * dato que la aplicación conoce (ítems del run, aprobaciones pendientes y estado del mensaje).
 */
import type { AgentId, Message, RunView, TimelineItem } from './types';
import { basename, displayCommand } from './format';
import { operationKind } from './turnActivity';

export type Activity = 'idle' | 'thinking' | 'writing' | 'reading' | 'coding' | 'tools' | 'waiting' | 'done' | 'error';

export const ACTIVITIES: readonly Activity[] = ['idle', 'thinking', 'writing', 'reading', 'coding', 'tools', 'waiting', 'done', 'error'];

/** Herramientas de Claude Code que solo leen o buscan. Codex no distingue lecturas en sus comandos. */
export const READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'NotebookRead'];

/** Tiempo que la mascota celebra tras terminar (luego vuelve al reposo). */
export const DONE_MS = 2500;
/** Tiempo que se muestra el error de un turno terminado antes de volver al reposo. */
export const ERROR_MS = 3000;

export interface ActivityFinish {
  conversationId: string;
  runId: string;
  agent: AgentId;
  status: 'done' | 'failed';
  endedAt: number;
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'En reposo',
  thinking: 'Pensando',
  writing: 'Escribiendo respuesta',
  reading: 'Leyendo archivos',
  coding: 'Modificando código',
  tools: 'Ejecutando herramientas',
  waiting: 'Esperando autorización',
  done: 'Tarea completada',
  error: 'Error',
};

/** Último ítem en curso que no es texto (el texto en streaming no cuenta como acción). */
export function currentItem(items: readonly TimelineItem[]): TimelineItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.status === 'running' && it.kind !== 'text') return it;
  }
  return undefined;
}

function itemActivity(it: TimelineItem): Activity {
  switch (it.kind) {
    case 'reasoning':
      return 'thinking';
    case 'file_change':
      return 'coding';
    case 'web_search':
      return 'tools';
    case 'tool':
      if (it.tool && READ_TOOLS.includes(it.tool)) return 'reading';
      if (it.tool && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(it.tool)) return 'coding';
      return 'tools';
    case 'command': {
      // Codex clasifica sus comandos de lectura y búsqueda (`commandActions`).
      const kind = operationKind(it);
      return kind === 'read' || kind === 'search' ? 'reading' : 'tools';
    }
    default:
      return 'tools';
  }
}

/**
 * Actividad actual.
 * - Con un run en curso: autorización pendiente > ítem en curso > texto en streaming > último ítem fallido > pensando.
 * - Sin run: el evento de finalización del turno marca «completada» o «error» durante unos segundos.
 */
export function deriveActivity(run: RunView | undefined, last: Pick<ActivityFinish, 'status' | 'endedAt'> | undefined, now: number): Activity {
  if (run) {
    if (run.approvals.length > 0) return 'waiting';
    const cur = currentItem(run.items);
    if (cur) return itemActivity(cur);
    // El texto en streaming es la respuesta, incluso si contiene un bloque de código.
    const tail = run.items[run.items.length - 1];
    if (tail?.kind === 'text' && tail.status === 'running' && (tail.text ?? '').length > 0) return 'writing';
    // La última acción falló y el agente aún no ha seguido con otra cosa.
    const lastAction = [...run.items].reverse().find((i) => i.kind !== 'text');
    if (lastAction?.status === 'failed') return 'error';
    // Sin ítems todavía: el agente está pensando.
    return 'thinking';
  }
  if (!last || now < last.endedAt) return 'idle';
  const age = now - last.endedAt;
  if (last.status === 'failed') return age < ERROR_MS ? 'error' : 'idle';
  return age < DONE_MS ? 'done' : 'idle';
}

function toolDetail(it: TimelineItem): string | null {
  const input = (it.input ?? {}) as Record<string, unknown>;
  const path = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  if (path) return basename(path);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.command === 'string') return displayCommand(input.command);
  if (typeof input.url === 'string') return input.url;
  return it.tool ?? null;
}

/**
 * Estado general de un turno en curso: única correspondencia entre el evento real y los textos de la
 * cabecera del turno y del compositor (la placa de la mascota añade el detalle). Solo distingue lo
 * que los eventos permiten distinguir con seguridad; el resto es «Trabajando».
 */
export type TurnPhase = 'preparing' | 'stopping' | 'waiting' | 'thinking' | 'writing' | 'working';

export const TURN_LABEL: Record<TurnPhase, string> = {
  preparing: 'Preparando ejecución',
  stopping: 'Deteniendo',
  waiting: ACTIVITY_LABEL.waiting,
  thinking: ACTIVITY_LABEL.thinking,
  writing: ACTIVITY_LABEL.writing,
  working: 'Trabajando',
};

export function turnPhase(run: RunView): TurnPhase {
  if (run.stopping) return 'stopping';
  if (run.ready === false && !run.approvals.length && !run.items.length) return 'preparing';
  const a = deriveActivity(run, undefined, 0);
  return a === 'waiting' || a === 'thinking' || a === 'writing' ? a : 'working';
}

/** Texto del indicador de trabajo: etiqueta y detalle en monoespaciada (comando, archivo…). */
export function activityLabel(run: RunView | undefined, a: Activity): { label: string; detail: string | null } {
  if (run?.stopping) return { label: 'Deteniendo…', detail: null };
  if (run && turnPhase(run) === 'preparing') return { label: TURN_LABEL.preparing, detail: null };
  // Una acción falló pero el turno sigue: no es un error del turno (el agente puede continuar).
  if (a === 'error' && run) return { label: 'Una acción ha fallado', detail: null };
  if (a === 'waiting' && run) {
    const info = run.approvals[0]?.info;
    const detail = info?.command ? displayCommand(info.command) : info?.changes?.length ? basename(info.changes[0].path) : (info?.tool ?? null);
    return { label: ACTIVITY_LABEL.waiting, detail };
  }
  const cur = run ? currentItem(run.items) : undefined;
  if (!cur) return { label: ACTIVITY_LABEL[a], detail: null };
  switch (cur.kind) {
    case 'command': {
      const kind = operationKind(cur);
      return { label: kind === 'read' || kind === 'search' ? ACTIVITY_LABEL.reading : 'Ejecutando comandos', detail: displayCommand(cur.command) || null };
    }
    case 'file_change': {
      const ch = cur.changes ?? [];
      return { label: 'Editando archivos', detail: ch.length === 1 ? basename(ch[0].path) : ch.length ? `${ch.length} archivos` : null };
    }
    case 'web_search':
      return { label: 'Buscando en la web', detail: typeof cur.query === 'string' ? cur.query : null };
    case 'tool':
      return { label: ACTIVITY_LABEL[a], detail: toolDetail(cur) };
    case 'reasoning':
      return { label: ACTIVITY_LABEL.thinking, detail: null };
    default:
      return { label: ACTIVITY_LABEL[a], detail: null };
  }
}

/** Pose fija de la mascota en el historial: con error, triste; si no, en reposo. */
export function restingPose(m: Pick<Message, 'status'>): 'idle' | 'error' {
  return m.status === 'failed' ? 'error' : 'idle';
}

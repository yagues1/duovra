/**
 * Función del botón principal del compositor (enviar, encolar o cancelar), según el estado real de la
 * ejecución y el borrador. La animación del icono nunca retrasa este cálculo.
 *
 * | Ejecución activa | Borrador | Acción                  |
 * |------------------|----------|-------------------------|
 * | No               | No       | Enviar (deshabilitado)  |
 * | No               | Sí       | Enviar (o encolar si la cola tiene encargos pendientes) |
 * | Sí               | No       | Cancelar                |
 * | Sí               | Sí       | Encolar                 |
 */
export type PrimaryAction = 'send' | 'queue' | 'cancel';

export interface PrimaryActionInput {
  /** Hay una ejecución activa en esta conversación. */
  running: boolean;
  /** La cola tiene encargos pendientes o pausados: el backend encolará el mensaje. */
  queuePending: boolean;
  /** El borrador tiene texto o adjuntos. */
  hasDraft: boolean;
  /** El compositor admite enviar ahora (reglas actuales: modelo válido, historial cargado, sin envío en curso…). */
  canSend: boolean;
  /** Ya se pidió detener la ejecución activa. */
  stopping: boolean;
}

export interface PrimaryActionState {
  action: PrimaryAction;
  disabled: boolean;
}

export function primaryAction({ running, queuePending, hasDraft, canSend, stopping }: PrimaryActionInput): PrimaryActionState {
  if (running && !hasDraft) return { action: 'cancel', disabled: stopping };
  return { action: hasDraft && (running || queuePending) ? 'queue' : 'send', disabled: !canSend };
}

/**
 * Margen tras enviar o encolar desde el compositor: un doble clic sobre Enviar no debe cancelar la
 * ejecución que acaba de iniciar. El botón cambia al instante; solo se ignoran los clics de cancelar
 * dentro de ese margen. Una ejecución iniciada desde la cola se puede cancelar de inmediato.
 */
export const CANCEL_ARM_MS = 450;

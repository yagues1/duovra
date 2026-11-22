// Reglas de los avisos nativos de Windows. El texto lo compone el backend (notify.rs), que nunca
// recibe prompts ni respuestas; aquí solo se decide si el evento merece un aviso y con qué clave.

export type NativeKind = 'finished' | 'failed' | 'approval';

export interface NativeNotice {
  kind: NativeKind;
  /** Identidad del evento: se usa para no repetir el mismo aviso. */
  key: string;
  conversationId: string;
  title: string;
  agent: string;
}

export interface ViewState {
  view: string;
  settingsOpen: boolean;
  activeConversationId: string | null;
}

/**
 * La conversación está a la vista: el chat está abierto, es la conversación activa y la ventana
 * tiene foco. `hasFocus` solo se consulta cuando lo demás ya coincide.
 */
export function isConversationInView(state: ViewState, conversationId: string, hasFocus: () => boolean): boolean {
  return state.view === 'chat' && !state.settingsOpen && state.activeConversationId === conversationId && hasFocus();
}

/**
 * Tipo de aviso al terminar una ejecución. Lo mismo que el aviso interno: las ejecuciones que el
 * usuario detuvo o que se interrumpieron al cerrar la aplicación no avisan.
 */
export function finishedKind(status: string): NativeKind | null {
  if (status === 'cancelled' || status === 'interrupted') return null;
  return status === 'failed' || status === 'error' ? 'failed' : 'finished';
}

export function runNoticeKey(runId: string, kind: NativeKind): string {
  return `run:${runId}:${kind}`;
}

export function approvalNoticeKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

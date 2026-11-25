// Suscripción a los eventos de ejecución del backend.
// Los deltas de texto y de salida llegan muy seguidos: se agrupan por fotograma para no
// provocar un render por token.
import { listen } from './tauriTransport';
import { useStore, type RunEvent } from '../state/store';

type DeltaEv = Extract<RunEvent, { type: 'delta' | 'output' }>;

export async function subscribeRunEvents(): Promise<() => void> {
  let queue: DeltaEv[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = queue;
    queue = [];
    const handle = useStore.getState().handleRunEvent;
    for (const ev of batch) handle(ev);
  };

  const unlisten = await listen<RunEvent>('run-event', ({ payload }) => {
    if (payload.type === 'delta' || payload.type === 'output') {
      // Fusiona al recibir: la ventana minimizada puede tardar en entregar el siguiente fotograma.
      const last = queue.at(-1);
      if (last && last.type === payload.type && last.itemId === payload.itemId && last.runId === payload.runId) {
        last.delta += payload.delta;
      } else queue.push({ ...payload });
      if (!frame) frame = requestAnimationFrame(flush);
      return;
    }
    // Cualquier otro evento respeta el orden: primero se vacían los deltas pendientes.
    if (queue.length) {
      cancelAnimationFrame(frame);
      flush();
    }
    useStore.getState().handleRunEvent(payload);
  });
  return () => {
    unlisten();
    cancelAnimationFrame(frame);
    queue = [];
  };
}

/** Un tap en un aviso del sistema abre su conversación; el backend ya trae la ventana al frente. */
export async function subscribeNotificationOpen(): Promise<() => void> {
  return listen<{ conversationId: string }>('notification-open', ({ payload }) => {
    void useStore.getState().selectConversation(payload.conversationId);
  });
}

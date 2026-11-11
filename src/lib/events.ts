// Suscripción a los eventos de ejecución del backend.
// Los deltas de texto y de salida llegan muy seguidos: se agrupan por fotograma para no
// provocar un render por token.
import { listen } from '@tauri-apps/api/event';
import { useStore, type RunEvent } from '../state/store';

type DeltaEv = Extract<RunEvent, { type: 'delta' | 'output' }>;

export async function subscribeRunEvents(): Promise<() => void> {
  let queue: DeltaEv[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = queue;
    queue = [];
    // Fusiona deltas consecutivos del mismo elemento.
    const merged: DeltaEv[] = [];
    for (const ev of batch) {
      const last = merged[merged.length - 1];
      if (last && last.type === ev.type && last.itemId === ev.itemId && last.runId === ev.runId) {
        last.delta += ev.delta;
      } else merged.push({ ...ev });
    }
    const handle = useStore.getState().handleRunEvent;
    for (const ev of merged) handle(ev);
  };

  return listen<RunEvent>('run-event', ({ payload }) => {
    if (payload.type === 'delta' || payload.type === 'output') {
      queue.push(payload);
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
}

// Suscripción única a los eventos nativos de Live Preview (sin sondeo: el backend los agrupa).
import { useLivePreview } from '../../state/livePreview';
import { useStore } from '../../state/store';
import type { ElementInfo, LpSummary } from '../../lib/livePreview';
import { errorText } from '../../lib/ipc';

let started = false;

export function ensurePreviewEvents() {
  if (started) return;
  started = true;
  void import('@tauri-apps/api/event').then(async ({ listen }) => {
    await listen<LpSummary>('live-preview://changed', (event) => {
      const summary = event.payload;
      const lp = useLivePreview.getState();
      lp.setLive(summary);
      if (!summary.alive && lp.open[summary.space]) lp.setOpen(summary.space, false);
    });
    await listen<{ space: string; node?: number; info?: ElementInfo; error?: string }>('live-preview://element', (event) => {
      const { space, node, info, error } = event.payload;
      if (error) {
        useStore.getState().toast(errorText(error), 'error');
        return;
      }
      if (node == null || !info) return;
      const lp = useLivePreview.getState();
      lp.setElement(space, { node, info });
      lp.setDrawer(space, 'element');
    });
  }).catch(() => {
    started = false;
  });
}

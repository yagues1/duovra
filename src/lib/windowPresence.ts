import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const listeners = new Set<(visible: boolean) => void>();
let visible = true;
let stop: (() => void) | undefined;

/** Un solo estado de ventana para fondos, mascotas y muestreo de rendimiento. */
export function subscribeWindowPresence(listener: (visible: boolean) => void) {
  stop ??= observeWindow();
  listeners.add(listener);
  listener(visible);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stop?.();
      stop = undefined;
    }
  };
}

function observeWindow() {
  const native = isTauri() ? getCurrentWindow() : null;
  const events = new AbortController();
  let minimized = false;
  let pending = false;
  let timer = 0;
  let unlisten: (() => void) | undefined;

  const publish = () => {
    const next = !minimized && !document.hidden && document.hasFocus();
    if (next === visible) return;
    visible = next;
    for (const listener of listeners) listener(next);
  };
  const check = async () => {
    if (!native || pending || events.signal.aborted) return;
    pending = true;
    window.clearTimeout(timer);
    try {
      const next = await native.isMinimized();
      if (events.signal.aborted) return;
      minimized = next;
      publish();
      // Algunos WebView2 conservan foco y visibilidad DOM tras minimizarse.
      if (minimized || visible) timer = window.setTimeout(() => void check(), 1000);
    } catch {
      // Foco y visibilidad DOM siguen disponibles.
    } finally {
      pending = false;
    }
  };
  const update = () => { publish(); void check(); };
  const opts = { signal: events.signal };
  window.addEventListener('focus', update, opts);
  window.addEventListener('blur', update, opts);
  document.addEventListener('visibilitychange', update, opts);
  void native?.onFocusChanged(update).then((off) => {
    if (events.signal.aborted) off();
    else unlisten = off;
  }, () => undefined);
  update();

  return () => {
    events.abort();
    unlisten?.();
    window.clearTimeout(timer);
  };
}

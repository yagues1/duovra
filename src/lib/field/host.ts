/* Partes Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt. */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { FieldEngine, fieldLayout, QUALITY_CELL, RAMP, type DitherTexture, type FieldBeat, type Look } from './field';
import type { FieldMessage, FieldReply } from './field.worker';

export interface FieldController {
  /**
   * `animate`: el campo puede moverse. `ambient`: deriva continua en reposo. Sin ambiente, el bucle
   * solo corre durante las reacciones. Un campo que nunca se anima (miniaturas, vista previa fija)
   * dibuja un fotograma por cada cambio y no consume nada más.
   */
  configure(look: Look, animate: boolean, ambient: boolean, controls?: FieldControls, texture?: DitherTexture): void;
  react(kind: FieldBeat, strength: number, start?: boolean): void;
  dispose(): void;
}

export interface FieldControls {
  cell: number;
  dotSize?: number;
  pointer: boolean;
  horizon?: boolean;
  /** Fracción del escenario que ocupa la banda del horizonte (0,5 por defecto; las miniaturas la amplían). */
  band?: number;
}

// ── el worker compartido ──

/** Cuánto sobrevive un worker sin campos, para no reiniciarlo al cambiar de pantalla. */
const WORKER_LINGER = 10_000;
let shared: Worker | null = null;
let sharedBroken = false;
let users = 0;
let lingerTimer = 0;
let nextId = 0;
const replies = new Map<number, (reply: FieldReply) => void>();
const onBroken = new Set<() => void>();

function acquireWorker(): Worker | null {
  if (sharedBroken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (!shared) {
    try {
      shared = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      sharedBroken = true;
      return null;
    }
    shared.onmessage = ({ data }: MessageEvent<FieldReply>) => replies.get(data.id)?.(data);
    const broken = (event?: Event) => {
      event?.preventDefault();
      sharedBroken = true;
      shared?.terminate();
      shared = null;
      users = 0;
      replies.clear();
      for (const fallback of [...onBroken]) fallback();
    };
    shared.onerror = broken;
    shared.onmessageerror = broken;
  }
  clearTimeout(lingerTimer);
  users++;
  return shared;
}

function releaseWorker() {
  if (--users > 0) return;
  users = 0;
  clearTimeout(lingerTimer);
  lingerTimer = window.setTimeout(() => {
    if (users > 0 || !shared) return;
    shared.terminate();
    shared = null;
  }, WORKER_LINGER);
}

/** Pruebas y QA: cuántos campos usan el worker compartido y si existe. */
export function fieldWorkerState() {
  return { users, alive: shared !== null, broken: sharedBroken };
}

// ── calidad publicada en <html data-field-quality> (la peor de los campos animados) ──

const levels = new Map<number, number>();
function publishQuality(id: number, level: number | null) {
  if (!level) levels.delete(id);
  else levels.set(id, level);
  const worst = Math.max(0, ...levels.values());
  if (worst) document.documentElement.dataset.fieldQuality = String(worst);
  else delete document.documentElement.dataset.fieldQuality;
}

// ── atlas de glifos para ASCII: necesita las fuentes de la página, así que se dibuja aquí ──

const atlases = new Map<string, Promise<HTMLCanvasElement>>();
function glyphAtlas(gw: number, gh: number, dpr: number, font: number) {
  const key = `${gw}x${gh}@${dpr}/${font}`;
  let atlas = atlases.get(key);
  if (!atlas) {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
    atlas = (document.fonts?.load(`${font}px ${family}`) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        const canvas = document.createElement('canvas');
        canvas.width = gw * RAMP.length;
        canvas.height = gh;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#fff';
          ctx.font = `${font * dpr}px ${family}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (let i = 1; i < RAMP.length; i++) ctx.fillText(RAMP[i], i * gw + gw / 2, gh / 2 + dpr * 0.5);
        }
        return canvas;
      });
    atlases.set(key, atlas);
  }
  return atlas;
}

// ── un campo ──

/** Un lienzo nuevo para el fallback: transferControlToOffscreen es irreversible. */
export function mountField(
  host: HTMLDivElement, initial: Look, initialTexture: DitherTexture = 'dither', initialControls?: FieldControls,
): FieldController {
  const id = ++nextId;
  let canvas: HTMLCanvasElement;
  let worker: Worker | null = null;
  let engine: FieldEngine | null = null;
  let look = initial;
  let texture = initialTexture;
  let animate = false;
  let ambient = false;
  let controls = initialControls;
  let running = false;
  let pointerFrame = 0;
  let pointerAt: [number, number] | null = null;
  let pointerTail = 0;
  let drawn = false;
  let disposed = false;
  let usedFallback = false;
  let quality = 0;
  let burst = 0;
  let startTimer = 0;
  let watchdog = 0;
  let lastBeat = -Infinity;
  let observer: PerformanceObserver | undefined;
  let pressure = 0;
  let pressureAt = 0;
  let installedAtlasKey = '';
  let pendingAtlas: { key: string; commit: (source: HTMLCanvasElement | ImageBitmap) => void } | undefined;
  const appWindow = isTauri() ? getCurrentWindow() : null;
  let minimized = false;
  let nativePoll = 0;
  let nativePace = 0;
  let nativeCheck = 0;

  const visible = () => !minimized && !document.hidden && document.hasFocus();
  // En WebView2 la ventana nativa puede minimizarse sin cambiar document.hidden.
  // Tras detectar el minimizado, mantenemos un sondeo lento: el foco puede llegar antes de restaurar.
  const checkNative = async () => {
    if (!appWindow) return;
    const check = ++nativeCheck;
    try {
      const next = await appWindow.isMinimized();
      if (disposed || check !== nativeCheck || minimized === next) return;
      minimized = next;
      onVisibility();
    } catch {
      // El control DOM sigue disponible si el runtime no expone el estado nativo.
    }
  };
  const ready = () => {
    drawn = true;
    clearTimeout(watchdog);
    watchdog = 0;
    host.dataset.ready = 'true';
  };
  const send = (msg: FieldMessage, transfer?: Transferable[]) => {
    if (worker) {
      worker.postMessage(msg, transfer ?? []);
      return;
    }
    if (!engine) return;
    switch (msg.type) {
      case 'resize': engine.resize(msg.metrics, msg.atlas, msg.texture); break;
      case 'look': engine.setLook(msg.look, !running); break;
      case 'beat': engine.beat(msg.kind, msg.x, msg.y, msg.strength); break;
      case 'state': engine.setState(msg.running, msg.running); break;
      case 'rest': engine.setRest(msg.rest); break;
      case 'pressure': engine.setPressure(msg.ms); break;
      case 'pointer': engine.setPointer(msg.p); break;
    }
  };
  // Un campo quieto (miniatura, vista previa fija) no necesita estar visible para pintar su fotograma.
  const mayDraw = () => visible() || !animate;
  const bandHeight = (height: number) => controls?.horizon ? Math.min(216, height * (controls.band ?? 0.5)) : undefined;
  const resize = () => {
    if (!mayDraw() || (!worker && !engine)) return;
    const style = getComputedStyle(host);
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    if (!width || !height) return;
    const zoom = (host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
    // Dots keep their cell at every quality level: under load they draw less often, never coarser.
    const dots = texture === 'dots';
    const cell = Math.max(2, Math.round((controls?.cell ?? (look.full ? 7 : 5)) * (dots ? 1 : QUALITY_CELL[quality])));
    const dpr = (window.devicePixelRatio || 1) * zoom;
    // A dots canvas covers only the lit band (bottom-aligned in CSS), at device resolution.
    const layout = fieldLayout(texture, false, width, dots ? bandHeight(height) ?? height : height, dpr, cell);
    const nextTexture = texture;
    const metrics = { width, height, dpr, cell, dotSize: controls?.dotSize, bandHeight: bandHeight(height) };
    const commit = (source?: HTMLCanvasElement | ImageBitmap) => {
      canvas.style.width = layout.cssW + 'px';
      canvas.style.height = layout.cssH + 'px';
      host.dataset.texture = nextTexture;
      host.style.setProperty('--cell', `${layout.cell}px`);
      host.style.setProperty('--device-pixel', `${1 / dpr}px`);
      if (source && !worker) engine?.resize(metrics, source, nextTexture);
      else {
        const bitmap = source as ImageBitmap | undefined;
        send({ type: 'resize', id, metrics, texture: nextTexture, atlas: bitmap }, bitmap ? [bitmap] : []);
      }
    };
    if (worker && !drawn && !watchdog) watchdog = window.setTimeout(fallback, 2500);
    const atlas = layout.atlas;
    if (!atlas) {
      pendingAtlas = undefined;
      commit();
      return;
    }
    const key = `${atlas.gw}x${atlas.gh}@${atlas.dpr}/${atlas.font}`;
    if (key === installedAtlasKey) {
      pendingAtlas = undefined;
      commit();
      return;
    }
    if (pendingAtlas?.key === key) {
      pendingAtlas.commit = commit;
      return;
    }
    const pending = { key, commit };
    pendingAtlas = pending;
    void glyphAtlas(atlas.gw, atlas.gh, atlas.dpr, atlas.font).then(async (source) => {
      if (disposed || pendingAtlas !== pending) return;
      const bitmap = worker && typeof createImageBitmap === 'function'
        ? await createImageBitmap(source).catch(() => null) : null;
      if (disposed || pendingAtlas !== pending) { bitmap?.close(); return; }
      pendingAtlas = undefined;
      if (!mayDraw()) { bitmap?.close(); return; }
      if (worker && !bitmap) { fallback(); return; }
      installedAtlasKey = key;
      pending.commit(bitmap ?? source);
    });
  };
  const onQuality = (level: number) => {
    if (level === quality) return;
    quality = level;
    host.dataset.quality = String(level);
    publishQuality(id, level);
    resize();
  };
  const stopObserving = () => {
    observer?.disconnect();
    observer = undefined;
    pressure = 0;
  };
  const sync = () => {
    const next = animate && (ambient || !!burst || (controls?.pointer === true && (!!pointerAt || !!pointerTail))) && visible();
    const pace = next ? (burst ? 220 : 1000) : animate && minimized ? 1000 : 0;
    if (appWindow && nativePace !== pace) {
      clearInterval(nativePoll);
      nativePace = pace;
      nativePoll = pace ? window.setInterval(() => void checkNative(), pace) : 0;
    }
    if (next === running) return;
    running = next;
    host.dataset.running = String(running);
    send({ type: 'state', id, running });
    if (next && appWindow) void checkNative();
    if (!next) sendPointer(null);
    stopObserving();
    // Main-thread load only slows a field drawn on the main thread. In the worker, a busy page
    // (a turn streaming in) must not cost the background its definition: real CPU contention
    // still shows there as late timers.
    if (!next || worker || typeof PerformanceObserver === 'undefined') return;
    const type = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame') ? 'long-animation-frame' : 'longtask';
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    pressureAt = performance.now();
    send({ type: 'pressure', id, ms: 0 });
    observer = new PerformanceObserver((list) => {
      pressure += list.getEntries().reduce((sum, entry) => sum + entry.duration, 0);
      const now = performance.now();
      if (now - pressureAt >= 450) {
        send({ type: 'pressure', id, ms: pressure });
        pressure = 0;
        pressureAt = now;
      }
    });
    try { observer.observe({ type }); } catch { stopObserving(); }
  };
  const newCanvas = () => {
    canvas?.remove();
    canvas = document.createElement('canvas');
    host.append(canvas);
  };
  const leaveWorker = () => {
    if (!worker) return;
    onBroken.delete(fallback);
    replies.delete(id);
    worker = null;
    releaseWorker();
  };
  function fallback() {
    if (disposed || usedFallback) return;
    usedFallback = true;
    clearTimeout(watchdog);
    watchdog = 0;
    if (worker) {
      try { worker.postMessage({ type: 'dispose', id } satisfies FieldMessage); } catch { /* worker caído */ }
      leaveWorker();
    }
    drawn = false;
    installedAtlasKey = '';
    pendingAtlas = undefined;
    delete host.dataset.ready;
    newCanvas();
    try {
      engine = FieldEngine.create(canvas, texture, look, { frame: (first) => { if (first) ready(); }, quality: onQuality });
    } catch {
      engine = null;
    }
    host.dataset.thread = engine ? 'main' : 'unavailable';
    if (!engine) canvas.remove();
    else {
      resize();
      send({ type: 'state', id, running });
    }
  }
  newCanvas();
  try {
    if (!canvas!.transferControlToOffscreen) throw new Error('OffscreenCanvas no disponible');
    worker = acquireWorker();
    if (!worker) throw new Error('Worker no disponible');
    replies.set(id, (reply) => {
      if (reply.type === 'ready') ready();
      else onQuality(reply.level);
    });
    onBroken.add(fallback);
    const offscreen = canvas!.transferControlToOffscreen();
    worker.postMessage({ type: 'init', id, canvas: offscreen, look, texture } satisfies FieldMessage, [offscreen]);
    host.dataset.thread = 'worker';
    resize();
  } catch {
    leaveWorker();
    fallback();
  }

  function onVisibility() {
    if (!visible()) {
      clearTimeout(burst);
      clearTimeout(startTimer);
      clearTimeout(watchdog);
      clearTimeout(pointerTail);
      cancelAnimationFrame(pointerFrame);
      burst = startTimer = watchdog = 0;
      pointerTail = pointerFrame = 0;
      sendPointer(null);
      sync();
      return;
    }
    send({ type: 'look', id, look });
    resize();
    sync();
  }
  const onWindowVisibility = () => { onVisibility(); void checkNative(); };
  // Reacción ligera al puntero: el punto de fuga se inclina unos píxeles hacia él (un mensaje por fotograma).
  function sendPointer(p: [number, number] | null) {
    if (p === null && pointerAt === null) return;
    pointerAt = p;
    send({ type: 'pointer', id, p });
  }
  const stage = host.parentElement;
  const onPointer = (event: PointerEvent) => {
    if (pointerFrame || (controls ? !controls.pointer || !animate || !visible() : !running)) return;
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      const box = host.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const x = Math.min(0.5, Math.max(-0.5, (event.clientX - box.left) / box.width - 0.5));
      const y = Math.min(0.5, Math.max(-0.5, (event.clientY - box.top) / box.height - 0.5));
      if (controls) {
        clearTimeout(pointerTail);
        pointerTail = 0;
      }
      sendPointer([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
      if (controls) sync();
    });
  };
  const onLeave = () => {
    if (controls) {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = 0;
      if (pointerAt) {
        clearTimeout(pointerTail);
        pointerTail = window.setTimeout(() => { pointerTail = 0; sync(); }, 950);
      }
    }
    sendPointer(null);
  };
  stage?.addEventListener('pointermove', onPointer, { passive: true });
  stage?.addEventListener('pointerleave', onLeave);
  const sizes = new ResizeObserver(resize);
  sizes.observe(host);
  let resolution: MediaQueryList;
  const watchResolution = () => {
    resolution?.removeEventListener('change', watchResolution);
    resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    resolution.addEventListener('change', watchResolution);
    resize();
  };
  watchResolution();
  window.addEventListener('resize', resize);
  window.addEventListener('blur', onWindowVisibility);
  window.addEventListener('focus', onWindowVisibility);
  document.addEventListener('visibilitychange', onWindowVisibility);
  host.dataset.running = 'false';

  const trigger = (kind: FieldBeat, strength: number, y: number) => {
    if (!animate || !visible()) return;
    clearTimeout(burst);
    burst = window.setTimeout(() => { burst = 0; sync(); }, 1550);
    sync();
    const field = host.getBoundingClientRect();
    const target = host.parentElement?.querySelector(kind === 'send' ? '.send-btn' : '.composer')?.getBoundingClientRect();
    const x = target && field.width ? (target.left + target.width / 2 - field.left) / field.width : 0.5;
    const zoom = (host as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
    const height = (bandHeight(field.height / zoom) ?? field.height / zoom) * zoom;
    const origin = kind === 'send' && target && height ? 1 + (target.top + target.height / 2 - field.bottom) / height : y;
    send({ type: 'beat', id, kind, x, y: Math.min(0.98, Math.max(0.1, origin)), strength });
  };

  return {
    configure(next, enabled, idle, nextControls, nextTexture = texture) {
      animate = enabled;
      ambient = idle;
      const gridChanged = texture !== nextTexture || controls?.cell !== nextControls?.cell ||
        controls?.dotSize !== nextControls?.dotSize || controls?.horizon !== nextControls?.horizon || controls?.band !== nextControls?.band;
      texture = nextTexture;
      controls = nextControls;
      if (controls?.pointer === false || !animate) {
        clearTimeout(pointerTail);
        cancelAnimationFrame(pointerFrame);
        pointerTail = pointerFrame = 0;
        sendPointer(null);
      }
      sync();
      if (look !== next) {
        look = next;
        if (mayDraw()) send({ type: 'look', id, look });
      }
      if (gridChanged) resize();
    },
    react(kind, strength, start) {
      const important = kind !== 'pulse' || strength >= 0.75;
      if (!important && performance.now() - lastBeat < 160) return;
      lastBeat = performance.now();
      const play = () => {
        if (disposed || !animate || !visible()) return;
        trigger(kind, strength, look.full ? 0.85 : 0.72);
        clearTimeout(startTimer);
        if (start) startTimer = window.setTimeout(() => trigger('pulse', 0.42, 0.6), 450);
      };
      if (appWindow && animate) void checkNative().then(play);
      else play();
    },
    dispose() {
      disposed = true;
      clearTimeout(burst);
      clearTimeout(startTimer);
      clearTimeout(watchdog);
      clearTimeout(pointerTail);
      clearInterval(nativePoll);
      cancelAnimationFrame(pointerFrame);
      stage?.removeEventListener('pointermove', onPointer);
      stage?.removeEventListener('pointerleave', onLeave);
      if (worker) {
        worker.postMessage({ type: 'dispose', id } satisfies FieldMessage);
        leaveWorker();
      }
      engine?.dispose();
      stopObserving();
      sizes.disconnect();
      resolution.removeEventListener('change', watchResolution);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', onWindowVisibility);
      window.removeEventListener('focus', onWindowVisibility);
      document.removeEventListener('visibilitychange', onWindowVisibility);
      canvas!.remove();
      publishQuality(id, null);
    },
  };
}

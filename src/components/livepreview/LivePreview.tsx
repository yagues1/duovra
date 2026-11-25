import {
  ArrowLeft, ArrowRight, Camera, ExternalLink, Globe, Images, Laptop, Maximize2, Minimize2, Monitor,
  MousePointerClick, Network, PictureInPicture2, Play, RotateCcw, RotateCw, ScrollText, Server, ShieldCheck,
  Smartphone, Tablet, TriangleAlert, X,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../state/store';
import { useLivePreview, type Drawer } from '../../state/livePreview';
import { spaceOf } from '../../lib/worktrees';
import { errorText } from '../../lib/ipc';
import {
  DEVICES, detectedUrls, fitViewport, isLocalUrl, loadErrorText, lpApi, normalizeAddress, portOf, shortUrl,
  type Bounds, type LpNotice, type Viewport,
} from '../../lib/livePreview';
import { confirmDialog } from '../ui/Dialog';
import { ensurePreviewEvents } from './previewEvents';
import { getLocale, tr, useTr } from '../../i18n';
import '../../styles/live-preview.css';

const Tools = lazy(() => import('./PreviewTools'));

const DEVICE_ICON = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone };
const deviceName = (id: string) => ({ desktop: tr('Escritorio'), laptop: tr('Portátil'), tablet: tr('Tablet'), mobile: tr('Móvil') }[id] ?? id);
const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Live Preview de un espacio (proyecto o worktree). La página vive en una WebView nativa aislada.
 *
 * La interfaz se monta siempre en el mismo nodo (`host`) y la vista ampliada solo mueve ese nodo
 * de Workbench a `body`: así ampliar o reducir no desmonta los controles, no pierde su estado ni
 * oculta y vuelve a mostrar la página.
 */
export default function LivePreview({ space }: { space: string }) {
  useTr();
  ensurePreviewEvents();
  const expanded = useLivePreview((s) => s.expanded);
  const slot = useRef<HTMLDivElement>(null);
  const [host] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    const target = expanded ? document.body : slot.current;
    if (!target) return;
    host.className = expanded ? 'lp-expanded' : 'lp-host';
    if (expanded) {
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', tr('Live Preview ampliado'));
    } else {
      host.removeAttribute('role');
      host.removeAttribute('aria-label');
    }
    if (host.parentNode !== target) target.appendChild(host);
  }, [expanded, host]);
  useLayoutEffect(() => () => host.remove(), [host]);
  // Al salir de la vista (otra pestaña, otro espacio, Workbench cerrado) no queda nada ampliado.
  useEffect(() => () => useLivePreview.getState().setExpanded(false), []);
  return <>
    <div ref={slot} className="lp-slot">
      {expanded && <div className="lp-placeholder workspace-note">{tr('Live Preview está en vista ampliada.')}</div>}
    </div>
    {createPortal(<PreviewSurface space={space} expanded={expanded} />, host)}
  </>;
}

function useConfig(space: string) {
  const stored = useLivePreview((s) => s.configs[space]);
  return stored ?? useLivePreview.getState().config(space);
}

function PreviewSurface({ space, expanded }: { space: string; expanded: boolean }) {
  const config = useConfig(space);
  const live = useLivePreview((s) => s.live[space]);
  const open = useLivePreview((s) => !!s.open[space]);
  const drawer = useLivePreview((s) => s.drawer[space] ?? null);
  const lp = useLivePreview.getState();
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [responsive, setResponsive] = useState(config.viewport.mode === 'device');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Solo cuenta el último intento de apertura: uno anterior que termina tarde no pisa su estado.
  const attempt = useRef(0);
  const detached = !!live?.detached;
  const loadError = open ? live?.nav?.error ?? null : null;
  // Tras «Reintentar» la página sigue oculta hasta que termina la nueva carga (la detecta el cambio
  // de `seq`, que avanza con cada petición): sin parpadeos de la página de error de WebView2.
  const [retrySeq, setRetrySeq] = useState<number | null>(null);
  if (retrySeq !== null && (!open || ((live?.seq ?? 0) !== retrySeq && !live?.nav?.loading))) setRetrySeq(null);
  const retrying = retrySeq !== null;
  const viewport = config.viewport;
  const fitted = fitViewport(viewport, room);
  const device = viewport.mode === 'device';
  const toast = useStore((s) => s.toast);

  // Estado inicial: si la vista sigue viva (cambio de pestaña o de worktree) se recupera tal cual.
  useEffect(() => {
    if (!native) return;
    let alive = true;
    lpApi.state(space).then((summary) => {
      // Si mientras tanto empezó una apertura, su resultado manda.
      if (!alive || attempt.current) return;
      useLivePreview.getState().setLive(summary);
      useLivePreview.getState().setOpen(space, summary.alive);
    }, () => undefined);
    return () => { alive = false; };
  }, [space]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom({ width: el.clientWidth - (device ? 24 : 0), height: el.clientHeight - (device ? 24 : 0) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [device]);

  useNativeView(space, frame, open && !detached && !loadError && !retrying, device, fitted.scale, expanded);

  // Esc sale del inspector o de la vista ampliada antes de cerrar Workbench.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]:not(#workbench)')) return;
      const s = useLivePreview.getState();
      if (s.live[space]?.inspecting) void lpApi.inspect(space, false);
      else if (s.expanded) s.setExpanded(false);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [space]);

  const bounds = (): Bounds | null => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height, cssWidth: window.innerWidth, zoom: fitted.scale, device };
  };

  /** Abre o navega. Devuelve si la orden se aceptó (la carga sigue en la página). */
  const navigate = async (raw: string, external = false): Promise<boolean> => {
    const url = normalizeAddress(raw);
    if (!url) {
      toast(tr('Escribe una dirección completa, por ejemplo localhost:5173.'), 'error');
      return false;
    }
    const b = bounds();
    if (!b) return false;
    const mine = ++attempt.current;
    setBusy(true);
    setFailure(null);
    try {
      const summary = await lpApi.open(space, url, external, b);
      lp.setLive(summary);
      lp.setOpen(space, true);
      lp.remember(space, url);
      return true;
    } catch (e) {
      if (mine !== attempt.current) return false;
      const message = errorText(e);
      if (message.startsWith('EXTERNAL:')) {
        setBusy(false);
        const ok = await confirmDialog({
          title: tr('¿Abrir un sitio externo?'),
          body: tr('{host} no es un servidor local. Live Preview lo abrirá aislado, sin acceso a Duovra, pero el contenido no es tuyo. Las páginas externas no se abren nunca solas.', { host: message.slice(9) }),
          confirmLabel: tr('Abrir'),
        });
        return ok && mine === attempt.current ? navigate(url, true) : false;
      }
      if (useLivePreview.getState().open[space]) toast(message, 'error');
      else setFailure(message);
      return false;
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  };

  const close = async () => {
    attempt.current++;
    await lpApi.close(space).catch(() => undefined);
    lp.setOpen(space, false);
    lp.setElement(space, null);
    lp.setExpanded(false);
  };

  // Dirección pedida desde la conversación: se abre por la acción explícita del usuario.
  const pending = useLivePreview((s) => s.pending[space]);
  useEffect(() => {
    if (!pending || detached) return;
    const url = useLivePreview.getState().consumePending(space);
    if (url) requestAnimationFrame(() => void navigate(url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, space, detached]);

  const setViewport = (patch: Partial<Viewport>) => lp.setConfig(space, { viewport: { ...viewport, ...patch } });
  const toggleDrawer = (next: Drawer) => lp.setDrawer(space, drawer === next ? null : next);

  return (
    <div className="lp-root" data-expanded={expanded || undefined}>
      <NavBar space={space} url={config.url} recent={config.recent} open={open} busy={busy} navigate={navigate} close={close} />
      {open && <ToolStrip space={space} drawer={drawer} toggleDrawer={toggleDrawer} responsive={responsive}
        setResponsive={(on) => { setResponsive(on); setViewport({ mode: on ? 'device' : 'fill' }); }} />}
      {open && responsive && <ResponsiveBar viewport={viewport} fitted={fitted} set={setViewport}
        mobile={!!live?.mobile} setMobile={(on) => void lpApi.emulate(space, on).catch((e) => toast(errorText(e), 'error'))} />}
      <Notices space={space} notices={live?.notices ?? []} />
      <div ref={stage} className="lp-stage" data-device={device || undefined}>
        <div ref={frame} className="lp-frame"
          style={device ? { width: Math.round(fitted.width * fitted.scale), height: Math.round(fitted.height * fitted.scale) } : undefined}>
          {detached ? <DetachedNote space={space} />
            : !open ? <EmptyState space={space} url={config.url} recent={config.recent} navigate={navigate} failure={failure} busy={busy} />
              : (loadError || retrying) && <LoadError space={space} code={loadError} url={live?.nav?.url || config.url} retrying={retrying}
                retry={() => {
                  setRetrySeq(live?.seq ?? 0);
                  void lpApi.action(space, 'reload').catch((e) => { setRetrySeq(null); toast(errorText(e), 'error'); });
                }} />}
          {open && !loadError && live?.nav?.loading && <span className="lp-loading" aria-hidden />}
        </div>
      </div>
      {drawer && <Suspense fallback={<p className="workspace-note">{tr('Cargando…')}</p>}>
        <Tools space={space} drawer={drawer} close={() => lp.setDrawer(space, null)} />
      </Suspense>}
    </div>
  );
}

/**
 * Coloca la WebView nativa sobre el hueco y la oculta cuando algo de Duovra debe quedar encima.
 * Solo se oculta al dejar de estar activa (otra pestaña, otro espacio, error, ventana aparte): cambiar
 * el tamaño simulado, el zoom o ampliar la vista solo la recoloca, sin parpadeos.
 */
function useNativeView(space: string, frame: RefObject<HTMLDivElement | null>, active: boolean, device: boolean, zoom: number, expanded: boolean) {
  const view = useRef({ device, zoom });
  const resync = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    view.current = { device, zoom };
    resync.current();
  }, [device, zoom, expanded]);
  useEffect(() => {
    if (!native) return;
    if (!active) {
      void lpApi.bounds(space, null).catch(() => undefined);
      return;
    }
    let raf = 0;
    let last = '';
    const timers = new Set<number>();
    // Una WebView nativa siempre se pinta encima del HTML: se oculta mientras un diálogo modal de
    // Duovra está abierto o mientras un menú se superpone a su hueco (no por menús lejanos).
    const covered = (r: DOMRect) => {
      if (document.querySelector('dialog[open]:not(#workbench)')) return true;
      return [...document.querySelectorAll<HTMLElement>('.popover[data-state="open"]')].some((menu) => {
        const m = menu.getBoundingClientRect();
        return m.right > r.left && m.left < r.right && m.bottom > r.top && m.top < r.bottom;
      });
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = frame.current;
        const r = el?.getBoundingClientRect();
        const visible = !!el && !!r && r.width > 2 && r.height > 2 && el.checkVisibility() && !covered(r);
        const { device: simulated, zoom: scale } = view.current;
        const b: Bounds | null = visible ? { x: r.left, y: r.top, width: r.width, height: r.height, cssWidth: window.innerWidth, zoom: scale, device: simulated } : null;
        placeToasts(b);
        const key = JSON.stringify(b);
        if (key === last) return;
        last = key;
        void lpApi.bounds(space, b).catch(() => undefined);
      });
    };
    // Tras una animación (entrada de Workbench, vista ampliada) se vuelve a medir al terminar.
    const settle = () => {
      sync();
      for (const delay of [280, 620]) {
        const t = window.setTimeout(() => { timers.delete(t); sync(); }, delay);
        timers.add(t);
      }
    };
    resync.current = settle;
    settle();
    const ro = new ResizeObserver(sync);
    if (frame.current) ro.observe(frame.current);
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'data-state'] });
    mo.observe(document.body, { childList: true });
    // Los menús abiertos desde Workbench se montan dentro de su diálogo, no en `body`.
    const workbench = document.getElementById('workbench');
    if (workbench) mo.observe(workbench, { childList: true });
    window.addEventListener('resize', sync);
    window.addEventListener('animationend', sync, true);
    return () => {
      resync.current = () => undefined;
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('animationend', sync, true);
      placeToasts(null);
      void lpApi.bounds(space, null).catch(() => undefined);
    };
  }, [space, frame, active]);
}

/**
 * Los avisos de Duovra se centran abajo, justo donde suele estar la página nativa, que los taparía.
 * Con la página visible se colocan a su izquierda si hay sitio o, si no (vista ampliada), encima.
 */
function placeToasts(b: Bounds | null) {
  const root = document.documentElement;
  if (!b) {
    delete root.dataset.lpToasts;
    return;
  }
  if (b.x >= 340) {
    root.dataset.lpToasts = 'side';
    root.style.setProperty('--lp-toast-x', `${Math.round(b.x / 2)}px`);
  } else {
    root.dataset.lpToasts = 'top';
    root.style.setProperty('--lp-toast-x', `${Math.round(b.x + b.width / 2)}px`);
    root.style.setProperty('--lp-toast-bottom', `${Math.round(window.innerHeight - b.y + 8)}px`);
  }
}

function NavBar({ space, url, recent, open, busy, navigate, close }: {
  space: string; url: string; recent: string[]; open: boolean; busy: boolean;
  navigate: (url: string) => Promise<boolean>; close: () => Promise<void>;
}) {
  const nav = useLivePreview((s) => s.live[space]?.nav);
  const input = useRef<HTMLInputElement>(null);
  const expanded = useLivePreview((s) => s.expanded);
  const setExpanded = useLivePreview((s) => s.setExpanded);
  const toast = useStore((s) => s.toast);
  const current = open ? nav?.url || url : url;
  const [draft, setDraft] = useState(current);
  const [editing, setEditing] = useState(false);
  if (!editing && draft !== current && current !== 'about:blank') setDraft(current);
  const listId = `lp-recent-${space}`;
  const act = (action: 'back' | 'forward' | 'reload' | 'stop') => void lpApi.action(space, action).catch((e) => toast(errorText(e), 'error'));
  const local = current ? isLocalUrl(current) : true;
  return (
    <div className="lp-navbar">
      <div className="lp-nav-group">
        <IconButton label={tr('Atrás')} disabled={!open || !nav?.canGoBack} onClick={() => act('back')}><ArrowLeft size={14} /></IconButton>
        <IconButton label={tr('Adelante')} disabled={!open || !nav?.canGoForward} onClick={() => act('forward')}><ArrowRight size={14} /></IconButton>
        {nav?.loading && open
          ? <IconButton label={tr('Detener carga')} onClick={() => act('stop')}><X size={14} /></IconButton>
          : <IconButton label={tr('Recargar')} disabled={!open} onClick={() => act('reload')}><RotateCw size={13} /></IconButton>}
      </div>
      {/* Lo escrito se conserva si la dirección no es válida o la apertura falla; al aceptarse,
          la barra vuelve a mostrar la dirección real de la página. */}
      <form className="lp-address" data-local={local || undefined} aria-busy={busy || undefined} onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        void navigate(draft).then((ok) => { if (ok) input.current?.blur(); });
      }}>
        <span className="lp-address-icon" data-tip={local ? tr('Servidor local') : tr('Sitio externo · aislado')}>
          {local ? <ShieldCheck size={12} aria-hidden /> : <Globe size={12} aria-hidden />}
        </span>
        <input ref={input} className="selectable" value={draft} list={listId} spellCheck={false}
          aria-label={tr('Dirección de la página')} placeholder="http://localhost:5173"
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(current); e.currentTarget.blur(); } }} />
        <datalist id={listId}>{recent.map((u) => <option key={u} value={u} />)}</datalist>
      </form>
      <div className="lp-nav-group">
        <IconButton label={tr('Abrir en el navegador')} disabled={!current} onClick={() => void lpApi.openExternal(current).catch((e) => toast(errorText(e), 'error'))}><ExternalLink size={13} /></IconButton>
        <IconButton label={expanded ? tr('Reducir') : tr('Ampliar')} disabled={!open} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>
        <IconButton label={tr('Abrir en ventana independiente')} disabled={!open} onClick={() => {
          setExpanded(false);
          void lpApi.detach(space, getLocale()).catch((e) => toast(errorText(e), 'error'));
        }}><PictureInPicture2 size={13} /></IconButton>
        <IconButton label={tr('Cerrar Live Preview')} disabled={!open} onClick={() => void close()}><X size={15} /></IconButton>
      </div>
    </div>
  );
}

function ToolStrip({ space, drawer, toggleDrawer, responsive, setResponsive }: {
  space: string; drawer: Drawer; toggleDrawer: (d: Drawer) => void; responsive: boolean; setResponsive: (on: boolean) => void;
}) {
  const live = useLivePreview((s) => s.live[space]);
  const captures = useLivePreview((s) => s.captures[space]?.length ?? 0);
  const addCapture = useLivePreview((s) => s.addCapture);
  const setDrawer = useLivePreview((s) => s.setDrawer);
  const toast = useStore((s) => s.toast);
  const inspecting = !!live?.inspecting;
  const counts = live?.counts;
  const server = live?.server;
  const shoot = async () => {
    try {
      addCapture(space, await lpApi.capture(space, 'viewport'));
      setDrawer(space, 'captures');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="lp-tools" role="toolbar" aria-label={tr('Herramientas de Live Preview')}>
      <ToolButton on={inspecting} label={inspecting ? tr('Salir de la selección (Esc)') : tr('Seleccionar un elemento de la página')}
        onClick={() => void lpApi.inspect(space, !inspecting).catch((e) => toast(errorText(e), 'error'))}>
        <MousePointerClick size={13} /><span>{inspecting ? tr('Seleccionando…') : tr('Inspeccionar')}</span>
      </ToolButton>
      <ToolButton label={tr('Capturar el área visible')} onClick={() => void shoot()}><Camera size={13} /></ToolButton>
      <ToolButton on={responsive} label={tr('Tamaños de pantalla')} onClick={() => setResponsive(!responsive)}><Smartphone size={13} /></ToolButton>
      <span className="lp-tools-sep" aria-hidden />
      <ToolButton on={drawer === 'console'} label={tr('Consola')} onClick={() => toggleDrawer('console')}>
        <ScrollText size={13} />{!!counts?.errors && <Badge tone="error">{counts.errors}</Badge>}
        {!counts?.errors && !!counts?.warnings && <Badge tone="warn">{counts.warnings}</Badge>}
      </ToolButton>
      <ToolButton on={drawer === 'network'} label={tr('Red')} onClick={() => toggleDrawer('network')}>
        <Network size={13} />{!!counts?.failed && <Badge tone="error">{counts.failed}</Badge>}
      </ToolButton>
      <ToolButton on={drawer === 'captures'} label={tr('Capturas')} onClick={() => toggleDrawer('captures')}>
        <Images size={13} />{!!captures && <Badge>{captures}</Badge>}
      </ToolButton>
      <ToolButton on={drawer === 'server'} label={server?.running ? tr('Servidor iniciado por Duovra') : tr('Servidor de desarrollo')} onClick={() => toggleDrawer('server')}>
        <Server size={13} />{server?.running && <span className="lp-dot" aria-label={tr('En marcha')} />}
      </ToolButton>
      {drawer !== 'element' && useLivePreview.getState().element[space] && (
        <ToolButton label={tr('Elemento seleccionado')} onClick={() => toggleDrawer('element')}><span>{tr('Elemento')}</span></ToolButton>
      )}
    </div>
  );
}

function ResponsiveBar({ viewport, fitted, set, mobile, setMobile }: {
  viewport: Viewport; fitted: { width: number; height: number; scale: number };
  set: (patch: Partial<Viewport>) => void; mobile: boolean; setMobile: (on: boolean) => void;
}) {
  const scales: Array<'fit' | number> = ['fit', 0.5, 0.75, 1];
  return (
    <div className="lp-responsive">
      <div className="lp-seg" role="radiogroup" aria-label={tr('Dispositivo')}>
        {DEVICES.map((d) => {
          const Icon = DEVICE_ICON[d.kind];
          const on = viewport.device === d.id;
          return <button key={d.id} type="button" role="radio" aria-checked={on} data-tip={`${deviceName(d.id)} · ${d.width}×${d.height}`}
            onClick={() => set({ device: d.id, width: d.width, height: d.height })}><Icon size={13} aria-hidden /><span className="sr-only">{deviceName(d.id)}</span></button>;
        })}
        <button type="button" role="radio" aria-checked={viewport.device === 'custom'} onClick={() => set({ device: 'custom' })}>{tr('Personalizado')}</button>
      </div>
      <div className="lp-dims">
        <NumberField label={tr('Ancho')} value={viewport.landscape ? viewport.height : viewport.width}
          onChange={(v) => set(viewport.landscape ? { height: v, device: 'custom' } : { width: v, device: 'custom' })} />
        <span aria-hidden>×</span>
        <NumberField label={tr('Alto')} value={viewport.landscape ? viewport.width : viewport.height}
          onChange={(v) => set(viewport.landscape ? { width: v, device: 'custom' } : { height: v, device: 'custom' })} />
        <IconButton label={viewport.landscape ? tr('Vertical') : tr('Horizontal')} onClick={() => set({ landscape: !viewport.landscape })}><RotateCcw size={13} /></IconButton>
        <select className="lp-select" aria-label={tr('Escala')} value={String(viewport.scale)}
          onChange={(e) => set({ scale: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })}>
          {scales.map((s) => <option key={String(s)} value={String(s)}>{s === 'fit' ? tr('Ajustar') : `${Math.round(s * 100)} %`}</option>)}
        </select>
        <span className="lp-size" aria-live="polite">{fitted.width}×{fitted.height} · {Math.round(fitted.scale * 100)} %</span>
      </div>
      <label className="lp-check" data-tip={tr('Cambia el agente de usuario y simula eventos táctiles. Recarga la página.')}>
        <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} />
        {tr('Emular táctil')}
      </label>
      <p className="lp-hint">{mobile ? tr('Simulación de tamaño con agente de usuario móvil y eventos táctiles. No es una emulación completa del dispositivo.')
        : tr('Simulación del tamaño de pantalla: no emula el dispositivo (agente de usuario, táctil ni rendimiento).')}</p>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  if (document.activeElement?.getAttribute('aria-label') !== label && text !== String(value)) setText(String(value));
  return <input className="lp-num selectable" aria-label={label} inputMode="numeric" value={text}
    onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
    onBlur={() => { const v = Math.min(3840, Math.max(240, Number(text) || value)); setText(String(v)); onChange(v); }}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

const NOTICE_TEXT: Record<LpNotice['kind'], (detail: string) => string> = {
  navigation: (d) => tr('Duovra detuvo la navegación a un sitio externo o no admitido: {url}', { url: shortUrl(d, 70) }),
  popup: (d) => tr('La página intentó abrir una ventana nueva: {url}', { url: shortUrl(d, 70) }),
  download: (d) => tr('Descarga bloqueada: {url}', { url: shortUrl(d, 70) }),
  permission: (d) => tr('La página pidió un permiso ({kind}) y Duovra lo denegó.', { kind: d }),
};

function Notices({ space, notices }: { space: string; notices: LpNotice[] }) {
  const last = notices.at(-1);
  const toast = useStore((s) => s.toast);
  if (!last) return null;
  const canOpen = (last.kind === 'navigation' || last.kind === 'popup') && /^https?:/i.test(last.detail);
  return (
    <div className="lp-notice" role="status">
      <TriangleAlert size={13} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{NOTICE_TEXT[last.kind](last.detail)}</span>
      {canOpen && <button type="button" className="lp-link" onClick={() => void lpApi.allow(space, last.detail).then(() => lpApi.clear(space, 'notices')).catch((e) => toast(errorText(e), 'error'))}>{tr('Permitir y abrir aquí')}</button>}
      {(canOpen || last.kind === 'download') && <button type="button" className="lp-link" onClick={() => void lpApi.openExternal(last.detail).catch((e) => toast(errorText(e), 'error'))}>{tr('Abrir en el navegador')}</button>}
      <IconButton label={tr('Descartar aviso')} onClick={() => void lpApi.clear(space, 'notices')}><X size={12} /></IconButton>
    </div>
  );
}

function EmptyState({ space, url, recent, navigate, failure, busy }: {
  space: string; url: string; recent: string[]; navigate: (url: string) => Promise<boolean>; failure: string | null; busy: boolean;
}) {
  const conversationId = useStore((s) => s.activeConversationId);
  const messages = useStore((s) => (conversationId ? s.messages[conversationId] : undefined));
  const sameSpace = useStore((s) => s.conversations.some((c) => c.id === conversationId && spaceOf(c) === space));
  const announced = useLivePreview((s) => s.live[space]?.server?.urls ?? NONE);
  const detected = useMemo(() => {
    const fromAgents = sameSpace ? detectedUrls(messages) : [];
    return [...announced, ...fromAgents].filter((u, i, all) => all.indexOf(u) === i && u !== url).slice(0, 5);
  }, [messages, sameSpace, announced, url]);
  if (!native) return <div className="lp-empty"><p className="workspace-note">{tr('Live Preview necesita la aplicación de escritorio.')}</p></div>;
  const others = recent.filter((u) => u !== url).slice(0, 3);
  return (
    <div className="lp-empty">
      <Globe size={22} aria-hidden className="lp-empty-icon" />
      <h3>Live Preview</h3>
      <p>{tr('Abre tu servidor de desarrollo para verlo, inspeccionarlo y enviar elementos al agente.')}</p>
      {url && <button type="button" className="lp-primary" disabled={busy} onClick={() => void navigate(url)}><Play size={12} aria-hidden />{tr('Abrir {url}', { url: shortUrl(url, 40) })}</button>}
      {detected.length > 0 && <div className="lp-suggest">
        <span>{tr('Servidores detectados')}</span>
        {detected.map((u) => <button key={u} type="button" className="lp-chip" onClick={() => void navigate(u)}
          data-tip={tr('Mencionado por el agente o por el servidor. No se abre solo.')}>{shortUrl(u, 36)}</button>)}
      </div>}
      {others.length > 0 && <div className="lp-suggest">
        <span>{tr('Recientes')}</span>
        {others.map((u) => <button key={u} type="button" className="lp-chip" onClick={() => void navigate(u)}>{shortUrl(u, 36)}</button>)}
      </div>}
      {failure && <p className="lp-error" role="alert">{failure}</p>}
      {url && <PortHint url={url} />}
    </div>
  );
}

/** Indica (sin peticiones HTTP) si algo escucha ya en el puerto configurado. */
function PortHint({ url }: { url: string }) {
  const [state, setState] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    lpApi.portOpen(url).then((v) => alive && setState(v), () => undefined);
    return () => { alive = false; };
  }, [url]);
  if (state === null) return null;
  return <p className="lp-hint">{state ? tr('Hay un proceso escuchando en el puerto {port}.', { port: portOf(url) ?? '' })
    : tr('Nada escucha en el puerto {port}. Inicia tu servidor o configúralo en Servidor.', { port: portOf(url) ?? '' })}</p>;
}

/**
 * La página no se pudo cargar: el aviso de Duovra sustituye a la página de error de WebView2 (que
 * queda oculta). Consola, red y servidor siguen disponibles para averiguar por qué.
 */
function LoadError({ space, code, url, retrying, retry }: { space: string; code: string | null; url: string; retrying: boolean; retry: () => void }) {
  const toast = useStore((s) => s.toast);
  const local = isLocalUrl(url);
  return (
    <div className="lp-empty lp-load-error" role="alert" aria-busy={retrying || undefined}>
      <TriangleAlert size={20} aria-hidden className="lp-empty-icon" />
      <h3>{tr('No se pudo cargar la página')}</h3>
      <p>{code ? loadErrorText(code, url) : tr('Cargando de nuevo…')}</p>
      {code && <code className="lp-error-code">{code.replace(/^net::/, '')}</code>}
      <div className="lp-error-actions">
        <button type="button" className="lp-primary" disabled={retrying} onClick={retry}>
          <RotateCw size={12} aria-hidden />{retrying ? tr('Reintentando…') : tr('Reintentar')}
        </button>
        {local && <button type="button" className="lp-btn" onClick={() => useLivePreview.getState().setDrawer(space, 'server')}>
          <Server size={12} aria-hidden />{tr('Servidor de desarrollo')}
        </button>}
        <button type="button" className="lp-btn" onClick={() => void lpApi.openExternal(url).catch((e) => toast(errorText(e), 'error'))}>
          <ExternalLink size={12} aria-hidden />{tr('Abrir en el navegador')}
        </button>
      </div>
      {local && <PortHint url={url} />}
    </div>
  );
}

function DetachedNote({ space }: { space: string }) {
  const toast = useStore((s) => s.toast);
  return (
    <div className="lp-empty">
      <PictureInPicture2 size={20} aria-hidden className="lp-empty-icon" />
      <p>{tr('La página está en una ventana independiente. Consola, red, capturas e inspector siguen aquí.')}</p>
      <button type="button" className="lp-primary" onClick={() => void lpApi.attach(space).catch((e) => toast(errorText(e), 'error'))}>{tr('Traer a Workbench')}</button>
    </div>
  );
}

const NONE: string[] = [];

export function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className="btn-icon lp-icon" aria-label={label} data-tip={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function ToolButton({ label, onClick, on, children }: { label: string; onClick: () => void; on?: boolean; children: ReactNode }) {
  return <button type="button" className="lp-tool" aria-label={label} data-tip={label} aria-pressed={on ?? undefined} onClick={onClick}>{children}</button>;
}

export function Badge({ tone, children }: { tone?: 'error' | 'warn'; children: ReactNode }) {
  return <span className="lp-badge" data-tone={tone}>{children}</span>;
}


import { ArrowDownToLine, ArrowUpToLine, Camera, Copy, Crop, Download, Eraser, Paperclip, Play, Search, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { save } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../state/store';
import { useLivePreview, type Drawer, type NewPreviewRef } from '../../state/livePreview';
import { errorText } from '../../lib/ipc';
import { rootOf } from '../../lib/worktrees';
import { captureLabel, lpApi, portOf, shortUrl, type Capture, type ConsoleEntry, type NetEntry, type ServerView } from '../../lib/livePreview';
import { confirmDialog } from '../ui/Dialog';
import { Badge, IconButton } from './LivePreview';
import { tr, useTr } from '../../i18n';

const TITLE: Record<Exclude<Drawer, null>, () => string> = {
  console: () => tr('Consola'),
  network: () => tr('Red'),
  server: () => tr('Servidor de desarrollo'),
  element: () => tr('Elemento seleccionado'),
  captures: () => tr('Capturas'),
};

/** Cajón plegable bajo la página. Solo existe mientras se usa: nada consulta la página si está cerrado. */
export default function PreviewTools({ space, drawer, close }: { space: string; drawer: Exclude<Drawer, null>; close: () => void }) {
  useTr();
  return (
    <section className="lp-drawer" aria-label={TITLE[drawer]()}>
      <header className="lp-drawer-head">
        <h4>{TITLE[drawer]()}</h4>
        <IconButton label={tr('Plegar')} onClick={close}><X size={13} /></IconButton>
      </header>
      <div className="lp-drawer-body">
        {drawer === 'console' && <ConsolePane space={space} />}
        {drawer === 'network' && <NetworkPane space={space} />}
        {drawer === 'server' && <ServerPane space={space} />}
        {drawer === 'element' && <ElementPane space={space} />}
        {drawer === 'captures' && <CapturesPane space={space} />}
      </div>
    </section>
  );
}

const pageOf = (space: string) => useLivePreview.getState().live[space]?.nav?.url ?? '';

function attachRef(ref: NewPreviewRef) {
  if (useLivePreview.getState().addRef(ref)) useStore.getState().toast(tr('Añadido al compositor. Escribe tu instrucción y elige el agente.'), 'info');
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => useStore.getState().toast(tr('Copiado'), 'info'),
    () => useStore.getState().toast(tr('No se pudo copiar.'), 'error'),
  );
}

/** Lista que se vuelve a leer cuando el backend avisa de cambios (`seq`), solo con el cajón abierto. */
function useList<T>(space: string, read: (space: string) => Promise<T[]>) {
  const seq = useLivePreview((s) => s.live[space]?.seq ?? 0);
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let alive = true;
    read(space).then((list) => alive && setItems(list), () => undefined);
    return () => { alive = false; };
  }, [space, seq, read]);
  return items;
}

// ── Consola ───────────────────────────────────────────────────────────────────────────────

const LEVELS = ['error', 'warn', 'info', 'log'] as const;
const levelName = (l: string) => ({ error: tr('Errores'), warn: tr('Avisos'), info: tr('Información'), log: tr('Registros') }[l] ?? l);

function ConsolePane({ space }: { space: string }) {
  const entries = useList(space, lpApi.console);
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<Set<string>>(() => new Set(LEVELS));
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => levels.has(e.level === 'debug' ? 'log' : e.level) && (!q || e.text.toLowerCase().includes(q) || e.source?.toLowerCase().includes(q)));
  }, [entries, query, levels]);
  // Sigue al último mensaje solo si ya se estaba al final. Se desplaza la propia lista (no
  // `scrollIntoView`, que movería también Workbench) y el efecto no devuelve nada: en WebView2
  // reciente `scrollIntoView()` devuelve una Promise, y React la trataba como función de limpieza
  // («l is not a function» al plegar la consola o al llegar mensajes nuevos).
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [list.length]);
  return <>
    <div className="lp-filter">
      <SearchField value={query} onChange={setQuery} label={tr('Buscar en la consola')} />
      <div className="lp-seg lp-seg-sm" role="group" aria-label={tr('Niveles')}>
        {LEVELS.map((l) => <button key={l} type="button" aria-pressed={levels.has(l)} data-level={l}
          onClick={() => setLevels((s) => { const n = new Set(s); if (n.has(l)) n.delete(l); else n.add(l); return n; })}>{levelName(l)}</button>)}
      </div>
      <IconButton label={tr('Limpiar vista')} onClick={() => void lpApi.clear(space, 'console')}><Eraser size={13} /></IconButton>
    </div>
    <div ref={listRef} className="lp-list selectable" role="log"
      onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {!list.length && <p className="workspace-note">{entries.length ? tr('Ningún mensaje coincide.') : tr('Sin mensajes de consola.')}</p>}
      {list.map((e) => <ConsoleRow key={e.seq} space={space} entry={e} />)}
    </div>
  </>;
}

function ConsoleRow({ space, entry }: { space: string; entry: ConsoleEntry }) {
  const [open, setOpen] = useState(false);
  const where = entry.source ? `${shortUrl(entry.source, 40)}${entry.line ? `:${entry.line}` : ''}` : null;
  const full = `${entry.text}${entry.source ? `\n${entry.source}${entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ''}` : ''}` : ''}${entry.stack ? `\n${entry.stack}` : ''}`;
  return (
    <div className="lp-row" data-level={entry.level}>
      <button type="button" className="lp-row-main" aria-expanded={entry.stack ? open : undefined} onClick={() => setOpen(!open)}>
        <span className="lp-row-text">{entry.text || '—'}</span>
        {where && <span className="lp-row-where">{where}</span>}
      </button>
      {open && entry.stack && <pre className="lp-stack">{entry.stack}</pre>}
      <div className="lp-row-actions">
        <IconButton label={tr('Copiar mensaje')} onClick={() => copyText(full)}><Copy size={12} /></IconButton>
        {(entry.level === 'error' || entry.level === 'warn') &&
          <IconButton label={tr('Enviar al compositor')} onClick={() => attachRef({ space, kind: 'console', entry, page: pageOf(space) })}><Paperclip size={12} /></IconButton>}
      </div>
    </div>
  );
}

// ── Red ───────────────────────────────────────────────────────────────────────────────────

function NetworkPane({ space }: { space: string }) {
  const entries = useList(space, lpApi.network);
  const [query, setQuery] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => (!failedOnly || e.failed) && (!q || e.url.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q)));
  }, [entries, query, failedOnly]);
  return <>
    <div className="lp-filter">
      <SearchField value={query} onChange={setQuery} label={tr('Filtrar peticiones')} />
      <label className="lp-check"><input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />{tr('Solo fallidas')}</label>
      <IconButton label={tr('Limpiar vista')} onClick={() => void lpApi.clear(space, 'network')}><Eraser size={13} /></IconButton>
    </div>
    <p className="lp-hint">{tr('Sin cabeceras, cookies ni cuerpos: solo URL (con parámetros sensibles ocultos), método, estado, tipo y duración.')}</p>
    <div className="lp-list selectable" role="table" aria-label={tr('Peticiones')}>
      {!list.length && <p className="workspace-note">{entries.length ? tr('Ninguna petición coincide.') : tr('Sin peticiones desde la última carga.')}</p>}
      {list.map((e) => <NetRow key={e.seq} space={space} entry={e} />)}
    </div>
  </>;
}

function NetRow({ space, entry }: { space: string; entry: NetEntry }) {
  return (
    <div className="lp-net" role="row" data-failed={entry.failed || undefined}>
      <span className="lp-net-status" role="cell">{entry.status ?? (entry.failed ? '✕' : entry.done ? '—' : '…')}</span>
      <span className="lp-net-method" role="cell">{entry.method}</span>
      <span className="lp-net-url" role="cell" title={entry.error ? `${entry.url}\n${entry.error}` : entry.url}>{shortUrl(entry.url, 64)}</span>
      <span className="lp-net-kind" role="cell">{entry.kind}</span>
      <span className="lp-net-time" role="cell">{entry.durationMs != null ? `${Math.round(entry.durationMs)} ms` : ''}</span>
      <span className="lp-row-actions" role="cell">
        <IconButton label={tr('Copiar URL')} onClick={() => copyText(entry.url)}><Copy size={12} /></IconButton>
        {entry.failed && <IconButton label={tr('Enviar al compositor')} onClick={() => attachRef({ space, kind: 'network', entry, page: pageOf(space) })}><Paperclip size={12} /></IconButton>}
      </span>
    </div>
  );
}

// ── Servidor ──────────────────────────────────────────────────────────────────────────────

function ServerPane({ space }: { space: string }) {
  const lp = useLivePreview.getState();
  const config = useLivePreview((s) => s.configs[space]) ?? lp.config(space);
  const brief = useLivePreview((s) => s.live[space]?.server);
  const configs = useLivePreview((s) => s.configs);
  const root = useStore((s) => rootOf(space, s.projects, s.worktrees));
  const spaceName = (id: string) => {
    const s = useStore.getState();
    return s.worktrees.find((w) => w.id === id)?.label ?? s.projects.find((p) => p.id === id)?.name ?? id;
  };
  const toast = useStore((s) => s.toast);
  const [command, setCommand] = useState(config.command);
  const [view, setView] = useState<ServerView | null>(null);
  useEffect(() => {
    let alive = true;
    lpApi.server(space).then((v) => alive && setView(v), () => undefined);
    return () => { alive = false; };
  }, [space, brief?.lineCount, brief?.running]);
  const out = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { if (out.current) out.current.scrollTop = out.current.scrollHeight; }, [view?.lines.length]);
  const port = config.url ? portOf(config.url) : null;
  const sharing = port ? Object.entries(configs).filter(([id, c]) => id !== space && c.url && portOf(c.url) === port).map(([id]) => spaceName(id)) : [];

  const start = async () => {
    const cmd = command.trim();
    if (!cmd) return;
    lp.setConfig(space, { command: cmd });
    const busy = config.url ? await lpApi.portOpen(config.url).catch(() => false) : false;
    const ok = await confirmDialog({
      title: tr('¿Iniciar el servidor de desarrollo?'),
      body: [
        tr('Duovra ejecutará «{command}» en {root}. No instala dependencias ni ejecuta nada más.', { command: cmd, root: root ?? '' }),
        busy ? tr('Atención: ya hay un proceso escuchando en el puerto {port}. Duovra no lo detendrá.', { port: port ?? '' }) : '',
      ].filter(Boolean).join('\n\n'),
      confirmLabel: tr('Iniciar'),
    });
    if (!ok) return;
    try {
      setView(await lpApi.serverStart(space, cmd));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return <div className="lp-server">
    <form className="lp-filter" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <input className="lp-input selectable" value={command} spellCheck={false} placeholder="npm run dev" aria-label={tr('Comando de desarrollo')}
        onChange={(e) => setCommand(e.target.value)} onBlur={() => lp.setConfig(space, { command: command.trim() })} />
      {view?.running
        ? <button type="button" className="lp-btn" onClick={() => void lpApi.serverStop(space).catch((e) => toast(errorText(e), 'error'))}><Square size={11} aria-hidden />{tr('Detener')}</button>
        : <button type="submit" className="lp-btn" disabled={!command.trim()}><Play size={11} aria-hidden />{tr('Iniciar')}</button>}
    </form>
    <p className="lp-hint">{view?.running
      ? tr('En marcha · iniciado por Duovra (PID {pid}) en {root}', { pid: view.pid ?? '—', root: view.root })
      : view ? tr('Detenido · código {code}', { code: view.exitCode ?? '—' })
        : tr('Opcional. Solo se ejecuta al pulsar Iniciar, en el directorio de este espacio. Duovra nunca detiene servidores que no haya iniciado él.')}</p>
    {sharing.length > 0 && <p className="lp-hint lp-warn">{tr('Posible conflicto: el puerto {port} también lo usa {spaces}.', { port: port ?? '', spaces: sharing.join(', ') })}</p>}
    {!!view?.urls.length && <div className="lp-suggest">
      <span>{tr('Anunciado por el servidor')}</span>
      {view.urls.map((u) => <span key={u} className="lp-chip">{shortUrl(u, 36)}</span>)}
    </div>}
    {view && <pre ref={out} className="lp-output selectable" aria-label={tr('Salida del servidor')}>{view.lines.join('\n') || tr('Sin salida todavía.')}</pre>}
  </div>;
}

// ── Elemento ──────────────────────────────────────────────────────────────────────────────

function ElementPane({ space }: { space: string }) {
  const element = useLivePreview((s) => s.element[space]);
  const addCapture = useLivePreview((s) => s.addCapture);
  const toast = useStore((s) => s.toast);
  const [attaching, setAttaching] = useState(false);
  if (!element) return <p className="workspace-note">{tr('Pulsa Inspeccionar y elige un elemento de la página.')}</p>;
  const i = element.info;
  const go = (direction: 'parent' | 'child') => void lpApi.selectRelative(space, direction).catch((e) => toast(errorText(e), 'error'));
  const attach = async () => {
    setAttaching(true);
    let capture: Capture | null = null;
    try {
      capture = await lpApi.capture(space, 'element');
      addCapture(space, capture);
    } catch { /* El contexto se adjunta igualmente, sin captura. */ }
    attachRef({ space, kind: 'element', info: i, capture });
    setAttaching(false);
  };
  return <div className="lp-element selectable">
    <div className="lp-element-head">
      <code className="lp-tag">&lt;{i.tag}{i.id ? `#${i.id}` : ''}&gt;</code>
      <span className="lp-size">{i.rect.width}×{i.rect.height} · x {i.rect.x}, y {i.rect.y}</span>
    </div>
    {i.classes.length > 0 && <p className="lp-classes">.{i.classes.join(' .')}</p>}
    {i.text && <p className="lp-text">“{i.text}”</p>}
    <div className="lp-selector">
      <code>{i.selector}</code>
      {!i.unique && <Badge tone="warn">{tr('no único')}</Badge>}
      <IconButton label={tr('Copiar selector')} onClick={() => copyText(i.selector)}><Copy size={12} /></IconButton>
    </div>
    <p className="lp-hint">{i.frameworks.length ? `${i.frameworks.join(', ')}${i.component ? ` · ${i.component}` : ''} · ` : ''}
      {i.source ? tr('Archivo declarado por el framework: {file}', { file: i.source }) : tr('Archivo fuente no determinado de forma fiable.')}</p>
    <div className="lp-actions">
      <button type="button" className="lp-btn lp-btn-accent" disabled={attaching} onClick={() => void attach()}><Paperclip size={12} aria-hidden />{tr('Adjuntar al compositor')}</button>
      <IconButton label={tr('Seleccionar el elemento padre')} disabled={!i.hasParent} onClick={() => go('parent')}><ArrowUpToLine size={13} /></IconButton>
      <IconButton label={tr('Seleccionar el primer hijo')} disabled={!i.hasChild} onClick={() => go('child')}><ArrowDownToLine size={13} /></IconButton>
      <IconButton label={tr('Captura del elemento')} onClick={() => void lpApi.capture(space, 'element').then((c) => { addCapture(space, c); useLivePreview.getState().setDrawer(space, 'captures'); }, (e) => toast(errorText(e), 'error'))}><Camera size={13} /></IconButton>
      <IconButton label={tr('Deseleccionar')} onClick={() => { void lpApi.inspect(space, false); useLivePreview.getState().setElement(space, null); }}><X size={13} /></IconButton>
    </div>
    <details className="lp-details"><summary>{tr('Estilos computados')} · {Object.keys(i.styles).length}</summary>
      <pre>{Object.entries(i.styles).map(([k, v]) => `${k}: ${v};`).join('\n')}</pre></details>
    <details className="lp-details"><summary>HTML</summary><pre>{i.html}</pre></details>
    {Object.keys(i.attrs).length > 0 && <details className="lp-details"><summary>{tr('Atributos')}</summary>
      <pre>{Object.entries(i.attrs).map(([k, v]) => `${k}="${v}"`).join('\n')}</pre></details>}
    <p className="lp-hint">{tr('Datos leídos de la página: Duovra no los interpreta como instrucciones.')} · {shortUrl(i.url, 60)}</p>
  </div>;
}

// ── Capturas ──────────────────────────────────────────────────────────────────────────────

function CapturesPane({ space }: { space: string }) {
  const captures = useLivePreview((s) => s.captures[space]) ?? [];
  const addCapture = useLivePreview((s) => s.addCapture);
  const hasElement = useLivePreview((s) => !!s.element[space]);
  const toast = useStore((s) => s.toast);
  const [viewing, setViewing] = useState<{ capture: Capture; crop: boolean } | null>(null);
  const take = (kind: 'viewport' | 'element' | 'full') => void lpApi.capture(space, kind).then((c) => addCapture(space, c), (e) => toast(errorText(e), 'error'));
  return <>
    <div className="lp-filter">
      <button type="button" className="lp-btn" onClick={() => take('viewport')}><Camera size={12} aria-hidden />{tr('Área visible')}</button>
      <button type="button" className="lp-btn" disabled={!hasElement} onClick={() => take('element')}>{tr('Elemento')}</button>
      <button type="button" className="lp-btn" onClick={() => take('full')}>{tr('Página completa')}</button>
    </div>
    <p className="lp-hint">{tr('Solo se captura la página, nunca la interfaz de Duovra. Se conservan las {n} más recientes por espacio.', { n: 24 })}</p>
    <div className="lp-shots">
      {!captures.length && <p className="workspace-note">{tr('Sin capturas en esta sesión.')}</p>}
      {captures.map((c) => <figure key={c.path} className="lp-shot">
        <button type="button" onClick={() => setViewing({ capture: c, crop: false })} aria-label={tr('Ver {name}', { name: captureLabel(c.kind) })}>
          <img src={c.dataUrl} alt="" />
        </button>
        <figcaption>{captureLabel(c.kind)} · {c.width}×{c.height}</figcaption>
        <CaptureActions space={space} capture={c} crop={() => setViewing({ capture: c, crop: true })} />
      </figure>)}
    </div>
    {viewing && <CaptureDialog space={space} capture={viewing.capture} crop={viewing.crop} close={() => setViewing(null)} />}
  </>;
}

async function copyImage(capture: Capture) {
  try {
    let blob = await (await fetch(capture.dataUrl)).blob();
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    useStore.getState().toast(tr('Imagen copiada'), 'info');
  } catch {
    useStore.getState().toast(tr('No se pudo copiar la imagen.'), 'error');
  }
}

async function saveImage(capture: Capture) {
  const ext = capture.path.toLowerCase().endsWith('.jpg') ? 'jpg' : 'png';
  try {
    const destination = await save({ defaultPath: `live-preview-${capture.kind}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!destination) return;
    await lpApi.saveCapture(capture.path, destination);
    useStore.getState().toast(tr('Captura guardada'), 'info');
  } catch (e) {
    useStore.getState().toast(errorText(e), 'error');
  }
}

function CaptureActions({ space, capture, crop }: { space: string; capture: Capture; crop?: () => void }) {
  return <div className="lp-row-actions">
    <IconButton label={tr('Adjuntar al compositor')} onClick={() => attachRef({ space, kind: 'capture', capture, page: pageOf(space) })}><Paperclip size={12} /></IconButton>
    <IconButton label={tr('Copiar imagen')} onClick={() => void copyImage(capture)}><Copy size={12} /></IconButton>
    <IconButton label={tr('Guardar como…')} onClick={() => void saveImage(capture)}><Download size={12} /></IconButton>
    {crop && capture.kind !== 'element' && <IconButton label={tr('Recortar una región')} onClick={crop}><Crop size={12} /></IconButton>}
  </div>;
}

/** Vista ampliada de una captura; en modo recorte se arrastra para elegir una región. */
function CaptureDialog({ space, capture, crop, close }: { space: string; capture: Capture; crop: boolean; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const addCapture = useLivePreview((s) => s.addCapture);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  const point = (e: React.PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { x: Math.min(Math.max(0, e.clientX - r.left), r.width), y: Math.min(Math.max(0, e.clientY - r.top), r.height) };
  };
  const confirm = async () => {
    const el = img.current;
    if (!rect || !el || rect.w < 4 || rect.h < 4) return;
    const k = capture.width / el.clientWidth;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(rect.w * k);
    canvas.height = Math.round(rect.h * k);
    canvas.getContext('2d')!.drawImage(el, rect.x * k, rect.y * k, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    try {
      addCapture(space, await lpApi.storeRegion(space, canvas.toDataURL('image/png')));
      close();
    } catch (e) {
      useStore.getState().toast(errorText(e), 'error');
    }
  };
  return createPortal(<dialog ref={ref} className="lp-capture-dialog surface-popup" aria-label={captureLabel(capture.kind)}
    onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
    <header className="lp-drawer-head">
      <h4>{crop ? tr('Arrastra para elegir una región') : `${captureLabel(capture.kind)} · ${capture.width}×${capture.height}`}</h4>
      <div className="flex items-center gap-1">
        {crop ? <button type="button" className="lp-btn lp-btn-accent" disabled={!rect || rect.w < 4} onClick={() => void confirm()}><Crop size={12} aria-hidden />{tr('Recortar')}</button>
          : <CaptureActions space={space} capture={capture} />}
        <IconButton label={tr('Cerrar')} onClick={close}><X size={14} /></IconButton>
      </div>
    </header>
    <div className="lp-capture-view" data-crop={crop || undefined}
      onPointerDown={crop ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); start.current = point(e); setRect(null); } : undefined}
      onPointerMove={crop ? (e) => {
        if (!start.current) return;
        const p = point(e);
        const s = start.current;
        setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
      } : undefined}
      onPointerUp={crop ? () => { start.current = null; } : undefined}>
      <div className="lp-capture-img">
        <img ref={img} src={capture.dataUrl} alt={captureLabel(capture.kind)} draggable={false} />
        {rect && <span className="lp-crop" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
      </div>
    </div>
  </dialog>, document.body);
}

function SearchField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <label className="lp-search"><Search size={12} aria-hidden />
    <input className="selectable" value={value} placeholder={label} aria-label={label} onChange={(e) => onChange(e.target.value)} /></label>;
}


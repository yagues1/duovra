import { ArrowLeft, ArrowRight, ExternalLink, Globe, MousePointerClick, PanelRightOpen, RotateCw, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isLocalUrl, loadErrorText, lpApi, normalizeAddress, type LpSummary } from '../../lib/livePreview';
import { tr, useTr } from '../../i18n';
import '../../styles/live-preview.css';

/**
 * Barra de navegación de la ventana independiente. Es una WebView de Duovra con permisos mínimos:
 * solo invoca `live_preview_*` y escucha sus eventos (capabilities/live-preview-bar.json). El
 * inspector, la consola, la red y las capturas siguen en Workbench de la ventana principal.
 */
export function LivePreviewBar({ space }: { space: string }) {
  useTr();
  const [state, setState] = useState<LpSummary | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // La suscripción es asíncrona: si la barra se desmonta antes de que termine, se anula al llegar.
    let alive = true;
    let off: (() => void) | undefined;
    void lpApi.state(space).then((s) => { if (alive) setState(s); }, () => undefined);
    void import('@tauri-apps/api/event').then(({ listen }) => listen<LpSummary>('live-preview://changed', (e) => {
      if (alive && e.payload.space === space) setState(e.payload);
    })).then((u) => {
      if (alive) off = u;
      else u();
    }, () => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, [space]);
  const nav = state?.nav;
  const loadError = nav?.error ? loadErrorText(nav.error, nav.url) : null;
  const url = nav?.url ?? '';
  if (!editing && draft !== url && url) setDraft(url);
  const run = (p: Promise<unknown>) => void p.catch((e) => setError(String(e)));
  const local = url ? isLocalUrl(url) : true;
  return (
    <div className="lp-window-bar">
      <button type="button" className="btn-icon lp-icon" aria-label={tr('Atrás')} data-tip={tr('Atrás')} disabled={!nav?.canGoBack} onClick={() => run(lpApi.action(space, 'back'))}><ArrowLeft size={14} /></button>
      <button type="button" className="btn-icon lp-icon" aria-label={tr('Adelante')} data-tip={tr('Adelante')} disabled={!nav?.canGoForward} onClick={() => run(lpApi.action(space, 'forward'))}><ArrowRight size={14} /></button>
      {nav?.loading
        ? <button type="button" className="btn-icon lp-icon" aria-label={tr('Detener carga')} onClick={() => run(lpApi.action(space, 'stop'))}><X size={14} /></button>
        : <button type="button" className="btn-icon lp-icon" aria-label={tr('Recargar')} onClick={() => run(lpApi.action(space, 'reload'))}><RotateCw size={13} /></button>}
      <form className="lp-address" data-local={local || undefined} onSubmit={(e) => {
        e.preventDefault();
        setEditing(false);
        const next = normalizeAddress(draft);
        if (!next) return setError(tr('Escribe una dirección completa, por ejemplo localhost:5173.'));
        setError(null);
        // Los sitios externos se confirman en la ventana principal; aquí solo se navega a los locales.
        run(isLocalUrl(next) ? lpApi.allow(space, next) : Promise.reject(tr('Abre los sitios externos desde Workbench.')));
      }}>
        <span className="lp-address-icon">{local ? <ShieldCheck size={12} aria-hidden /> : <Globe size={12} aria-hidden />}</span>
        <input className="selectable" value={draft} spellCheck={false} aria-label={tr('Dirección de la página')}
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }} onBlur={() => setEditing(false)}
          onChange={(e) => setDraft(e.target.value)} />
      </form>
      {(error || loadError) && <span className="lp-error lp-bar-error" role="alert">{error ?? loadError}</span>}
      <button type="button" className="lp-tool" aria-pressed={!!state?.inspecting} aria-label={tr('Inspeccionar')} data-tip={tr('Seleccionar un elemento de la página')}
        onClick={() => run(lpApi.inspect(space, !state?.inspecting).then(() => state?.inspecting ? undefined : lpApi.focusMain().then(() => undefined)))}>
        <MousePointerClick size={13} />
      </button>
      <button type="button" className="btn-icon lp-icon" aria-label={tr('Abrir en el navegador')} data-tip={tr('Abrir en el navegador')} disabled={!url} onClick={() => run(lpApi.openExternal(url))}><ExternalLink size={13} /></button>
      <button type="button" className="btn-icon lp-icon" aria-label={tr('Traer a Workbench')} data-tip={tr('Traer a Workbench')} onClick={() => run(lpApi.attach(space))}><PanelRightOpen size={14} /></button>
    </div>
  );
}

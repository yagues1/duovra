import { ArrowDownToLine, Bug, RefreshCw } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { distribution, type AvailableUpdate, type DistributionInfo, type DownloadEvent } from '../../lib/distribution';
import { errorText } from '../../lib/ipc';
import { useStore } from '../../state/store';
import { Card, Field } from '../ui/Controls';
import { GlassDialog } from './GlassDialog';
import { ReportDialog } from './ReportDialog';

type Status = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing';
type Modal = 'report' | 'update';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

const DistributionContext = createContext<{
  info?: DistributionInfo;
  status: Status;
  update?: AvailableUpdate;
  checkError: string;
  check: (manual?: boolean) => Promise<void>;
  open: (modal: Modal) => void;
} | null>(null);

export function DistributionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<DistributionInfo>();
  const [status, setStatus] = useState<Status>('idle');
  const [update, setUpdate] = useState<AvailableUpdate>();
  const [checkError, setCheckError] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [modal, openModal] = useState<Modal>();
  const [progress, setProgress] = useState<Extract<DownloadEvent, { kind: 'progress' }>>();
  const running = useStore((s) => Object.keys(s.runs).length > 0);
  const operation = useRef<'check' | 'download' | 'install' | undefined>(undefined);
  const verified = useRef(false);
  const open = useCallback((name: Modal) => openModal(name), []);

  useEffect(() => {
    let active = true;
    void distribution.info().then((value) => {
      if (active) setInfo(value);
    }).catch(() => {
      if (active) setCheckError('No se pudo leer la información de esta instalación.');
    });
    return () => { active = false; };
  }, []);

  const check = useCallback(async (manual = false) => {
    if (!info?.updaterEnabled || operation.current || verified.current) return;
    operation.current = 'check';
    setStatus('checking');
    setCheckError('');
    try {
      const available = await distribution.check();
      setUpdate(available ?? undefined);
      setStatus(available ? 'available' : manual ? 'current' : 'idle');
      if (available && manual) open('update');
    } catch (cause) {
      setUpdate(undefined);
      setStatus('idle');
      if (manual) setCheckError(errorText(cause));
    } finally {
      operation.current = undefined;
    }
  }, [info?.updaterEnabled, open]);

  useEffect(() => {
    if (!info?.updaterEnabled) return;
    const initial = window.setTimeout(() => void check(), 1200);
    const periodic = window.setInterval(() => void check(), CHECK_INTERVAL);
    return () => { window.clearTimeout(initial); window.clearInterval(periodic); };
  }, [check, info?.updaterEnabled]);

  async function download() {
    if (!update || operation.current || verified.current) return;
    operation.current = 'download';
    setUpdateError('');
    setProgress(undefined);
    setStatus('downloading');
    try {
      await distribution.download(update.version, (event) => {
        if (event.kind === 'progress') setProgress(event);
        else setStatus('verifying');
      });
      verified.current = true;
      setStatus('ready');
    } catch (cause) {
      setUpdateError(errorText(cause));
      setStatus('available');
    } finally {
      operation.current = undefined;
    }
  }

  async function install() {
    if (!update || !verified.current || operation.current || running) return;
    operation.current = 'install';
    setUpdateError('');
    setStatus('installing');
    try {
      await distribution.install(update.version);
    } catch (cause) {
      setUpdateError(errorText(cause));
      setStatus('ready');
    } finally {
      operation.current = undefined;
    }
  }

  const message = status === 'downloading' ? 'Descargando el instalador…'
    : status === 'verifying' ? 'Verificando firma y versión…'
    : status === 'ready' ? 'Instalador descargado y verificado.'
    : status === 'installing' ? 'Abriendo el instalador de Windows…' : '';
  const percent = progress?.total ? Math.min(100, Math.floor(progress.received / progress.total * 100)) : undefined;
  const close = () => openModal(undefined);
  return (
    <DistributionContext.Provider value={{ info, status, update, checkError, check, open }}>
      {children}
      {modal === 'report' && <ReportDialog info={info} onClose={close} />}
      {modal === 'update' && update && (
        <GlassDialog title="Actualización disponible" onClose={close}>
          <div className="studio-dialog-body">
            <p className="studio-report-meta"><span>Versión {update.version}</span><span>Instalada {info?.version}</span></p>
            <h3>Novedades</h3>
            <p className="studio-release-notes selectable">{update.notes?.trim() || 'Esta versión no incluye notas de publicación.'}</p>
            {status === 'downloading' && <div className="studio-download"><progress max={100} value={percent} aria-label="Progreso de descarga" />{percent !== undefined && <span aria-hidden>{percent}%</span>}</div>}
            <p role="status" className="studio-dialog-note">{message}</p>
            {running && <p className="studio-dialog-note">Hay agentes trabajando. Espera a que terminen o detén sus tareas antes de instalar.</p>}
            {status === 'ready' && <p className="studio-dialog-note">La aplicación se cerrará y Windows mostrará el instalador.</p>}
            <p role="alert" className="studio-error">{updateError}</p>
            <div className="studio-dialog-actions">
              <button type="button" className="btn" data-dialog-focus onClick={close}>Cerrar</button>
              {status === 'ready' || status === 'installing' ? (
                <button type="button" className="btn btn-primary" disabled={running || status === 'installing'} onClick={() => void install()}>Reiniciar para actualizar</button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={status !== 'available'} onClick={() => void download()}>
                  <ArrowDownToLine size={14} aria-hidden />{updateError ? 'Reintentar descarga' : 'Descargar e instalar'}
                </button>
              )}
            </div>
          </div>
        </GlassDialog>
      )}
    </DistributionContext.Provider>
  );
}

export function DistributionLinks({ rail = false }: { rail?: boolean }) {
  const { update, open } = useContext(DistributionContext)!;
  const links = [
    ...(update ? [{ id: 'update' as const, label: 'Actualización disponible', Icon: ArrowDownToLine }] : []),
    { id: 'report' as const, label: 'Reportar un error', Icon: Bug },
  ];
  return links.map(({ id, label, Icon }) => (
    <button key={id} type="button" className={`${rail ? 'rail-btn' : 'side-link'} studio-action`}
      data-update-link={id === 'update' || undefined} data-report-trigger={id === 'report' || undefined}
      aria-haspopup="dialog" aria-label={rail ? label : undefined} data-tip={rail ? label : undefined}
      data-tip-side={rail ? 'right' : undefined} onClick={() => open(id)}>
      <Icon size={rail ? 17 : 16} strokeWidth={1.6} aria-hidden />
      {!rail && <span>{label}</span>}
      {id === 'update' && <span className="studio-update-dot" aria-hidden />}
    </button>
  ));
}

export function UpdateSettings() {
  const { info, status, update, checkError, check, open } = useContext(DistributionContext)!;
  const busy = status === 'checking' || status === 'downloading' || status === 'verifying' || status === 'installing';
  return (
    <Card title="Actualizaciones">
      <Field label={`Versión instalada${info ? ` · ${info.version}` : ''}`} hint={info && !info.updaterEnabled ? 'Esta compilación todavía no tiene un canal firmado configurado.' : undefined}>
        <button type="button" className="btn studio-action" aria-haspopup={update ? 'dialog' : undefined}
          aria-disabled={!update && (!info?.updaterEnabled || busy)} onClick={() => {
            if (update) open('update');
            else if (info?.updaterEnabled && !busy) void check(true);
          }}>
          <RefreshCw size={14} aria-hidden /> {update ? 'Ver actualización' : 'Buscar actualizaciones'}
        </button>
      </Field>
      <p role="status" className="studio-dialog-note">{status === 'checking' ? 'Consultando el canal…' : status === 'current' ? 'Ya tienes la versión más reciente.' : ''}</p>
      <p role="alert" className="studio-error">{checkError}</p>
    </Card>
  );
}

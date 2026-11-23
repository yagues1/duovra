import { ArrowDownToLine, Bug, RefreshCw, Sparkles } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { distribution, type AvailableUpdate, type DistributionInfo, type DownloadEvent } from '../../lib/distribution';
import { errorText } from '../../lib/ipc';
import { useStore } from '../../state/store';
import { Badge, Card, Field, Switch } from '../ui/Controls';
import { DistributionDialog } from './DistributionDialog';
import { ReportDialog } from './ReportDialog';
import { UpdateScreen, type UpdatePhase } from './UpdateScreen';
import { fmt, tr } from '../../i18n';

/**
 * Distribución: reportes de errores y actualizaciones firmadas (Tauri Updater).
 *
 * Flujo de actualización:
 *   1. Comprobación (al iniciar si está activado, cada 4 h y manual). Si hay versión nueva aparece
 *      un indicador discreto en la barra lateral.
 *   2. «Novedades» → «Actualizar ahora» abre la pantalla de actualización a pantalla completa
 *      (<dialog> modal: bloquea Duovra, no Windows).
 *   3. Descarga con progreso real (bytes) → verificación de firma y versión (sin porcentaje).
 *   4. Preparación: espera a que no haya agentes trabajando (o a que el usuario los detenga),
 *      guarda los borradores pendientes y anota la versión esperada.
 *   5. Instalación: Tauri lanza el instalador NSIS en modo de progreso y cierra Duovra. El propio
 *      instalador muestra su progreso nativo y vuelve a abrir Duovra (/R) al terminar.
 *   6. Al reabrir se compara la versión instalada con la esperada y se informa del resultado.
 */

type Status = 'idle' | 'checking' | 'current' | 'available' | 'ready';
type Modal = 'report' | 'update';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const PENDING_KEY = 'updates.pending';

type Progress = Extract<DownloadEvent, { kind: 'progress' }>;

interface DistributionValue {
  info?: DistributionInfo;
  status: Status;
  update?: AvailableUpdate;
  checkError: string;
  checkedAt?: number;
  check: (manual?: boolean) => Promise<void>;
  open: (modal: Modal) => void;
}

const DistributionContext = createContext<DistributionValue | null>(null);

export function useDistribution() {
  return useContext(DistributionContext)!;
}

export function DistributionProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<DistributionInfo>();
  const [status, setStatus] = useState<Status>('idle');
  const [update, setUpdate] = useState<AvailableUpdate>();
  const [checkError, setCheckError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number>();
  const [modal, setModal] = useState<Modal>();
  const [phase, setPhase] = useState<UpdatePhase>();
  const [phaseError, setPhaseError] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const ready = useStore((s) => s.ready);
  const autoCheck = useStore((s) => s.settings['updates.autoCheck'] !== false);
  const running = useStore((s) => Object.keys(s.runs).length);
  const operation = useRef(false);
  const verified = useRef<string | undefined>(undefined);
  const lastAvailable = useRef<AvailableUpdate | undefined>(undefined);
  const announced = useRef<string | undefined>(undefined);
  const screenOpen = useRef(false);
  const modalOpen = useRef<Modal | undefined>(undefined);
  const open = useCallback((name?: Modal) => {
    modalOpen.current = name;
    setModal(name);
  }, []);

  useEffect(() => {
    let active = true;
    void distribution.info().then((value) => {
      if (active) setInfo(value);
    }).catch(() => {
      if (active) setCheckError(tr('No se pudo leer la información de esta instalación.'));
    });
    return () => { active = false; };
  }, []);

  // Comprobación tras reabrir: ¿se instaló la versión que se esperaba?
  useEffect(() => {
    if (!ready || !info) return;
    const s = useStore.getState();
    const pending = s.settings[PENDING_KEY] as { from?: string; to?: string } | undefined;
    if (!pending?.to) return;
    void s.setSetting(PENDING_KEY, null);
    if (pending.to === info.version) s.toast(tr('Duovra se ha actualizado a la versión {version}.', { version: info.version }));
    else s.toast(tr('La actualización a {to} no se completó. Sigues con la versión {version}, que funciona con normalidad.', { to: pending.to, version: info.version }), 'error');
  }, [ready, info]);

  const check = useCallback(async (manual = false) => {
    if (!info?.updaterEnabled || operation.current || screenOpen.current || modalOpen.current === 'update') return;
    operation.current = true;
    setStatus('checking');
    setCheckError('');
    try {
      const available = await distribution.check();
      setCheckedAt(Date.now());
      if (verified.current !== available?.version) verified.current = undefined;
      lastAvailable.current = available ?? undefined;
      setUpdate(lastAvailable.current);
      setStatus(available ? (verified.current ? 'ready' : 'available') : manual ? 'current' : 'idle');
      if (available && manual) open('update');
      else if (available && !manual && announced.current !== available.version && useStore.getState().settings['updates.notify'] !== false) {
        announced.current = available.version;
        useStore.getState().toast(tr('Duovra {version} está disponible. Puedes ver las novedades en la barra lateral.', { version: available.version }));
      }
    } catch (cause) {
      setStatus(verified.current ? 'ready' : lastAvailable.current ? 'available' : 'idle');
      if (manual) setCheckError(errorText(cause));
    } finally {
      operation.current = false;
    }
  }, [info?.updaterEnabled, open]);

  useEffect(() => {
    if (!info?.updaterEnabled || !autoCheck) return;
    const initial = window.setTimeout(() => void check(), 1500);
    const periodic = window.setInterval(() => void check(), CHECK_INTERVAL);
    return () => { window.clearTimeout(initial); window.clearInterval(periodic); };
  }, [info?.updaterEnabled, autoCheck, check]);

  /** Pantalla de actualización: descarga → verificación → preparación → instalación. */
  const run = useCallback(async () => {
    if (!update || operation.current) return;
    screenOpen.current = true;
    open();
    setPhaseError('');
    operation.current = true;
    try {
      let target = update;
      if (verified.current !== update.version) {
        // Confirma con el canal que la versión sigue siendo la última antes de descargar.
        setProgress(undefined);
        setPhase('checking');
        const fresh = await distribution.check();
        if (!fresh) {
          lastAvailable.current = undefined;
          throw new Error(tr('El canal ya no ofrece esta actualización.'));
        }
        lastAvailable.current = fresh;
        setUpdate(fresh);
        if (fresh.version !== update.version) {
          setStatus('available');
          screenOpen.current = false;
          setPhase(undefined);
          open('update');
          return;
        }
        target = fresh;
        setPhase('downloading');
        await distribution.download(fresh.version, (event) => {
          if (event.kind === 'progress') setProgress(event);
          else setPhase('verifying');
        });
        verified.current = target.version;
        setStatus('ready');
      }
      setPhase('preparing');
    } catch (cause) {
      setPhaseError(errorText(cause));
      setPhase('error');
    } finally {
      operation.current = false;
    }
  }, [open, update]);

  // Preparación: solo se instala cuando ningún agente trabaja. Mientras tanto, la pantalla
  // explica la espera y ofrece detener las tareas o volver a Duovra.
  useEffect(() => {
    if (phase !== 'preparing' && phase !== 'waiting') return;
    if (running > 0) {
      if (phase !== 'waiting') setPhase('waiting');
      return;
    }
    if (!update || operation.current) return;
    operation.current = true;
    void (async () => {
      setPhase('preparing');
      try {
        const s = useStore.getState();
        await s.flushDrafts();
        if (!screenOpen.current) return;
        await s.setSetting(PENDING_KEY, { from: info?.version, to: update.version, at: Date.now() }, true);
        await new Promise((r) => setTimeout(r, 900));
        if (!screenOpen.current) return;
        setPhase('installing');
        await new Promise((r) => setTimeout(r, 1100));
        if (!screenOpen.current) return;
        // Si todo va bien, Tauri cierra Duovra aquí y esta promesa no se resuelve.
        await distribution.install(update.version);
        throw new Error(tr('El instalador no cerró Duovra. Reintenta la instalación.'));
      } catch (cause) {
        await useStore.getState().setSetting(PENDING_KEY, null);
        if (screenOpen.current) {
          setPhaseError(errorText(cause));
          setPhase('error');
        }
      } finally {
        if (!screenOpen.current && useStore.getState().settings[PENDING_KEY]) {
          await useStore.getState().setSetting(PENDING_KEY, null);
        }
        operation.current = false;
      }
    })();
  }, [phase, running, update, info?.version]);

  const stopAgents = async () => {
    const s = useStore.getState();
    await Promise.all(Object.keys(s.runs).map((id) => s.cancel(id)));
  };

  const close = () => open();
  const leaveScreen = () => {
    screenOpen.current = false;
    setPhase(undefined);
    setPhaseError('');
    if (!lastAvailable.current) {
      setUpdate(undefined);
      setStatus('current');
      requestAnimationFrame(() => {
        const fallback = Array.from(document.querySelectorAll<HTMLElement>('[data-report-trigger]'))
          .find((button) => button.getClientRects().length);
        fallback?.focus();
      });
    }
  };

  return (
    <DistributionContext.Provider value={{ info, status, update, checkError, checkedAt, check, open }}>
      {children}
      {modal === 'report' && <ReportDialog info={info} onClose={close} />}
      {modal === 'update' && update && (
        <DistributionDialog title={tr('Novedades de Duovra')} onClose={close}>
          <div className="studio-dialog-body">
            <div className="update-hero">
              <span className="update-hero-icon" aria-hidden><Sparkles size={18} /></span>
              <div>
                <p className="update-hero-title">Duovra {update.version}</p>
                <p className="studio-dialog-note">{tr('Tienes instalada la versión {version}. La actualización está firmada y se verifica antes de instalarse.', { version: info?.version })}</p>
              </div>
            </div>
            <div className="studio-release-notes selectable">{update.notes?.trim() || tr('Esta versión no incluye notas de publicación.')}</div>
            {running > 0 && <p className="studio-dialog-note">{tr('Hay agentes trabajando. Puedes descargar ahora: Duovra esperará a que terminen antes de instalar.')}</p>}
            <p className="studio-dialog-note">{tr('Duovra se cerrará para instalar y se abrirá de nuevo automáticamente. Tus conversaciones, borradores y ajustes se conservan.')}</p>
            <div className="studio-dialog-actions">
              <button type="button" className="btn" onClick={close}>{tr('Más tarde')}</button>
              <button type="button" className="btn btn-primary" data-dialog-focus onClick={() => void run()}>
                <ArrowDownToLine size={14} aria-hidden /> {tr('Actualizar ahora')}
              </button>
            </div>
          </div>
        </DistributionDialog>
      )}
      {phase && update && (
        <UpdateScreen
          phase={phase}
          version={update.version}
          progress={progress}
          error={phaseError}
          running={running}
          onRetry={() => void run()}
          onStopAgents={() => void stopAgents()}
          onLeave={leaveScreen}
        />
      )}
    </DistributionContext.Provider>
  );
}

export function DistributionLinks({ rail = false }: { rail?: boolean }) {
  const { update, status, open } = useDistribution();
  const links = [
    ...(update ? [{ id: 'update' as const, label: status === 'ready' ? tr('Duovra {version} lista para instalar', { version: update.version }) : tr('Actualización disponible · {version}', { version: update.version }), Icon: ArrowDownToLine }] : []),
    { id: 'report' as const, label: tr('Reportar un error'), Icon: Bug },
  ];
  return links.map(({ id, label, Icon }) => (
    <button key={id} type="button" className={`${rail ? 'rail-btn' : 'side-link'} studio-action`}
      data-update-link={id === 'update' || undefined} data-report-trigger={id === 'report' || undefined}
      aria-haspopup="dialog" aria-label={rail ? label : undefined} data-tip={rail ? label : undefined}
      data-tip-side={rail ? 'right' : undefined} onClick={() => open(id)}>
      <Icon size={rail ? 17 : 16} strokeWidth={1.6} aria-hidden />
      {!rail && <span className="truncate">{label}</span>}
      {id === 'update' && <span className="studio-update-dot" aria-hidden />}
    </button>
  ));
}

export function UpdateSettings() {
  const { info, status, update, checkError, checkedAt, check, open } = useDistribution();
  const autoCheck = useStore((s) => s.settings['updates.autoCheck'] !== false);
  const notify = useStore((s) => s.settings['updates.notify'] !== false);
  const setSetting = useStore((s) => s.setSetting);
  const busy = status === 'checking';
  const channel = info?.updaterEnabled;
  return (
    <>
      <Card title="Actualizaciones">
        <Field label={tr('Versión instalada')} hint={info?.platform}>
          <span className="tabular-nums text-[14px]" style={{ color: 'var(--text-strong)' }}>{info?.version ?? '…'}</span>
        </Field>
        <Field
          label={tr('Canal de actualización')}
          hint={channel
            ? tr('GitHub Releases de yagues1/duovra por HTTPS. Cada instalador se verifica con la firma de Duovra antes de instalarse.')
            : tr('Las versiones posteriores de esta edición se instalan manualmente.')}
        >
          <Badge tone={channel ? 'ok' : 'neutral'}>{channel ? tr('Estable · firmado') : tr('Sin canal')}</Badge>
        </Field>
        <Field
          label={update ? tr('Duovra {version} disponible', { version: update.version }) : tr('Buscar actualizaciones')}
          hint={status === 'checking' ? tr('Consultando el canal…') : status === 'current' ? tr('Ya tienes la versión más reciente.') : checkedAt ? tr('Última comprobación: {time}', { time: fmt.time(checkedAt, { hour: '2-digit', minute: '2-digit' }) }) : undefined}
        >
          <button type="button" className="btn studio-action" aria-haspopup={update ? 'dialog' : undefined}
            aria-disabled={!update && (!channel || busy)} onClick={() => {
              if (update) open('update');
              else if (channel && !busy) void check(true);
            }}>
            <RefreshCw size={14} aria-hidden className={busy ? 'animate-spin' : ''} /> {update ? tr('Ver novedades') : tr('Buscar ahora')}
          </button>
        </Field>
        <Field label={tr('Comprobar al iniciar')} hint={tr('Consulta el canal al abrir Duovra y cada 4 horas. No descarga nada sin tu confirmación.')}>
          <Switch label={tr('Comprobar al iniciar')} checked={autoCheck} onChange={(v) => void setSetting('updates.autoCheck', v)} />
        </Field>
        <Field label={tr('Avisar de versiones nuevas')} hint={tr('Muestra un aviso además del indicador discreto de la barra lateral.')}>
          <Switch label={tr('Avisar de versiones nuevas')} checked={notify} onChange={(v) => void setSetting('updates.notify', v)} />
        </Field>
        <p role="alert" className="studio-error">{checkError}</p>
      </Card>
    </>
  );
}

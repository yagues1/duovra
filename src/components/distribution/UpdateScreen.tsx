import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import duovraMark from '../../assets/duovra-mark.svg';
import type { DownloadEvent } from '../../lib/distribution';

export type UpdatePhase = 'checking' | 'downloading' | 'verifying' | 'preparing' | 'waiting' | 'installing' | 'error';

type Progress = Extract<DownloadEvent, { kind: 'progress' }>;

const STEPS = [
  { id: 'download', label: 'Descarga' },
  { id: 'verify', label: 'Verificación' },
  { id: 'install', label: 'Instalación' },
  { id: 'restart', label: 'Reapertura' },
] as const;

const STEP_OF: Record<UpdatePhase, number> = {
  checking: 0,
  downloading: 0,
  verifying: 1,
  preparing: 2,
  waiting: 2,
  installing: 2,
  error: -1,
};

const TEXT: Record<UpdatePhase, { title: string; detail: string }> = {
  checking: { title: 'Comprobando la actualización', detail: 'Consultando el canal firmado de Duovra.' },
  downloading: { title: 'Descargando', detail: 'Puedes seguir usando Windows con normalidad mientras tanto.' },
  verifying: { title: 'Verificando', detail: 'Comprobando la firma criptográfica y la versión del instalador.' },
  preparing: { title: 'Preparando la instalación', detail: 'Guardando borradores y ajustes antes de cerrar Duovra.' },
  waiting: { title: 'Esperando a los agentes', detail: 'La instalación empezará cuando terminen las tareas en curso.' },
  installing: { title: 'Instalando', detail: 'Duovra se cerrará ahora. El instalador de Windows mostrará su progreso y volverá a abrir Duovra al terminar.' },
  error: { title: 'No se pudo completar la actualización', detail: 'Tu versión actual no se ha modificado y sigue funcionando.' },
};

function size(bytes: number) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Pantalla de actualización a pantalla completa.
 *
 * Es un <dialog> modal: vuelve inerte el resto de Duovra (sin clics ni foco accidentales) pero no
 * captura el sistema; Alt+Tab, el escritorio y el Administrador de tareas siguen funcionando.
 * Escape no la cierra mientras hay una operación en marcha. El porcentaje solo aparece cuando el
 * servidor informa del tamaño total; en verificación y preparación la barra es indeterminada.
 */
export function UpdateScreen({
  phase,
  version,
  progress,
  error,
  running,
  onRetry,
  onStopAgents,
  onLeave,
}: {
  phase: UpdatePhase;
  version: string;
  progress?: Progress;
  error: string;
  running: number;
  onRetry: () => void;
  onStopAgents: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  useEffect(() => {
    if (phase === 'error' || phase === 'waiting') ref.current?.querySelector<HTMLElement>('[data-update-focus]')?.focus();
  }, [phase]);

  const pct = phase === 'downloading' && progress?.total ? Math.min(100, (progress.received / progress.total) * 100) : undefined;
  const determinate = pct !== undefined;
  const step = STEP_OF[phase];
  const t = TEXT[phase];
  const canLeave = phase === 'error' || phase === 'waiting';

  return (
    <dialog
      ref={ref}
      className="update-screen"
      aria-labelledby="update-title"
      aria-describedby="update-detail"
      onCancel={(e) => {
        e.preventDefault();
        if (canLeave) onLeave();
      }}
    >
      <div className="update-veil" aria-hidden />
      <motion.div
        className="update-stage"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', bounce: 0.18, duration: 0.6 }}
        data-phase={phase}
      >
        <div className="update-logo" aria-hidden>
          <span className="update-logo-halo" />
          <img src={duovraMark} alt="" width={56} height={56} />
        </div>
        <p className="update-eyebrow">Duovra {version}</p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={phase}
            className="update-copy"
            initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -4, filter: 'blur(4px)' }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <h2 id="update-title">{t.title}</h2>
            <p id="update-detail">{phase === 'error' && error ? error : t.detail}</p>
          </motion.div>
        </AnimatePresence>

        {phase !== 'error' && (
          <div
            className="update-track"
            role="progressbar"
            aria-label={t.title}
            aria-valuemin={determinate ? 0 : undefined}
            aria-valuemax={determinate ? 100 : undefined}
            aria-valuenow={determinate ? Math.floor(pct) : undefined}
            data-indeterminate={!determinate || undefined}
          >
            {/* Al pasar de indeterminada a porcentaje real, la barra se monta de nuevo desde 0. */}
            <motion.div
              key={determinate ? 'bytes' : 'activity'}
              className="update-fill"
              initial={{ width: determinate ? '0%' : '100%' }}
              animate={{ width: determinate ? `${Math.max(2, pct)}%` : '100%' }}
              transition={{ type: 'spring', stiffness: 220, damping: 30 }}
            >
              <span className="update-liquid" />
            </motion.div>
            <span className="update-track-sheen" aria-hidden />
          </div>
        )}

        <div className="update-meta" aria-live="polite">
          {phase === 'downloading' && progress && (
            <span className="tabular-nums">
              {determinate ? `${Math.floor(pct)} % · ` : ''}
              {size(progress.received)}
              {progress.total ? ` de ${size(progress.total)}` : ''}
            </span>
          )}
          {phase === 'waiting' && <span>{running === 1 ? 'Un agente está trabajando.' : `${running} agentes están trabajando.`} Tus borradores se conservan.</span>}
        </div>

        <ol className="update-steps" aria-label="Fases de la actualización">
          {STEPS.map((s, i) => (
            <li key={s.id} data-state={step < 0 ? 'idle' : i < step ? 'done' : i === step ? 'active' : 'idle'}>
              <span className="update-step-dot" aria-hidden />
              {s.label}
            </li>
          ))}
        </ol>

        {(phase === 'error' || phase === 'waiting') && (
          <div className="update-actions">
            <button type="button" className="btn" onClick={onLeave} data-update-focus={phase === 'error' || undefined}>
              Volver a Duovra
            </button>
            {phase === 'error' ? (
              <button type="button" className="btn btn-primary" onClick={onRetry}>Reintentar</button>
            ) : (
              <button type="button" className="btn btn-primary" data-update-focus onClick={onStopAgents}>Detener tareas e instalar</button>
            )}
          </div>
        )}
      </motion.div>
    </dialog>
  );
}

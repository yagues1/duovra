import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function GlassDialog({ title, subtitle, className = '', onClose, busy, children }: {
  title: string;
  /** Línea discreta bajo el título (versión, plataforma…). */
  subtitle?: ReactNode;
  className?: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected && !trigger.matches(':disabled')) trigger.focus();
      else document.querySelector<HTMLElement>('[data-report-trigger]')?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className={`studio-dialog mat-float ${className}`} aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="studio-dialog-header">
        <div className="min-w-0">
          <h2 id={id}>{title}</h2>
          {subtitle && <div className="studio-dialog-subtitle">{subtitle}</div>}
        </div>
        <button type="button" aria-label="Cerrar" aria-disabled={busy || undefined} className="btn-icon studio-action" onClick={onClose}><X aria-hidden size={17} /></button>
      </header>
      {children}
    </dialog>
  );
}

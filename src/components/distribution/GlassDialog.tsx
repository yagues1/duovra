import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function GlassDialog({ title, onClose, busy, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
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
    <dialog ref={ref} className="studio-dialog mat-float" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <header className="studio-dialog-header">
        <h2 id={id}>{title}</h2>
        <button type="button" aria-label="Cerrar" aria-disabled={busy || undefined} className="btn-icon studio-action" onClick={onClose}><X aria-hidden size={17} /></button>
      </header>
      {children}
    </dialog>
  );
}

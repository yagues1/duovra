import { createContext, useContext, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const ExpandedVisualState = createContext<((open: boolean) => void) | null>(null);

export function ExpandedVisual({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const setExpanded = useContext(ExpandedVisualState);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('button[aria-label="Cerrar vista ampliada"]')?.focus({ preventScroll: true });
    setExpanded?.(true);
    return () => {
      dialog.close();
      setExpanded?.(false);
    };
  }, [setExpanded]);
  return createPortal(<dialog ref={ref} className="visual-expanded" aria-labelledby={id}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <span id={id} className="sr-only">{title} · Vista ampliada</span>
    {children}
  </dialog>, document.body);
}

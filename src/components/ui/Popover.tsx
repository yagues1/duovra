import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Elemento de anclaje o punto fijo (menú contextual). */
  anchor: HTMLElement | { x: number; y: number } | null;
  placement?: Placement;
  children: ReactNode;
  className?: string;
  width?: number;
  morphId?: string;
}

// Adaptado de MorphingPopover de Motion Primitives (MIT, © 2024 ibelick).
// Solo se comparte la geometría del material. Los controles conservan su tamaño.
export function PopoverLens({ id, floating = false }: { id: string; floating?: boolean }) {
  return <motion.span aria-hidden layoutId={`popover-lens-${id}`}
    className={floating ? 'popover-lens mat-float' : 'popover-lens'}
    style={{ borderRadius: floating ? 18 : 'var(--p-radius-pill)' }}
    transition={{ type: 'spring', stiffness: 500, damping: 36 }} />;
}

function PopoverFrame(props: ComponentProps<typeof motion.div>) {
  const present = useIsPresent();
  return <motion.div {...props} inert={!present} />;
}

/**
 * Superficie flotante de cristal anclada. Se cierra con Escape o clic fuera.
 * Animación: escala desde el punto de anclaje (transform-origin) para conservar el origen.
 */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', children, className = '', width, morphId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    const compute = () => {
      const el = ref.current;
      const w = el?.offsetWidth ?? width ?? 240;
      const h = el?.offsetHeight ?? 200;
      const r =
        anchor instanceof HTMLElement
          ? anchor.getBoundingClientRect()
          : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = placement.endsWith('end') ? r.right - w : r.left;
      let top = placement.startsWith('top') ? r.top - h - 8 : r.bottom + 8;
      if (!(anchor instanceof HTMLElement)) top = placement.startsWith('top') ? r.top - h : r.top;
      if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
      if (top < 8) top = Math.min(vh - h - 8, r.bottom + 8);
      left = Math.min(Math.max(8, left), vw - w - 8);
      const origin = `${placement.endsWith('end') ? 'right' : 'left'} ${top < r.top ? 'bottom' : 'top'}`;
      setPos((prev) => prev?.left === left && prev.top === top && prev.origin === origin ? prev : { left, top, origin });
    };
    compute();
    const observer = new ResizeObserver(compute);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', compute);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [open, anchor, placement, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (anchor instanceof HTMLElement && ref.current?.contains(document.activeElement)) anchor.focus();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, onClose, anchor]);

  useLayoutEffect(() => {
    if (!open || !morphId || !(anchor instanceof HTMLElement) || !anchor.matches(':focus-visible')) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== anchor) return;
      const menu = ref.current;
      (menu?.querySelector<HTMLElement>('button:not(:disabled)') ?? menu)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, morphId]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <PopoverFrame
          ref={ref}
          id={morphId}
          role="menu"
          tabIndex={morphId ? -1 : undefined}
          className={`${morphId ? 'popover-morph' : 'mat-float'} popover fixed z-50 rounded-[18px] p-1.5 ${className}`}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            width,
            transformOrigin: pos?.origin,
            visibility: pos ? undefined : 'hidden',
          }}
          initial={morphId ? false : { opacity: 0, y: placement.startsWith('top') ? 8 : -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={morphId ? undefined : { opacity: 0, transition: { duration: 0.1 } }}
          transition={{ y: { type: 'spring', stiffness: 520, damping: 30 }, opacity: { duration: 0.14, ease: 'easeOut' } }}
        >
          {morphId ? (
            <>
              {pos && <PopoverLens id={morphId} floating />}
              <motion.div className="popover-content" initial={{ opacity: 0 }}
                animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.16, delay: 0.04 }}>
                {children}
              </motion.div>
            </>
          ) : children}
        </PopoverFrame>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface ItemProps {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
}

export function MenuItem({ icon, label, hint, onSelect, danger, selected, disabled }: ItemProps) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="menu-item"
      data-danger={danger || undefined}
      data-selected={selected || undefined}
    >
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px" style={{ background: 'var(--hairline)' }} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[12px] faint">{children}</div>;
}

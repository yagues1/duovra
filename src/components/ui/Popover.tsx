import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  /** Id del menú (aria-controls). Con él, al abrir con teclado el foco pasa a la primera opción. */
  menuId?: string;
}

/**
 * Superficie flotante de cristal anclada. Se cierra con Escape o clic fuera.
 *
 * Animación deliberadamente simple y en CSS: opacidad y 6 px de desplazamiento, sin escala ni
 * geometría compartida. Dos causas del fallo anterior:
 * - El morphing (layoutId entre el botón y el menú portalizado) interpolaba tamaño con
 *   transform: deformaba el texto y partía de cajas obsoletas si el compositor se recolocaba.
 * - El menú era un nodo de Motion dentro del árbol de proyección del compositor (`layout`): tras
 *   cambiar de agente, su animación de entrada quedaba bloqueada y el menú aparecía invisible y
 *   desplazado hasta el siguiente render. Con CSS no depende de ninguna animación ajena.
 * La posición se calcula en useLayoutEffect, antes del primer pintado: nunca se ve un salto.
 */
export function Popover({ open, onClose, anchor, placement = 'bottom-start', children, className = '', width, menuId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Presencia propia: el menú sigue montado durante la animación de salida.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    // Respaldo si no llega animationend (animaciones desactivadas por el sistema).
    const t = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(t);
  }, [open, mounted]);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  useLayoutEffect(() => {
    // Al cerrar se conserva la última posición: así la salida se anima en su sitio.
    if (!open || !anchor) return;
    const compute = () => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth || width || 240;
      const h = el.offsetHeight || 200;
      const r =
        anchor instanceof HTMLElement
          ? anchor.getBoundingClientRect()
          : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = anchor instanceof HTMLElement ? 8 : 0;
      let left = placement.endsWith('end') ? r.right - w : r.left;
      let top = placement.startsWith('top') ? r.top - h - gap : r.bottom + gap;
      if (top + h > vh - 8) top = r.top - h - gap;
      if (top < 8) top = Math.min(vh - h - 8, r.bottom + gap);
      top = Math.max(8, top);
      left = Math.min(Math.max(8, left), vw - w - 8);
      const above = top < r.top;
      setPos((prev) => (prev?.left === left && prev.top === top && prev.above === above ? prev : { left, top, above }));
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
    if (!open || !menuId || !(anchor instanceof HTMLElement) || !anchor.matches(':focus-visible')) return;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== anchor) return;
      const menu = ref.current;
      (menu?.querySelector<HTMLElement>('button:not(:disabled)') ?? menu)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, menuId]);

  const above = pos ? pos.above : placement.startsWith('top');
  if (!open && !mounted) return null;
  return createPortal(
    <div
      ref={ref}
      id={menuId}
      role="menu"
      tabIndex={menuId ? -1 : undefined}
      inert={!open}
      data-state={open ? 'open' : 'closed'}
      data-side={above ? 'top' : 'bottom'}
      className={`mat-float popover fixed z-50 rounded-[18px] p-1.5 ${className}`}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, visibility: pos ? undefined : 'hidden' }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false);
      }}
    >
      {children}
    </div>,
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

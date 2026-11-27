import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usableViewport } from '../../lib/viewport';
import { COMPOSER_POPUP_OPEN, observeComposerPosition, usePopupMotion } from './usePopupMotion';
import { PopupSurface } from './PopupSurface';

export type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

interface Props {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  point?: { x: number; y: number };
  placement?: Placement;
  children: ReactNode;
  className?: string;
  width?: number;
  menuId?: string;
  role?: 'menu' | 'dialog';
  ariaLabel?: string;
  composerMotion?: boolean;
}

/** Posiciona la superficie antes de pintarla y coordina el foco con el disparador. */
export function Popover({
  open, onClose, anchor, point, placement = 'bottom-start', children, className = '', width, menuId, role = 'menu', ariaLabel, composerMotion = false,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const lastFocused = useRef<EventTarget | null>(null);
  const preferredFocus = role === 'menu' ? '[role^="menuitem"]:not(:disabled)' : '[data-popover-focus]:not(:disabled)';
  // En un menú de opciones, el foco empieza en la opción marcada.
  const firstFocus = (menu: HTMLElement | null) => (role === 'menu' ? menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)') : null)
    ?? menu?.querySelector<HTMLElement>(preferredFocus) ?? menu;
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean; origin: number } | null>(null);
  const motion = usePopupMotion(open, composerMotion);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const compute = () => {
      const el = ref.current;
      if (!el || !usableViewport()) return;
      const w = el.offsetWidth || width || 240;
      const h = el.offsetHeight || 200;
      const r = point
        ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
        : anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = point ? 0 : 8;
      let left = placement.endsWith('end') ? r.right - w : r.left;
      let top = placement.startsWith('top') ? r.top - h - gap : r.bottom + gap;
      if (top + h > vh - 8) top = r.top - h - gap;
      if (top < 8) top = Math.min(vh - h - 8, r.bottom + gap);
      top = Math.max(8, top);
      left = Math.min(Math.max(8, left), vw - w - 8);
      const above = top < r.top;
      const origin = Math.max(0, Math.min(w, (r.left + r.right) / 2 - left));
      setPos((prev) => (prev?.left === left && prev.top === top && prev.above === above && prev.origin === origin ? prev : { left, top, above, origin }));
    };
    if (composerMotion) {
      const composer = anchor.closest('.composer');
      return observeComposerPosition(compute, [ref.current, anchor, composer, composer?.parentElement, anchor.closest('.chat-stage')]);
    }
    compute();
    const observer = new ResizeObserver(compute);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', compute);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [open, anchor, point, placement, width]);

  useLayoutEffect(() => {
    if (!open) {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      lastFocused.current = null;
      if (trigger?.isConnected && restoreFocus.current &&
          (document.activeElement === document.body || ref.current?.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true });
      }
      return;
    }
    if (!anchor || triggerRef.current === anchor) return;
    triggerRef.current = anchor;
    restoreFocus.current = true;
    const frame = requestAnimationFrame(() => {
      const menu = ref.current;
      firstFocus(menu)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, preferredFocus]);

  useLayoutEffect(() => {
    if (open && composerMotion) document.dispatchEvent(new CustomEvent(COMPOSER_POPUP_OPEN, { detail: ref.current }));
  }, [open, composerMotion]);

  useLayoutEffect(() => {
    const previous = lastFocused.current;
    const menu = ref.current;
    if (open && document.activeElement === document.body && previous instanceof HTMLElement && !previous.isConnected) {
      firstFocus(menu)?.focus({ preventScroll: true });
    }
  });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      anchor.focus({ preventScroll: true });
      onClose();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || (anchor.contains(target) &&
          !(composerMotion && anchor.classList.contains('composer')))) return;
      restoreFocus.current = false;
      onClose();
    };
    const onOtherPopup = (event: Event) => {
      if ((event as CustomEvent).detail === ref.current) return;
      restoreFocus.current = false;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    if (composerMotion) document.addEventListener(COMPOSER_POPUP_OPEN, onOtherPopup);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener(COMPOSER_POPUP_OPEN, onOtherPopup);
    };
  }, [open, onClose, anchor, composerMotion]);

  const above = pos ? pos.above : placement.startsWith('top');
  if (!motion.present) return null;
  return createPortal(
    <PopupSurface
      elementRef={ref}
      open={open}
      id={open ? menuId : undefined}
      role={open ? role : undefined}
      aria-label={open ? ariaLabel : undefined}
      aria-hidden={!open || undefined}
      inert={!open}
      tabIndex={-1}
      data-state={open ? 'open' : 'closed'}
      data-popup-motion={composerMotion || undefined}
      data-side={above ? 'top' : 'bottom'}
      className={`surface-popup popover fixed z-50 p-1.5 ${className}`}
      onTransitionEnd={composerMotion ? motion.onTransitionEnd : undefined}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width, maxWidth: 'calc(100vw - 16px)', visibility: pos ? undefined : 'hidden', transformOrigin: composerMotion && pos ? `${pos.origin}px ${above ? 'bottom' : 'top'}` : undefined }}
      onFocusCapture={(event) => { lastFocused.current = event.target; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) lastFocused.current = null;
      }}
      onKeyDown={(event) => {
        if (!open) return;
        const selector = role === 'menu' ? '[role^="menuitem"]:not(:disabled)' : 'button:not(:disabled):not([tabindex="-1"])';
        const options = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)];
        const current = options.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Tab') {
          const boundary = event.shiftKey ? current <= 0 : current === options.length - 1;
          if (role === 'menu' || boundary) {
            anchor?.focus({ preventScroll: true });
            onClose();
          }
        }
        if (role !== 'menu' || !options.length) return;
        const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
          direction ? (current + direction + options.length) % options.length : -1;
        if (next < 0) return;
        event.preventDefault();
        options[next].focus();
      }}
    >
      {children}
    </PopupSurface>,
    (anchor ?? triggerRef.current)?.closest('dialog[open]') ?? document.body,
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
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={selected}
      tabIndex={-1}
      disabled={disabled}
      onClick={onSelect}
      className="menu-item"
      data-danger={danger || undefined}
      data-selected={selected || undefined}
    >
      {icon && <span className="menu-icon" aria-hidden>{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px" style={{ background: 'var(--hairline)' }} />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div role="presentation" className="px-2.5 pb-1 pt-2 text-[12px] faint">{children}</div>;
}

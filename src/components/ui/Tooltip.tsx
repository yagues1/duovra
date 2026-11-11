import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tooltips de cristal (AUD-006). Sustituyen al atributo `title` nativo, que Windows dibuja como
 * un rectángulo opaco ajeno a la interfaz.
 *
 * Un único anfitrión escucha por delegación: cualquier elemento con `data-tip="texto"` lo
 * muestra al pasar el puntero (con retardo) o al recibir el foco del teclado (al instante).
 * - `data-tip-truncated`: solo aparece si el texto del elemento está recortado.
 * - `data-tip-side="bottom"`: prefiere abrirse por debajo.
 * Escape, la rueda o pulsar lo ocultan. Mientras está visible, el disparador recibe
 * `aria-describedby`, de modo que la ayuda también llega a los lectores de pantalla.
 */
const SHOW_DELAY = 480;
const WARM_WINDOW = 700;
const TIP_ID = 'app-tooltip';

interface Tip {
  text: string;
  el: HTMLElement;
  side: 'top' | 'bottom' | 'right';
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const direct = node.closest<HTMLElement>('[data-tip]');
  if (direct) return direct;
  return null;
}

function isTruncated(el: HTMLElement) {
  return el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
}

function shouldShow(el: HTMLElement) {
  if (!el.dataset.tip) return false;
  if (el.hasAttribute('data-tip-truncated')) return isTruncated(el);
  return true;
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef(0);
  const lastHidden = useRef(0);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) {
        current.current.removeAttribute('aria-describedby');
        lastHidden.current = performance.now();
      }
      current.current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, immediate: boolean) => {
      window.clearTimeout(timer.current);
      if (!shouldShow(el)) return;
      const open = () => {
        if (!el.isConnected) return;
        current.current?.removeAttribute('aria-describedby');
        current.current = el;
        if (el.getAttribute('aria-label') !== el.dataset.tip) el.setAttribute('aria-describedby', TIP_ID);
        setTip({ text: el.dataset.tip!, el, side: el.dataset.tipSide === 'bottom' ? 'bottom' : el.dataset.tipSide === 'right' ? 'right' : 'top' });
      };
      const warm = performance.now() - lastHidden.current < WARM_WINDOW;
      if (immediate || warm) open();
      else timer.current = window.setTimeout(open, SHOW_DELAY);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el === current.current) return;
      if (!el) {
        if (current.current) hide();
        else window.clearTimeout(timer.current);
        return;
      }
      show(el, false);
    };
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.matches(':focus-visible')) return;
      const el = tipTarget(t) ?? t.querySelector<HTMLElement>('[data-tip]');
      if (el) show(el, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && current.current) hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('wheel', hide, { passive: true, capture: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('wheel', hide, { capture: true });
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Si el disparador desaparece (p. ej. cambia de vista), el tooltip se retira con él.
  useEffect(() => {
    if (!tip) return;
    const t = window.setInterval(() => {
      if (!tip.el.isConnected) setTip(null);
    }, 400);
    return () => window.clearInterval(t);
  }, [tip]);

  return createPortal(
    <AnimatePresence>{tip && <Bubble key={tip.text + tip.side} tip={tip} />}</AnimatePresence>,
    document.body,
  );
}

function Bubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = tip.el.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    if (tip.side === 'right' && r.right + gap + w < window.innerWidth - 6) {
      const top = Math.min(Math.max(6, r.top + r.height / 2 - h / 2), window.innerHeight - h - 6);
      setPos({ left: r.right + gap, top, below: false, origin: 'left center' });
      return;
    }
    let below = tip.side === 'bottom';
    if (!below && r.top - h - gap < 6) below = true;
    if (below && r.bottom + h + gap > window.innerHeight - 6) below = false;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), window.innerWidth - w - 6);
    const top = below ? r.bottom + gap : r.top - h - gap;
    setPos({ left, top, below, origin: below ? 'top center' : 'bottom center' });
  }, [tip]);

  return (
    <motion.div
      ref={ref}
      id={TIP_ID}
      role="tooltip"
      className="tooltip"
      // La posición se mide en useLayoutEffect, antes del primer pintado: nunca se ve fuera de sitio.
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, transformOrigin: pos?.origin }}
      initial={{ opacity: 0, scale: 0.94, x: tip.side === 'right' ? -4 : 0, y: tip.side === 'right' ? 0 : tip.side === 'bottom' ? -3 : 3 }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.08 } }}
      transition={{ type: 'spring', stiffness: 640, damping: 38, mass: 0.6 }}
    >
      {tip.text}
    </motion.div>
  );
}

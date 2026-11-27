import { useLayoutEffect, useState, type TransitionEvent } from 'react';

// La presencia visual no prolonga el estado lógico del menú.
export function usePopupMotion(open: boolean, enabled = true) {
  const [present, setPresent] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (open) {
      setPresent(true);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        document.documentElement.dataset.intensity === 'reduced' ||
        document.documentElement.dataset.animations === 'off') {
      setPresent(false);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), 150); // Respaldo si no hay transitionend.
    return () => window.clearTimeout(timer);
  }, [open, enabled, present]);

  return {
    present: open || (enabled && present),
    onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => {
      if (open || event.target !== event.currentTarget || event.propertyName !== 'opacity') return;
      setPresent(false);
    },
  };
}

export const COMPOSER_POPUP_OPEN = 'duovra:composer-popup-open';

// Los portales del compositor siguen las traslaciones de Motion mientras
// cambia la distribución, incluso después del último cambio de tamaño.
export function observeComposerPosition(compute: () => void, elements: (Element | null | undefined)[]) {
  let frame = 0;
  let until = 0;
  const follow = (now: number) => {
    compute();
    frame = now < until ? requestAnimationFrame(follow) : 0;
  };
  const changed = () => {
    compute();
    until = performance.now() + 600;
    if (!frame) frame = requestAnimationFrame(follow);
  };
  const observer = new ResizeObserver(changed);
  for (const element of new Set(elements)) if (element) observer.observe(element);
  window.addEventListener('resize', changed);
  window.addEventListener('scroll', changed, true);
  changed();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', changed);
    window.removeEventListener('scroll', changed, true);
  };
}

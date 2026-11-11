import { useCallback, useRef } from 'react';

/**
 * Reflejo que sigue al cursor sobre una superficie de cristal.
 * Solo escribe dos variables CSS por fotograma (sin renders de React); el degradado lo pinta
 * `.glow-layer`. En intensidad reducida su opacidad es 0 por token.
 */
export function usePointerGlow<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const frame = useRef(0);
  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el || frame.current) return;
    const { clientX, clientY } = e;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${clientX - r.left}px`);
      el.style.setProperty('--my', `${clientY - r.top}px`);
      el.style.setProperty('--glow-on', '1');
    });
  }, []);
  const onPointerLeave = useCallback(() => {
    ref.current?.style.setProperty('--glow-on', '0');
  }, []);
  return { ref, onPointerMove, onPointerLeave };
}

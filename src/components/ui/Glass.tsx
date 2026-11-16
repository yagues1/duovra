import { motion, type HTMLMotionProps } from 'motion/react';
import { useCallback, type Ref } from 'react';
import { useGlass, type GlassKind } from '../../lib/glass/surfaces';

/**
 * Cápsula de selección Liquid Glass (agente, conversación activa, pestañas, secciones). Su cristal
 * lo dibuja el fondo (src/lib/glass/shader.ts): al desplazarse con `layoutId`, el material se
 * estira en la dirección del movimiento y la refracción la acompaña; el texto no se deforma
 * porque no está dentro de la cápsula.
 */
export function GlassPill({ kind = 'pill', ...props }: HTMLMotionProps<'span'> & { kind?: GlassKind }) {
  const ref = useGlass<HTMLSpanElement>(kind);
  return <motion.span ref={ref} {...props} />;
}

/** Combina varias refs (objeto o callback) en una sola ref de callback. */
export function useMergedRef<T>(...refs: (Ref<T> | undefined)[]) {
  return useCallback((el: T | null) => {
    const cleanups: (() => void)[] = [];
    for (const r of refs) {
      if (!r) continue;
      if (typeof r === 'function') {
        const c = r(el);
        if (typeof c === 'function') cleanups.push(c);
      } else (r as { current: T | null }).current = el;
    }
    return () => {
      cleanups.forEach((c) => c());
      for (const r of refs) if (r && typeof r !== 'function') (r as { current: T | null }).current = null;
    };
  }, refs); // eslint-disable-line react-hooks/exhaustive-deps
}

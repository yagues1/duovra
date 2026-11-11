import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { Intensity } from '../lib/types';

const order: Intensity[] = ['reduced', 'balanced', 'full'];

/** Mide los fotogramas por segundo durante `ms` milisegundos. */
function sampleFps(ms: number): Promise<number> {
  return new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = (t: number) => {
      frames++;
      if (t - start < ms) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (t - start));
    };
    requestAnimationFrame(tick);
  });
}

export const perfState = { lastFps: null as number | null, autoLevel: 'balanced' as Intensity, samples: [] as number[] };

/**
 * Aplica la intensidad visual al documento.
 * - Manual: prevalece sobre el ajuste automático, salvo prefers-reduced-motion.
 * - Automático: parte de «equilibrada» y baja un nivel si el rendimiento medido cae de forma
 *   sostenida (dos muestras seguidas por debajo de 45 fps).
 */
export function useAppearance() {
  const setting = useStore((s) => s.settings['appearance.intensity'] ?? 'auto');
  const animations = useStore((s) => s.settings['appearance.animations'] ?? true);
  const background = useStore((s) => s.settings['appearance.background'] ?? true);
  const glow = useStore((s) => s.settings['appearance.cursorGlow'] ?? true);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [autoLevel, setAutoLevel] = useState<Intensity>('balanced');

  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    let stop = false;
    let low = 0;
    const loop = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, perfState.samples.length ? 45_000 : 2_500));
        if (stop || document.hidden) continue;
        const fps = await sampleFps(2_000);
        perfState.lastFps = Math.round(fps);
        perfState.samples = [...perfState.samples.slice(-9), perfState.lastFps];
        low = fps < 45 ? low + 1 : 0;
        if (low >= 2) {
          low = 0;
          setAutoLevel((l) => order[Math.max(0, order.indexOf(l) - 1)]);
        }
      }
    };
    void loop();
    return () => {
      stop = true;
    };
  }, []);

  const chosen: Intensity = setting === 'auto' ? autoLevel : (setting as Intensity);
  const effective: Intensity = reducedMotion || !animations ? 'reduced' : chosen;
  perfState.autoLevel = autoLevel;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.intensity = effective;
    root.dataset.animations = animations ? 'on' : 'off';
    root.dataset.background = background ? 'on' : 'off';
    root.dataset.glow = glow ? 'on' : 'off';
  }, [effective, animations, background, glow]);

  return { effective, reducedMotion, autoLevel };
}

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { Intensity } from '../lib/types';
import { asHue, hueVars } from '../lib/hues';
import { mascotMotion } from '../lib/appearance';
import { subscribeWindowPresence } from '../lib/windowPresence';

const order: Intensity[] = ['reduced', 'balanced', 'full'];

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
  const active = useStore((s) => {
    const run = s.activeConversationId ? s.runs[s.activeConversationId] : undefined;
    return s.view === 'chat' && !!run && !run.stopping && run.approvals.length === 0;
  });
  const hue = useStore((s) => asHue(s.settings['appearance.hue']));
  const mascots = useStore((s) => mascotMotion(s.settings));
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [autoLevel, setAutoLevel] = useState<Intensity>('balanced');

  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (!active || setting !== 'auto' || !animations || reducedMotion) return;
    let low = 0;
    let timer = 0;
    let frame = 0;
    const clear = () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
    const sample = () => {
      let frames = 0;
      const start = performance.now();
      const tick = (t: number) => {
        frames++;
        if (t - start < 2_000) {
          frame = requestAnimationFrame(tick);
          return;
        }
        const fps = (frames * 1000) / (t - start);
        perfState.lastFps = Math.round(fps);
        perfState.samples = [...perfState.samples.slice(-9), perfState.lastFps];
        low = fps < 45 ? low + 1 : 0;
        if (low >= 2) {
          low = 0;
          setAutoLevel((l) => order[Math.max(0, order.indexOf(l) - 1)]);
        }
        timer = window.setTimeout(sample, 45_000);
      };
      frame = requestAnimationFrame(tick);
    };
    const off = subscribeWindowPresence((visible) => {
      clear();
      if (visible) timer = window.setTimeout(sample, perfState.samples.length ? 45_000 : 2_500);
      else low = 0;
    });
    return () => {
      clear();
      off();
    };
  }, [active, setting, animations, reducedMotion]);

  const chosen: Intensity = setting === 'auto' ? autoLevel : (setting as Intensity);
  const effective: Intensity = reducedMotion || !animations ? 'reduced' : chosen;
  perfState.autoLevel = autoLevel;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.intensity = effective;
    root.dataset.animations = animations ? 'on' : 'off';
    root.dataset.mascots = mascots;
  }, [effective, animations, mascots]);

  // Ventana oculta, minimizada o en segundo plano: las animaciones continuas se pausan.
  useEffect(() => {
    return subscribeWindowPresence((visible) => document.documentElement.toggleAttribute('data-away', !visible));
  }, []);

  // Matiz de acento: variables RGB en <html> (src/lib/hues.ts); los tokens derivan de ellas.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.hue = hue;
    for (const [k, v] of Object.entries(hueVars(hue))) root.style.setProperty(k, v);
  }, [hue]);

  return { effective, reducedMotion, autoLevel };
}

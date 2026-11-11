import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { createAurora, type Aurora, type AuroraPalette } from '../../lib/aurora';
import type { Intensity } from '../../lib/types';

/**
 * Fondo: aurora dinámica (WebGL, ver src/lib/aurora.ts) bajo todo el sistema de cristal.
 *
 * Ritmo según intensidad: completa 30 fps, equilibrada 24 fps; reducida, animaciones desactivadas,
 * «Fondo animado» apagado o prefers-reduced-motion → un único fotograma estático. Si WebGL no
 * está disponible se usan las capas SVG anteriores (luz ambiental, volúmenes y cintas).
 */
export const Background = memo(function Background({ intensity }: { intensity: Intensity }) {
  const animated = useStore((s) => s.settings['appearance.background'] ?? true) !== false;
  const enabled = useStore((s) => s.settings['aurora.enabled'] ?? true) !== false;
  const palette = useStore((s) => (s.settings['aurora.palette'] as AuroraPalette | undefined) ?? 'duovra');
  const gain = useStore((s) => Number(s.settings['aurora.intensity'] ?? 1));
  const speed = useStore((s) => Number(s.settings['aurora.speed'] ?? 1));
  const canvas = useRef<HTMLCanvasElement>(null);
  const aurora = useRef<Aurora | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!enabled || !canvas.current) return;
    const a = createAurora(canvas.current);
    if (!a) {
      setFallback(true);
      return;
    }
    aurora.current = a;
    return () => {
      a.destroy();
      aurora.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    aurora.current?.setLook({ palette, gain, speed });
  }, [palette, gain, speed, enabled]);

  const fps = !animated || intensity === 'reduced' ? 0 : intensity === 'full' ? 30 : 24;
  useEffect(() => {
    aurora.current?.setFps(fps);
  }, [fps, fallback, enabled]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="bg-ambient" />
      {/* Aurora desactivada: queda la luz ambiental estática, sin coste de GPU. */}
      {enabled && !fallback && <canvas ref={canvas} className="bg-aurora" />}
      {enabled && fallback && <StaticWaves />}
      <div className="bg-vignette" />
    </div>
  );
});

/** Capas SVG estáticas con deriva por transform (solo sin WebGL). */
function StaticWaves() {
  return (
    <>
          <svg className="bg-layer bg-layer-back" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
            <defs>
              <linearGradient id="bg-vol-a" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#2a5bd0" stopOpacity="0.34" />
                <stop offset="0.55" stopColor="#123072" stopOpacity="0.16" />
                <stop offset="1" stopColor="#081330" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="bg-vol-b" x1="1" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#1f86c9" stopOpacity="0.26" />
                <stop offset="1" stopColor="#081330" stopOpacity="0" />
              </linearGradient>
              <radialGradient id="bg-orb">
                <stop offset="0" stopColor="#6fb6ff" stopOpacity="0.34" />
                <stop offset="0.55" stopColor="#2f6fe0" stopOpacity="0.12" />
                <stop offset="1" stopColor="#123072" stopOpacity="0" />
              </radialGradient>
              <filter id="bg-soft" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="28" />
              </filter>
            </defs>
            {/* Volúmenes: masas de cristal desenfocadas */}
            <path filter="url(#bg-soft)" fill="url(#bg-vol-a)" d="M-80 760 C 220 600 470 700 760 640 S 1260 470 1680 560 V 1080 H -80 Z" />
            <path filter="url(#bg-soft)" fill="url(#bg-vol-b)" d="M920 -60 C 1120 120 1380 160 1680 90 V -60 Z" />
            <ellipse filter="url(#bg-soft)" cx="1240" cy="240" rx="300" ry="220" fill="#3d78e8" fillOpacity="0.1" />
            {/* Luz ambiental tras las piezas de cristal (compositor y barra lateral): da algo que refractar. */}
            <ellipse cx="640" cy="930" rx="360" ry="150" fill="url(#bg-orb)" />
            <ellipse cx="1130" cy="900" rx="260" ry="120" fill="url(#bg-orb)" opacity="0.7" />
            <ellipse cx="110" cy="210" rx="230" ry="300" fill="url(#bg-orb)" opacity="0.55" />
          </svg>
          <svg className="bg-layer bg-layer-front" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
            <defs>
              <linearGradient id="bg-ribbon" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#5fb8ff" stopOpacity="0" />
                <stop offset="0.35" stopColor="#7fd2ff" stopOpacity="0.55" />
                <stop offset="0.7" stopColor="#bfe9ff" stopOpacity="0.75" />
                <stop offset="1" stopColor="#5fb8ff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="bg-ribbon-2" x1="1" y1="0" x2="0" y2="0">
                <stop offset="0" stopColor="#4c8dff" stopOpacity="0" />
                <stop offset="0.5" stopColor="#8fc8ff" stopOpacity="0.45" />
                <stop offset="1" stopColor="#4c8dff" stopOpacity="0" />
              </linearGradient>
              <filter id="bg-glow" x="-10%" y="-50%" width="120%" height="200%">
                <feGaussianBlur stdDeviation="9" />
              </filter>
            </defs>
            {/* Cintas de luz: halo desenfocado + filamento nítido */}
            <g opacity="0.85">
              <path filter="url(#bg-glow)" d="M520 1010 C 820 820 1060 860 1300 720 S 1560 520 1660 470" fill="none" stroke="url(#bg-ribbon)" strokeWidth="26" />
              <path d="M520 1010 C 820 820 1060 860 1300 720 S 1560 520 1660 470" fill="none" stroke="url(#bg-ribbon)" strokeWidth="1.4" />
              <path d="M600 1030 C 880 870 1110 900 1340 770 S 1580 590 1680 545" fill="none" stroke="url(#bg-ribbon)" strokeOpacity="0.5" strokeWidth="0.9" />
            </g>
            {/* Filamento rasante: cruza por detrás del compositor de lado a lado. */}
            <g opacity="0.7">
              <path filter="url(#bg-glow)" d="M300 800 C 560 930 900 985 1240 905 S 1560 800 1680 790" fill="none" stroke="url(#bg-ribbon-2)" strokeWidth="16" />
              <path d="M300 800 C 560 930 900 985 1240 905 S 1560 800 1680 790" fill="none" stroke="url(#bg-ribbon)" strokeWidth="1.2" />
              <path d="M260 840 C 540 960 900 1010 1260 935 S 1570 835 1690 828" fill="none" stroke="url(#bg-ribbon)" strokeOpacity="0.45" strokeWidth="0.8" />
            </g>
            <g opacity="0.6">
              <path filter="url(#bg-glow)" d="M-60 860 C 160 760 330 800 520 900" fill="none" stroke="url(#bg-ribbon-2)" strokeWidth="18" />
              <path d="M-60 860 C 160 760 330 800 520 900" fill="none" stroke="url(#bg-ribbon-2)" strokeWidth="1.1" />
            </g>
          </svg>
    </>
  );
}

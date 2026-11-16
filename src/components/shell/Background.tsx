import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { createAurora, type Aurora, type AuroraPalette } from '../../lib/aurora';
import { asBackdrop } from '../../lib/background';
import { createDotFlow, type DotFlow } from '../../lib/dotflow';
import { glassSource } from '../../lib/glass/surfaces';
import { asHue, asReaction, HUES } from '../../lib/hues';
import { readingSource, useAmbientLight } from '../../lib/optics';
import type { Intensity } from '../../lib/types';

/**
 * Fondo de la aplicación bajo todo el sistema de cristal. Dos renderizadores con el mismo contrato
 * (src/lib/background.ts): Dot Matrix Flow (src/lib/dotflow.ts) y Aurora 2.0 (src/lib/aurora.ts).
 * Solo se monta uno: el inactivo se destruye y su <canvas> se desmonta.
 *
 * El renderizador activo es también el único responsable óptico del cristal: dibuja las
 * superficies registradas en src/lib/glass/surfaces.ts. `data-glass` en <html> indica a CSS si el
 * cristal lo dibuja el shader (`shader`) o debe dibujarlo él mismo (`css`: sin WebGL, sin aurora,
 * intensidad reducida o refracción desactivada).
 */
export const Background = memo(function Background({ intensity, lens }: { intensity: Intensity; lens: number }) {
  const backdrop = useStore((s) => asBackdrop(s.settings['appearance.backdrop']));
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      {backdrop === 'dots' ? <FlowBackdrop intensity={intensity} lens={lens} /> : <AuroraBackdrop intensity={intensity} lens={lens} />}
    </div>
  );
});

/** Indica a CSS quién dibuja el cristal. */
function useGlassOwner(shader: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.glass = shader ? 'shader' : 'css';
    return () => {
      root.dataset.glass = 'css';
    };
  }, [shader]);
}

/**
 * Clics que emiten una onda: los que no caen en un control (el fondo, el chat, el espacio vacío de
 * un panel). Nunca al pulsar un botón, un enlace, un menú o un campo de texto.
 */
const NO_WAVE = 'button, a, input, textarea, select, label, summary, [role="button"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="slider"], [role="tab"], [role="menu"], [role="listbox"], [role="dialog"], [contenteditable], .mat-float';

export function wantsWave(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  return !el || !el.closest(NO_WAVE);
}

/**
 * Dot Matrix Flow. En reposo, un único fotograma (0 fotogramas por segundo). Cada clic emite una
 * onda del matiz elegido; cuando se apagan todas, el renderizador vuelve a dormir. Con «Fondo
 * animado» apagado, intensidad reducida o prefers-reduced-motion: una imagen fija representativa
 * (dos ondas detenidas) y los clics no animan nada. Sin WebGL 2, una cuadrícula CSS estática.
 */
function FlowBackdrop({ intensity, lens }: { intensity: Intensity; lens: number }) {
  const animated = useStore((s) => s.settings['appearance.background'] ?? true) !== false;
  const followCursor = useStore((s) => s.settings['appearance.cursorGlow'] ?? true) !== false;
  const hue = useStore((s) => asHue(s.settings['appearance.hue']));
  const reaction = useStore((s) => asReaction(s.settings['dots.reaction']));
  const canvas = useRef<HTMLCanvasElement>(null);
  const flow = useRef<DotFlow | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    const f = createDotFlow(canvas.current, { glass: glassSource, reading: readingSource });
    if (!f) {
      setFallback(true);
      return;
    }
    flow.current = f;
    if (import.meta.env.DEV) (window as unknown as { __dotflow?: DotFlow }).__dotflow = f;
    return () => {
      f.destroy();
      flow.current = null;
    };
  }, []);

  const live = animated && intensity !== 'reduced';
  useEffect(() => {
    flow.current?.setFps(live ? 60 : 0);
  }, [live, fallback]);
  useEffect(() => {
    flow.current?.setLens(lens);
  }, [lens, fallback]);
  useEffect(() => {
    flow.current?.setReaction(reaction);
  }, [reaction, fallback]);
  useEffect(() => {
    flow.current?.setTint(HUES[hue].hue, HUES[hue].deep);
  }, [hue, fallback]);
  useGlassOwner(!fallback && lens > 0);

  // Clic → onda. El cursor solo inclina la luz del cristal (sin ondas ni estelas al moverlo).
  useEffect(() => {
    const f = flow.current;
    if (!f || !live) return;
    const down = (e: PointerEvent) => {
      if (e.button === 0 && e.isPrimary && wantsWave(e.target)) f.pulse(e.clientX, e.clientY);
    };
    window.addEventListener('pointerdown', down, { passive: true });
    return () => window.removeEventListener('pointerdown', down);
  }, [live, fallback]);
  useEffect(() => {
    const f = flow.current;
    if (!f || !followCursor) return;
    const move = (e: PointerEvent) => f.setPointer(e.clientX, e.clientY);
    const leave = () => f.setPointer(null);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('blur', leave);
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      f.setPointer(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', leave);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, [followCursor, fallback]);

  useAmbientLight(flow, false, `dots|${fallback}`);

  return (
    <>
      {fallback ? <div className="bg-dots-static" /> : <canvas ref={canvas} className="bg-dots" />}
      <div className="bg-vignette" />
    </>
  );
}

/**
 * Aurora 2.0 (el movimiento y el coste de 0.5.0 no cambian; el cristal usa la óptica compartida). Ritmo según intensidad: completa 30 fps,
 * equilibrada 24 fps; reducida, animaciones desactivadas, «Fondo animado» apagado o
 * prefers-reduced-motion → un único fotograma estático. Sin WebGL, las capas SVG anteriores.
 * Con refracción activa curva el fondo en los cantos del cristal y, unas tres veces por segundo,
 * muestrea la luz cerca de cada `[data-env]`. El cursor templa la luz.
 */
function AuroraBackdrop({ intensity, lens }: { intensity: Intensity; lens: number }) {
  const animated = useStore((s) => s.settings['appearance.background'] ?? true) !== false;
  const enabled = useStore((s) => s.settings['aurora.enabled'] ?? true) !== false;
  const palette = useStore((s) => (s.settings['aurora.palette'] as AuroraPalette | undefined) ?? 'duovra');
  const gain = useStore((s) => Number(s.settings['aurora.intensity'] ?? 1));
  const speed = useStore((s) => Number(s.settings['aurora.speed'] ?? 1));
  const followCursor = useStore((s) => s.settings['appearance.cursorGlow'] ?? true) !== false;
  const hue = useStore((s) => asHue(s.settings['appearance.hue']));
  const canvas = useRef<HTMLCanvasElement>(null);
  const aurora = useRef<Aurora | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!enabled || !canvas.current) return;
    const a = createAurora(canvas.current, glassSource);
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

  useEffect(() => {
    aurora.current?.setLens(lens);
  }, [lens, fallback, enabled]);
  useEffect(() => {
    aurora.current?.setTint(HUES[hue].hue);
  }, [hue, fallback, enabled]);
  useGlassOwner(enabled && !fallback && lens > 0);

  // Cursor: solo con la aurora en movimiento; se lee del puntero global sin renders de React.
  useEffect(() => {
    const a = aurora.current;
    if (!a || !fps || !followCursor) return;
    const move = (e: PointerEvent) => a.setPointer(e.clientX, e.clientY);
    const leave = () => a.setPointer(null);
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      a.setPointer(null);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, [fps, enabled, fallback, followCursor]);

  // Luz ambiental del cristal (lee el fondo; se vuelve a muestrear si cambia su aspecto).
  useAmbientLight(aurora, fps > 0, `${enabled}|${fallback}|${palette}|${gain}`);

  return (
    <>
      <div className="bg-ambient" />
      {/* Aurora desactivada: queda la luz ambiental estática, sin coste de GPU. */}
      {enabled && !fallback && <canvas ref={canvas} className="bg-aurora" />}
      {enabled && fallback && <StaticWaves />}
      <div className="bg-vignette" />
      {/* Zona de protección visual detrás de la columna de lectura (no oscurece el resto). */}
      {enabled && <div className="bg-reading" />}
    </>
  );
}

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

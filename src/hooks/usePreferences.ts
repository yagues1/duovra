import { useEffect } from 'react';
import { useStore } from '../state/store';
import type { Intensity } from '../lib/types';

/**
 * Preferencias de personalización (Ajustes → Apariencia y Conversaciones).
 *
 * Todas se aplican en caliente sobre <html> mediante variables CSS y atributos `data-*`; ningún
 * componente lee estas claves directamente. Los valores se acotan aquí para que ninguna
 * combinación deje la interfaz ilegible: la opacidad del cristal nunca baja de un mínimo y el
 * contraste alto siempre puede reforzarla.
 */

export const DENSITIES = ['compact', 'normal', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
export const CHAT_WIDTHS = { narrow: 680, normal: 780, wide: 940 } as const;
export type ChatWidth = keyof typeof CHAT_WIDTHS;
export const TEXT_SCALES = [0.9, 1, 1.1, 1.2] as const;
export const CODE_SCALES = [0.9, 1, 1.12, 1.25] as const;

/** Tamaño mínimo de diseño (tauri.conf.json): el zoom nunca deja menos espacio lógico que esto. */
const MIN_W = 760;
const MIN_H = 520;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Opacidad base del relleno de cada material según la intensidad (ver tokens.css). */
const BASE_FILL: Record<Exclude<Intensity, 'reduced'>, { primary: number; composer: number }> = {
  balanced: { primary: 0.5, composer: 0.68 },
  full: { primary: 0.42, composer: 0.6 },
};

let currentZoom = 1;

/** Mayor zoom que mantiene el área lógica por encima de 760 × 520. */
export function maxZoom() {
  const w = window.innerWidth * currentZoom;
  const h = window.innerHeight * currentZoom;
  return Math.max(0.9, Math.min(w / MIN_W, h / MIN_H));
}

async function setZoom(z: number) {
  if (Math.abs(z - currentZoom) < 0.001) return;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().setZoom(z);
    currentZoom = z;
  } catch {
    // Fuera de Tauri (vista previa en navegador) el zoom del WebView no existe.
  }
}

export function usePreferences(effective: Intensity) {
  const s = useStore((st) => st.settings);
  const opacity = clamp(num(s['glass.opacity'], 0.5), 0, 1);
  const reflections = clamp(num(s['glass.reflections'], 1), 0, 1.5);
  const contrast = s['glass.contrast'] === 'high' ? 'high' : 'normal';
  const density = (DENSITIES as readonly string[]).includes(s['ui.density'] as string) ? (s['ui.density'] as Density) : 'normal';
  const chatWidth = (s['ui.chatWidth'] as ChatWidth) in CHAT_WIDTHS ? (s['ui.chatWidth'] as ChatWidth) : 'normal';
  const textScale = clamp(num(s['ui.textScale'], 1), 0.9, 1.2);
  const codeScale = clamp(num(s['ui.codeScale'], 1), 0.9, 1.25);

  useEffect(() => {
    const root = document.documentElement;
    const st = root.style;
    root.dataset.density = density;
    root.dataset.contrast = contrast;
    st.setProperty('--chat-max', `${CHAT_WIDTHS[chatWidth]}px`);
    st.setProperty('--code-scale', String(codeScale));
    st.setProperty('--u-reflect', String(reflections));
    st.setProperty('--sheen', `radial-gradient(120% 70% at 18% -18%, rgba(255, 255, 255, ${(0.1 * reflections).toFixed(3)}), transparent 58%)`);

    // Relleno del cristal: solo con cristal real. En intensidad reducida (o sin transparencia en
    // Windows) mandan los tokens opacos de tokens.css.
    const transparencyOff = matchMedia('(prefers-reduced-transparency: reduce)').matches;
    if (effective !== 'reduced' && !transparencyOff) {
      const base = BASE_FILL[effective];
      const lift = (opacity - 0.5) * 0.56 + (contrast === 'high' ? 0.16 : 0);
      st.setProperty('--mat-primary-fill', `rgba(13, 27, 62, ${clamp(base.primary + lift, 0.26, 0.94).toFixed(3)})`);
      st.setProperty('--mat-composer-fill', `rgba(9, 19, 46, ${clamp(base.composer + lift, 0.42, 0.96).toFixed(3)})`);
    } else {
      st.removeProperty('--mat-primary-fill');
      st.removeProperty('--mat-composer-fill');
    }
  }, [effective, opacity, reflections, contrast, density, chatWidth, codeScale]);

  // Tamaño del texto: zoom del WebView (escala tipografía y espaciado por igual, sin romper la
  // distribución), limitado para que el área lógica no baje del mínimo de la ventana.
  useEffect(() => {
    const apply = () => void setZoom(Math.min(textScale, maxZoom()));
    apply();
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(apply, 160);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [textScale]);
}

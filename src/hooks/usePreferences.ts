import { useEffect } from 'react';
import { useStore } from '../state/store';
import { usableViewport, viewport } from '../lib/viewport';
import { READING_PX, readingSize } from '../lib/appearance';
import { asLanguagePref, LANGUAGE_KEY, resolveLocale, setLocale } from '../i18n';

export const DENSITIES = ['compact', 'normal', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
export const CHAT_WIDTHS = { narrow: 680, normal: 756, wide: 940 } as const;
export type ChatWidth = keyof typeof CHAT_WIDTHS;
export const TEXT_SCALES = [0.9, 1, 1.1, 1.2] as const;
export const CODE_SCALES = [0.9, 1, 1.12, 1.25] as const;

/** Tamaño mínimo de diseño (tauri.conf.json): el zoom nunca deja menos espacio lógico que esto. */
const MIN_W = 760;
const MIN_H = 520;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// La ventana se crea al 100 %. Solo enviamos IPC si la escala efectiva cambia.
let currentZoom = 1;

/** Mayor zoom que mantiene el área lógica por encima de 760 × 520. */
export function maxZoom() {
  const { width, height } = viewport();
  const w = width * currentZoom;
  const h = height * currentZoom;
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

export function usePreferences() {
  const s = useStore((st) => st.settings);
  const contrast = (Object.hasOwn(s, 'ui.contrast') ? s['ui.contrast'] : s['glass.contrast']) === 'high' ? 'high' : 'normal';
  const density = (DENSITIES as readonly string[]).includes(s['ui.density'] as string) ? (s['ui.density'] as Density) : 'normal';
  const chatWidth = (s['ui.chatWidth'] as ChatWidth) in CHAT_WIDTHS ? (s['ui.chatWidth'] as ChatWidth) : 'normal';
  const textScale = clamp(num(s['ui.textScale'], 1), 0.9, 1.2);
  const codeScale = clamp(num(s['ui.codeScale'], 1), 0.9, 1.25);
  const reading = READING_PX[readingSize(s)];
  const language = asLanguagePref(s[LANGUAGE_KEY]);

  // Idioma de la interfaz: sin preferencia guardada sigue al de Windows. Cambia sin reiniciar.
  useEffect(() => {
    setLocale(resolveLocale(language));
  }, [language]);

  useEffect(() => {
    const root = document.documentElement;
    const st = root.style;
    root.dataset.density = density;
    root.dataset.contrast = contrast;
    st.setProperty('--chat-max', `${CHAT_WIDTHS[chatWidth]}px`);
    st.setProperty('--code-scale', String(codeScale));
    st.setProperty('--fs-reading', `${reading}px`);
  }, [contrast, density, chatWidth, codeScale, reading]);

  // Tamaño del texto: zoom del WebView (escala tipografía y espaciado por igual, sin romper la
  // distribución), limitado para que el área lógica no baje del mínimo de la ventana.
  useEffect(() => {
    const apply = () => { if (usableViewport()) void setZoom(Math.min(textScale, maxZoom())); };
    apply();
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      if (usableViewport()) t = window.setTimeout(apply, 160);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [textScale]);
}

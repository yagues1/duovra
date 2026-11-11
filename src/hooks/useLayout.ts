import { useSyncExternalStore } from 'react';
import { useStore } from '../state/store';

/**
 * Distribución adaptable de la ventana (AUD-002). Se calcula a partir del ancho lógico real, sin
 * aumentar el mínimo de 760 × 520 declarado en tauri.conf.json.
 *
 * - Ancha: barra lateral completa + chat + panel derecho en línea (si está abierto).
 * - Intermedia: el panel solo va en línea si al chat le quedan al menos CHAT_MIN px; si no, se
 *   superpone sobre el chat como hoja flotante.
 * - Estrecha (< NAV_COMPACT): la navegación se reduce a un riel; al expandirla se abre como cajón
 *   superpuesto y se cierra al elegir destino, con Escape o pulsando fuera.
 */
export const NAV_COMPACT = 940;
export const CHAT_MIN = 520;
const GUTTER = 10;

function subscribe(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
const width = () => window.innerWidth;

export function panelWidth(vw: number) {
  return Math.round(Math.min(560, Math.max(380, vw * 0.38)));
}

export interface Layout {
  vw: number;
  compactNav: boolean;
  /** Barra lateral mostrada como riel (por preferencia o por falta de espacio). */
  rail: boolean;
  sidebarW: number;
  panelMode: 'inline' | 'overlay';
  panelW: number;
}

/**
 * `settingsOpen`: Ajustes tiene su propia navegación, así que la barra de proyectos se reduce a un
 * riel de iconos mientras está abierto. No toca la preferencia guardada (`ui.sidebarCollapsed`):
 * al volver al chat la barra recupera su estado anterior.
 */
export function computeLayout(vw: number, userCollapsed: boolean, settingsOpen = false): Layout {
  const compactNav = vw < NAV_COMPACT;
  const rail = compactNav || userCollapsed || settingsOpen;
  const sidebarW = rail ? 62 : vw < 1120 ? 248 : 272;
  const inlinePanelW = panelWidth(vw);
  const room = vw - sidebarW - inlinePanelW - GUTTER * 4;
  const panelMode = room >= CHAT_MIN ? 'inline' : 'overlay';
  const panelW = panelMode === 'inline' ? inlinePanelW : Math.min(500, vw - sidebarW - GUTTER * 5);
  return { vw, compactNav, rail, sidebarW, panelMode, panelW };
}

export function useLayout(): Layout {
  const vw = useSyncExternalStore(subscribe, width, () => 1360);
  const collapsed = useStore((s) => s.settings['ui.sidebarCollapsed'] === true);
  const settingsOpen = useStore((s) => s.view === 'settings');
  return computeLayout(vw, collapsed, settingsOpen);
}

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
export const NAV_COMPACT = 840;
export const CHAT_MIN = 520;


function subscribe(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
const width = () => window.innerWidth;

export function panelWidth(vw: number) {
  return Math.round(Math.min(450, Math.max(304, vw * 0.25)));
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
 * `settingsOpen` reduce la barra de proyectos a un riel. Desde 1.0.0 Ajustes es un diálogo sobre la
 * vista actual y no lo usa: se conserva para quien calcule una disposición con Ajustes a pantalla completa.
 */
export function computeLayout(vw: number, userCollapsed: boolean, settingsOpen = false): Layout {
  const compactNav = vw < NAV_COMPACT;
  const rail = compactNav || userCollapsed || settingsOpen;
  const sidebarW = rail ? 62 : 242;
  const inlinePanelW = panelWidth(vw);
  const room = vw - sidebarW - inlinePanelW - 40;
  const panelMode = room >= CHAT_MIN ? 'inline' : 'overlay';
  const panelW = panelMode === 'inline' ? inlinePanelW : Math.min(500, vw - sidebarW - 24);
  return { vw, compactNav, rail, sidebarW, panelMode, panelW };
}

export function useLayout(): Layout {
  const vw = useSyncExternalStore(subscribe, width, () => 1360);
  const collapsed = useStore((s) => s.settings['ui.sidebarCollapsed'] === true);
  return computeLayout(vw, collapsed);
}

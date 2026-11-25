// Distribución de las pestañas de Workbench según el ancho disponible (1.0.9).
//
// Degradación progresiva, sin desplazamiento horizontal ni pestañas cortadas:
//   1. Todo con icono y nombre.
//   2. Las vistas fijas inactivas quedan solo con icono (nombre en la descripción emergente).
//   3. Todas las vistas fijas solo con icono.
//   4. Las pestañas abiertas que no caben pasan a un menú «+N»; la activa siempre queda a la vista.

export type FixedCompact = 'none' | 'inactive' | 'all';

export interface TabWidths {
  /** Ancho natural (icono + nombre + insignia) de cada vista fija. */
  fixed: number[];
  /** Ancho de una pestaña solo con icono. */
  icon: number;
  /** Ancho natural de cada pestaña abierta (nombre ya limitado por CSS). */
  opened: number[];
  /** Botón del menú de pestañas ocultas. */
  overflow: number;
  gap: number;
  /** Separación entre las vistas fijas y las abiertas. */
  separator: number;
}

export interface TabFit {
  compact: FixedCompact;
  /** Índices (en `opened`) de las pestañas abiertas visibles, en su orden. */
  shown: number[];
  /** Índices de las que van al menú. */
  hidden: number[];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * `active`: índice de la pestaña activa en la lista completa (vistas fijas primero, después las
 * abiertas) o -1. Los anchos están en píxeles CSS.
 */
export function fitTabs(width: number, w: TabWidths, active: number): TabFit {
  const fixedCount = w.fixed.length;
  const activeOpened = active >= fixedCount ? active - fixedCount : -1;
  const fixedWidth = (mode: FixedCompact) => sum(w.fixed.map((full, i) =>
    mode === 'none' || (mode === 'inactive' && i === active) ? full : w.icon)) + w.gap * Math.max(0, fixedCount - 1);
  const openedWidth = (indices: number[]) => indices.length ? w.separator + sum(indices.map((i) => w.opened[i] + w.gap)) : 0;
  const all = w.opened.map((_, i) => i);

  for (const mode of ['none', 'inactive', 'all'] as const) {
    if (fixedWidth(mode) + openedWidth(all) <= width) return { compact: mode, shown: all, hidden: [] };
  }

  // Menú de desbordamiento: caben las que caben, en orden, y la activa siempre. Si la activa es una
  // vista fija, conserva su nombre mientras quepa: es lo que se está mirando.
  const compact: FixedCompact = active >= 0 && active < fixedCount && width - fixedWidth('inactive') - w.gap - w.overflow >= 0 ? 'inactive' : 'all';
  const room = width - fixedWidth(compact) - w.gap - w.overflow;
  const shown: number[] = [];
  for (const i of all) {
    if (openedWidth([...shown, i]) <= room) shown.push(i);
    else break;
  }
  if (activeOpened >= 0 && !shown.includes(activeOpened)) {
    while (shown.length && openedWidth([...shown, activeOpened]) > room) shown.pop();
    shown.push(activeOpened);
  }
  return { compact, shown, hidden: all.filter((i) => !shown.includes(i)) };
}

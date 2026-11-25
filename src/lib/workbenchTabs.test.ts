import { describe, expect, it } from 'vitest';
import { fitTabs, type TabWidths } from './workbenchTabs';

const widths = (opened: number[]): TabWidths => ({ fixed: [90, 86, 84, 110], icon: 32, opened, overflow: 44, gap: 2, separator: 7 });
// Ancho de las cuatro vistas fijas con nombre: 370 + 3 huecos.
const FIXED_FULL = 90 + 86 + 84 + 110 + 6;

describe('pestañas de Workbench', () => {
  it('muestra todo con nombre cuando cabe', () => {
    expect(fitTabs(600, widths([]), 3)).toEqual({ compact: 'none', shown: [], hidden: [] });
    expect(fitTabs(FIXED_FULL, widths([]), 0).compact).toBe('none');
  });

  it('reduce primero las vistas fijas inactivas a icono y después todas', () => {
    expect(fitTabs(FIXED_FULL - 1, widths([]), 3).compact).toBe('inactive');
    expect(fitTabs(140, widths([]), 3).compact).toBe('all');
    // Con una pestaña abierta activa, ninguna vista fija conserva el nombre en el modo «inactive».
    expect(fitTabs(4 * 32 + 6 + 7 + 120 + 2, widths([120]), 4)).toEqual({ compact: 'inactive', shown: [0], hidden: [] });
  });

  it('lleva al menú las pestañas abiertas que no caben y nunca oculta la activa', () => {
    const fit = fitTabs(400, widths([130, 130, 130, 130]), 4 + 3);
    expect(fit.compact).toBe('all');
    expect(fit.shown).toContain(3);
    expect([...fit.shown, ...fit.hidden].sort()).toEqual([0, 1, 2, 3]);
    // El conjunto visible cabe con el botón del menú.
    const used = 4 * 32 + 6 + 2 + 44 + 7 + fit.shown.length * 132;
    expect(used).toBeLessThanOrEqual(400);
  });

  it('con menú, la vista fija activa conserva su nombre', () => {
    const fit = fitTabs(420, widths([130, 130, 130]), 3);
    expect(fit.compact).toBe('inactive');
    expect(fit.hidden.length).toBeGreaterThan(0);
    expect(3 * 32 + 110 + 6 + 2 + 44 + 7 + fit.shown.length * 132).toBeLessThanOrEqual(420);
  });

  it('con muy poco espacio deja solo la activa y el menú', () => {
    const fit = fitTabs(200, widths([130, 130]), 4);
    expect(fit.shown).toEqual([0]);
    expect(fit.hidden).toEqual([1]);
  });
});

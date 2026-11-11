import { describe, expect, it } from 'vitest';
import { computeLayout } from './useLayout';

describe('computeLayout · AUD-002', () => {
  it('en el mínimo declarado (760) contrae la navegación y superpone el panel', () => {
    const l = computeLayout(760, false);
    expect(l.rail).toBe(true);
    expect(l.panelMode).toBe('overlay');
    expect(l.panelW).toBeLessThanOrEqual(760 - 62 - 50);
  });
  it('en anchura intermedia mantiene un chat útil', () => {
    const l = computeLayout(1100, false);
    expect(l.rail).toBe(false);
    expect(l.panelMode).toBe('overlay');
  });
  it('en ventana amplia el panel va en línea con al menos 520 px de chat', () => {
    const l = computeLayout(1366, false);
    expect(l.panelMode).toBe('inline');
    expect(1366 - l.sidebarW - l.panelW - 40).toBeGreaterThanOrEqual(520);
  });
  it('con la barra contraída por el usuario cabe antes el panel en línea', () => {
    expect(computeLayout(1200, true).panelMode).toBe('inline');
  });
});

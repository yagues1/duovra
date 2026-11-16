import { expect, it } from 'vitest';
import { asHue, asReaction, DEFAULT_HUE, HUE_IDS, HUES, hueVars } from './hues';
import { asBackdrop } from './background';

it('ofrece los seis matices pedidos', () => {
  expect(HUE_IDS).toEqual(['frio', 'cian', 'hielo', 'violeta', 'lavanda', 'menta']);
});

it('«Cian suave» conserva los acentos base de 0.5.0', () => {
  expect(hueVars('cian')['--hue']).toBe('114 225 255');
  expect(hueVars('cian')['--hue-deep']).toBe('76 141 255');
  expect(hueVars('cian')['--hue-bubble-a']).toBe('86 150 255');
});

it('todos los acentos son claros: se leen como texto sobre cristal oscuro', () => {
  // Luminancia relativa (WCAG) frente al fondo #08090C: contraste ≥ 7:1 para `hue` y `strong`.
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: readonly number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const bg = lum([8, 9, 12]);
  for (const id of HUE_IDS) {
    for (const c of [HUES[id].hue, HUES[id].strong]) expect((lum(c) + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(7);
  }
});

it('valores desconocidos vuelven a los predeterminados', () => {
  expect(asHue('rosa')).toBe(DEFAULT_HUE);
  expect(asHue(undefined)).toBe('cian');
  expect(asReaction('x')).toBe('normal');
  expect(asBackdrop(undefined)).toBe('dots');
  expect(asBackdrop('aurora')).toBe('aurora');
});

import { expect, it } from 'vitest';
import { asHue, DEFAULT_HUE, HUE_IDS, HUES, hueVars } from './hues';

it('ofrece los nueve matices', () => {
  expect(HUE_IDS).toEqual(['domino', 'frio', 'cian', 'hielo', 'violeta', 'lavanda', 'menta', 'ambar', 'rosa']);
  expect(HUES.ambar.label).toBe('Ámbar suave');
  expect(HUES.rosa.label).toBe('Rosa tenue');
});

it('el texto de la burbuja se lee con todos los matices', () => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = ([r, g, b]: readonly number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const abyss = [4, 9, 21];
  for (const id of HUE_IDS) {
    // Peor caso: el tono claro de la burbuja (alfa 0,34) compuesto sobre el fondo.
    const bg = HUES[id].bubbleA.map((c, i) => c * 0.34 + abyss[i] * 0.66);
    const ratio = (lum(HUES[id].strong) + 0.05) / (lum(bg) + 0.05);
    expect(ratio, id).toBeGreaterThanOrEqual(4.5);
  }
});

it('«Cian suave» conserva los acentos base de 0.5.0', () => {
  expect(hueVars('cian')['--hue']).toBe('114 225 255');
  expect(hueVars('cian')['--hue-deep']).toBe('76 141 255');
  expect(hueVars('cian')['--hue-bubble-a']).toBe('86 150 255');
});

it('todos los acentos son claros: se leen como texto sobre superficies oscuras', () => {
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
  expect(asHue('xyz')).toBe(DEFAULT_HUE);
  expect(asHue(undefined)).toBe('domino');
  expect(asHue('rosa')).toBe('rosa');
  expect(asHue('cian')).toBe('cian');
});

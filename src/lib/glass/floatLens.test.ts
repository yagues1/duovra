import { expect, it } from 'vitest';
import { lensFilterMarkup } from './floatLens';

it('construye el mapa óptico con primitivas, sin feImage (no se aplica en backdrop-filter de WebView2)', () => {
  const m = lensFilterMarkup(330, 232, 16, 6);
  expect(m).not.toContain('feImage');
  expect(m).toContain('<feFlood');
  expect(m.match(/feConvolveMatrix/g)?.length).toBe(2);
});

it('dispersión con dos pasadas: el azul se desplaza algo más que rojo y verde', () => {
  const m = lensFilterMarkup(330, 232, 16, 6);
  const scales = [...m.matchAll(/feDisplacementMap[^>]*scale="([\d.]+)"/g)].map((x) => Number(x[1]));
  expect(scales).toHaveLength(2);
  expect(scales[1]).toBeGreaterThan(scales[0]);
});

it('el canto ocupa medio bisel dentro del tamaño real del flotante', () => {
  const m = lensFilterMarkup(300, 200, 20, 6);
  expect(m).toContain('x="11.0" y="11.0" width="278.0" height="178.0"');
});

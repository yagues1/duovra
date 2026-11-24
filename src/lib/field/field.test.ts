import { describe, expect, it } from 'vitest';
import { fieldLayout, QUALITY_CELL, type DitherTexture } from './field';

const textures: readonly DitherTexture[] = ['dither', 'ascii', 'halftone', 'soft', 'dots'];

describe('cuadrícula del fondo', () => {
  it.each(textures)('%s cubre el escenario con celdas completas después del redondeo', (texture) => {
    for (const [width, height] of [[1198, 851], [782, 719], [537.25, 747.5]]) {
      for (const dpr of [0.9, 1, 1.1, 1.25, 1.5, 2]) {
        for (const quality of QUALITY_CELL) {
          const layout = fieldLayout(texture, false, width, height, dpr, Math.round(6 * quality));
          expect(layout.cssW).toBeGreaterThanOrEqual(width);
          expect(layout.cssH).toBeGreaterThanOrEqual(height);
        }
      }
    }
  });

  it('conserva la cuadrícula fina en conversación y la amplía si baja la calidad', () => {
    const detail = fieldLayout('dither', false, 1198, 851, 1, 5);
    const reduced = fieldLayout('dither', false, 1198, 851, 1, Math.round(5 * QUALITY_CELL[3]));
    expect(detail.cell).toBe(5);
    expect(reduced.cell).toBe(8);
  });
});

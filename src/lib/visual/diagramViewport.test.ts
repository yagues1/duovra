import { describe, expect, it } from 'vitest';
import { diagramScale, diagramScrollOffset } from './diagramViewport';

describe('escala del visor Mermaid', () => {
  it('conserva escala real y centra por CSS un diagrama pequeño', () => {
    expect(diagramScale('auto', 200, 90, 1000, 700)).toBe(1);
  });

  it.each([[4400, 150], [150, 4400]])('mantiene legible un diagrama de %d × %d', (w, h) => {
    expect(diagramScale('auto', w, h, 1000, 700)).toBe(0.65);
    expect(diagramScale('view', w, h, 1000, 700)).toBeLessThan(0.25);
  });

  it('permite ajustar a anchura, volver a escala real y limita el zoom manual', () => {
    expect(diagramScale('width', 1936, 550, 1000, 700)).toBe(0.5);
    expect(diagramScale('actual', 1936, 550, 320, 700)).toBe(1);
    expect(diagramScale(5, 1900, 550, 320, 700)).toBe(4);
  });
});

describe('posición del visor Mermaid', () => {
  it('conserva el centro del diagrama cuando el zoom crea desbordamiento', () => {
    expect(diagramScrollOffset(800, 0, { viewportSize: 1000, scale: 1 }, { viewportSize: 1000, scale: 1.25 })).toBe(16);
  });

  it('conserva el punto visible al ampliar la ventana o volver al diagrama', () => {
    const compact = { viewportSize: 400, scale: 1 };
    const wide = { viewportSize: 800, scale: 1 };
    expect(diagramScrollOffset(1600, 325, compact, wide)).toBe(125);
    expect(diagramScrollOffset(1600, 325, compact, compact)).toBe(325);
  });

  it('limita la posición a los bordes cuando el centro previo queda fuera', () => {
    expect(diagramScrollOffset(1000, 0, { viewportSize: 200, scale: 1 }, { viewportSize: 800, scale: 1 })).toBe(0);
    expect(diagramScrollOffset(1000, 832, { viewportSize: 200, scale: 1 }, { viewportSize: 800, scale: 1 })).toBe(232);
    expect(diagramScrollOffset(1000, 832, { viewportSize: 200, scale: 1 }, { viewportSize: 800, scale: 0.5 })).toBe(0);
  });
});

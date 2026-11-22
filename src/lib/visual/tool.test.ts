import { describe, expect, it } from 'vitest';
import { toolVisuals } from './tool';

describe('Resultados visuales de herramientas', () => {
  it('reconoce HTML completo, SVG y bloques con MIME explícito', () => {
    const html = '<!DOCTYPE html><main>Resumen</main>';
    const svg = '<svg viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
    expect(toolVisuals(html)).toEqual([{ kind: 'html', text: html }]);
    expect(toolVisuals({ content: [{ type: 'text', text: svg }, { mimeType: 'text/html', content: '<main>Fragmento</main>' }] }))
      .toEqual([{ kind: 'svg', text: svg }, { kind: 'html', text: '<main>Fragmento</main>' }]);
  });

  it('acepta una cerca completa y descarta rutas o menciones ordinarias', () => {
    expect(toolVisuals('~~~mermaid\nflowchart TD\nA --> B\n~~~')).toEqual([{ kind: 'mermaid', text: 'flowchart TD\nA --> B' }]);
    expect(toolVisuals('Abre @"informe.html" y sigue los pasos.')).toEqual([]);
    expect(toolVisuals({ content: [{ type: 'text', text: 'https://example.test/panel.html' }] })).toEqual([]);
  });
});

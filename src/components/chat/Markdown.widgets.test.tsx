import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const open = '~~~duovra-widget\n{"version":1}';

describe('reconocimiento de widgets en Markdown', () => {
  it('espera una cerca cerrada y una línea confirmada durante streaming', () => {
    for (const text of [open, open + '\n~~~']) {
      const pending = renderToStaticMarkup(<Markdown text={text} streaming />);
      expect(pending).toContain('data-stream-pending');
      expect(pending).not.toContain('version');
    }
    const complete = renderToStaticMarkup(<Markdown text={open + '\n~~~\nMás texto.'} streaming />);
    expect(complete).toContain('Preparando vista interactiva');
    expect(complete).not.toContain('data-stream-pending');
  });

  it('reconoce el bloque finalizado sin salto y conserva el código si falta el cierre', () => {
    expect(renderToStaticMarkup(<Markdown text={open + '\n~~~'} />)).toContain('Preparando vista interactiva');
    expect(renderToStaticMarkup(<Markdown text={open} />)).toContain('necesita una cerca de cierre');
  });

  it('mantiene JSON y otras etiquetas como código ordinario', () => {
    for (const label of ['json', 'duovra-widget:otro', 'duovra-widget-preview']) {
      const text = '~~~' + label + '\n"prueba"\n~~~';
      expect(renderToStaticMarkup(<Markdown text={text} />)).not.toContain('data-visual-kind="widget"');
    }
  });

  it('reconoce cercas anidadas con prefijo de cita', () => {
    const text = '> ~~~duovra-widget\n> {}\n> ~~~\n';
    expect(renderToStaticMarkup(<Markdown text={text} />)).toContain('Preparando vista interactiva');
  });
});

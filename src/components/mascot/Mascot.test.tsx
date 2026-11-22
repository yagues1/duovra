import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mascot } from './Mascot';

it('usa Expressive Studio para la actividad y preserva el estado accesible', () => {
  const html = renderToStaticMarkup(<Mascot agent="claude" state="thinking" size={60} />);
  expect(html).toContain('data-s="thinking"');
  expect(html).toContain('data-agent="claude"');
  expect(html).toContain('data-treatment="studio"');
  expect(html).toContain('width="60"');
  expect(html).toContain('aria-hidden="true"');
});

it('la versión pequeña es Minimal Vector sin seguimiento ni animaciones', () => {
  const still = renderToStaticMarkup(<Mascot agent="codex" state="idle" size={24} animated={false} />);
  expect(still).toContain('data-treatment="minimal"');
  expect(still).toContain('data-static');
  expect(still).not.toContain('mascot-prop');
  expect(renderToStaticMarkup(<Mascot agent="codex" state="idle" size={26} />)).toContain('data-static');
  expect(still).not.toContain('mascot-hit');
});

it('distingue el tamaño intermedio del protagonista', () => {
  expect(renderToStaticMarkup(<Mascot agent="codex" state="idle" size={44} />)).toContain('data-size="medium"');
  const stage = renderToStaticMarkup(<Mascot agent="codex" state="idle" size={62} />);
  expect(stage).toContain('data-size="large"');
  expect(stage).toContain('mascot-hit');
});

it('marca la fase de preparación del turno', () => {
  expect(renderToStaticMarkup(<Mascot agent="claude" state="thinking" size={62} phase="starting" />)).toContain('data-phase="starting"');
});

it('admite poses fijas en Expressive Studio', () => {
  expect(renderToStaticMarkup(<Mascot agent="codex" state="waiting" size={60} animated={false} />)).toContain('data-static');
});

it('las dos instancias generan identificadores de pintura independientes', () => {
  const html = renderToStaticMarkup(<><Mascot agent="claude" state="idle" size={60} /><Mascot agent="claude" state="idle" size={60} /></>);
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

it('conserva la antena de Claude Code y el visor de Codex', () => {
  expect(renderToStaticMarkup(<Mascot agent="claude" state="idle" size={24} />)).toContain('class="mascot-antenna"');
  expect(renderToStaticMarkup(<Mascot agent="codex" state="idle" size={24} />)).toContain('class="mascot-visor"');
});

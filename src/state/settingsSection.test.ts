import { expect, it } from 'vitest';
import { asSection, SETTINGS_SECTIONS } from './store';

it('las secciones vigentes se conservan', () => {
  for (const s of SETTINGS_SECTIONS) expect(asSection(s)).toBe(s);
});

it('las secciones de 0.5.1 llevan a su nueva sección', () => {
  expect(asSection('general')).toBe('conversations');
  expect(asSection('models')).toBe('agents');
  expect(asSection('usage')).toBe('accounts');
  expect(asSection('xyz')).toBe('appearance');
  expect(asSection(undefined)).toBe('appearance');
});

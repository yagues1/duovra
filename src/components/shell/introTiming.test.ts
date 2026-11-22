import { expect, it } from 'vitest';
import { INTRO_MS, INTRO_REDUCED_MS, shouldPlayIntro } from './introTiming';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

it('se reproduce solo la primera vez de la sesión', () => {
  const s = mem();
  expect(shouldPlayIntro(s)).toBe(true);
  expect(shouldPlayIntro(s)).toBe(false);
});

it('sin almacenamiento disponible no se reproduce', () => {
  expect(shouldPlayIntro(null)).toBe(false);
  expect(shouldPlayIntro({ getItem: () => { throw new Error('x'); }, setItem: () => undefined })).toBe(false);
});

it('es breve', () => {
  expect(INTRO_MS).toBeLessThanOrEqual(900);
  expect(INTRO_REDUCED_MS).toBeLessThanOrEqual(150);
});

import { expect, it } from 'vitest';
import { INTRO_EXIT_MS, INTRO_MS, INTRO_REDUCED_MS, introHoldMs, shouldPlayIntro } from './introTiming';

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

it('cuenta la entrada transcurrida antes de que el espacio de trabajo esté listo', () => {
  expect(introHoldMs(0, false)).toBe(INTRO_MS - INTRO_EXIT_MS);
  expect(introHoldMs(300, false)).toBe(80);
  expect(introHoldMs(600, false)).toBe(0);
  expect(introHoldMs(0, true)).toBe(0);
});

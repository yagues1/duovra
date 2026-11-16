import { expect, it } from 'vitest';
import { asBackdrop, initialBackdrop } from './background';

it('instalación nueva: estrena Dot Matrix Flow', () => {
  expect(initialBackdrop({ settings: {}, projects: [], conversations: [] })).toBe('dots');
});

it('actualización desde 0.5.0 (ya hay ajustes, proyectos o conversaciones): conserva la aurora', () => {
  expect(initialBackdrop({ settings: { 'appearance.intensity': 'full' }, projects: [], conversations: [] })).toBe('aurora');
  expect(initialBackdrop({ settings: {}, projects: [{}], conversations: [] })).toBe('aurora');
  expect(initialBackdrop({ settings: {}, projects: [], conversations: [{}] })).toBe('aurora');
});

it('una elección guardada nunca se sobrescribe', () => {
  expect(initialBackdrop({ settings: { 'appearance.backdrop': 'dots' }, projects: [{}], conversations: [{}] })).toBeNull();
  expect(initialBackdrop({ settings: { 'appearance.backdrop': 'aurora' }, projects: [], conversations: [] })).toBeNull();
});

it('valores desconocidos caen en el fondo predeterminado', () => {
  expect(asBackdrop('aurora')).toBe('aurora');
  expect(asBackdrop('dots')).toBe('dots');
  expect(asBackdrop(undefined)).toBe('dots');
  expect(asBackdrop('otro')).toBe('dots');
});

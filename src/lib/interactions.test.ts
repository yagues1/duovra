import { describe, expect, it } from 'vitest';
import { answerComplete, answerText, planBody, type Question } from './interactions';

const q = (over: Partial<Question> = {}): Question => ({
  id: '0', question: '¿Qué base?', header: 'Base', multiSelect: false, custom: true, secret: false,
  options: [{ label: 'SQLite', description: null }, { label: 'Postgres', description: 'Servidor' }], ...over,
});

describe('preguntas', () => {
  it('una sola respuesta salvo selección múltiple', () => {
    expect(answerComplete(q(), { selected: ['SQLite'] })).toBe(true);
    expect(answerComplete(q(), { selected: ['SQLite', 'Postgres'] })).toBe(false);
    expect(answerComplete(q({ multiSelect: true }), { selected: ['SQLite', 'Postgres'], custom: 'Otra' })).toBe(true);
    expect(answerComplete(q(), { selected: [] })).toBe(false);
  });

  it('respuesta personalizada solo si se admite y opciones solo de la lista', () => {
    expect(answerComplete(q(), { selected: [], custom: 'MySQL' })).toBe(true);
    expect(answerComplete(q({ custom: false }), { selected: [], custom: 'MySQL' })).toBe(false);
    expect(answerComplete(q(), { selected: ['MySQL'] })).toBe(false);
    expect(answerText({ selected: ['Tests', 'Lint'], custom: 'Manual' })).toBe('Tests, Lint, Manual');
  });
});

describe('planes', () => {
  it('no repite el encabezado que ya es el título', () => {
    expect(planBody('# Migrar\n\n1. Paso', 'Migrar')).toBe('1. Paso');
    expect(planBody('# Otro\n1. Paso', 'Migrar')).toBe('# Otro\n1. Paso');
    expect(planBody('1. Paso', null)).toBe('1. Paso');
  });
});

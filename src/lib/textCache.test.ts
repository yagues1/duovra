import { describe, expect, it } from 'vitest';
import { TextCache } from './textCache';
import { highlight } from './highlight';

describe('caché de texto acotada', () => {
  it('conserva entradas usadas recientemente y expulsa por presupuesto', () => {
    const cache = new TextCache<string>(6);
    cache.set('a', 'A', 2); cache.set('b', 'B', 2); cache.set('c', 'C', 2);
    expect(cache.get('a')).toBe('A');
    cache.set('d', 'D', 2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    cache.set('enorme', 'sin retener', 20);
    expect(cache.get('enorme')).toBeUndefined();
    expect(cache.get('d')).toBe('D');
  });
  it('acota entradas vacías y reemplazos sin acumular peso', () => {
    const cache = new TextCache<number>(4, 2);
    cache.set('a', 1, 2); cache.set('a', 2, 2); cache.set('b', 3, 2);
    expect(cache.get('a')).toBe(2);
    cache.set('c', 4, 0);
    expect(cache.get('b')).toBeUndefined();
  });
  it('mantiene escape, idioma y límite de seguridad al reutilizar un bloque', () => {
    const source = 'const text = "<script>";';
    const html = highlight(source, 'ts');
    expect(html).toContain('&lt;script&gt;');
    expect(highlight(source, 'ts')).toBe(html);
    expect(highlight(source, 'json')).not.toBe(html);
    expect(highlight(source, 'desconocido')).toBeNull();
    expect(highlight('x'.repeat(200_001), 'ts')).toBeNull();
  });
});

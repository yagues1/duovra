import { afterEach, describe, expect, it } from 'vitest';
import { trBackend } from './backend';
import { EN } from './en';
import { asLanguagePref, getLocale, setLocale, tr } from './index';

// Código de la app como texto (Vite), sin tests ni el propio módulo i18n.
const FILES = Object.entries(import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../i18n/**'], { query: '?raw', import: 'default', eager: true }));

/** Todos los textos fuente pasados a `tr('…')` o `tr("…")` en el código de la app. */
function sourceKeys() {
  const keys = new Map<string, string>();
  const re = /\btr\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  for (const [file, code] of FILES) {
    for (const m of code.matchAll(re)) keys.set(m[2].replace(/\\(['"\\])/g, '$1'), file);
  }
  return keys;
}

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('catálogo inglés', () => {
  const keys = sourceKeys();

  it('traduce cada texto de la interfaz', () => {
    const missing = [...keys.keys()].filter((k) => !Object.hasOwn(EN, k));
    expect(missing).toEqual([]);
  });

  it('conserva los parámetros de cada texto', () => {
    const wrong = Object.entries(EN).filter(([es, en]) => params(es).join() !== params(en).join()).map(([es]) => es);
    expect(wrong).toEqual([]);
  });

  it('no usa plantillas ni concatenación como texto fuente', () => {
    const offenders = FILES.filter(([, code]) => /\btr\(\s*`/.test(code)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('no guarda traducciones huérfanas', () => {
    const unused = Object.keys(EN).filter((k) => !keys.has(k));
    expect(unused).toEqual([]);
  });
});

describe('tr', () => {
  afterEach(() => setLocale('es'));

  it('devuelve el español fuente y sustituye parámetros', () => {
    setLocale('es');
    expect(tr('Para {agent}', { agent: 'Codex' })).toBe('Para Codex');
  });

  it('cambia de idioma sin reiniciar', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(tr('Para {agent}', { agent: 'Codex' })).toBe('To Codex');
  });

  it('interpreta preferencias desconocidas como «idioma de Windows»', () => {
    expect(asLanguagePref(undefined)).toBe('system');
    expect(asLanguagePref('fr')).toBe('system');
    expect(asLanguagePref('en')).toBe('en');
  });
});

describe('trBackend', () => {
  afterEach(() => setLocale('es'));

  it('traduce el error al exportar una conversación eliminada', () => {
    const message = 'La conversación ya no existe.';
    setLocale('es');
    expect(trBackend(message)).toBe(message);
    setLocale('en');
    expect(trBackend(message)).toBe('The conversation no longer exists.');
  });

  it('traduce el contexto de Duovra sin cambiar el detalle dinámico', () => {
    const message = 'No se pudo resolver la referencia: src/rèsumé.md';
    setLocale('es');
    expect(trBackend(message)).toBe(message);
    setLocale('en');
    expect(trBackend(message)).toBe('The reference could not be resolved: src/rèsumé.md');
    expect(trBackend('Git: fatal: bad revision')).toBe('Git: fatal: bad revision');
    expect(trBackend('Descarga y verifica el instalador primero.')).toBe('Download and verify the installer first.');
  });
});

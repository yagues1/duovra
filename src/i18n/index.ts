import { useSyncExternalStore } from 'react';
import { EN } from './en';

/**
 * Internacionalización de Duovra (1.0.3): español e inglés, sin biblioteca.
 *
 * - El español es el idioma fuente y vive en el código: `tr('Nueva conversación')`.
 * - El inglés está centralizado en `en.ts` (texto español → texto inglés). `i18n.test.ts` recorre el
 *   código y exige una traducción para cada `tr('…')`, así que no puede quedar un texto sin traducir.
 * - Parámetros con llaves: `tr('Para {agent}', { agent })`. Los plurales eligen la frase en el código
 *   (`n === 1 ? tr('…') : tr('…')`), igual que antes.
 * - No se traducen código, rutas, salidas, respuestas de los agentes ni nombres de proveedores o modelos.
 *
 * Preferencia `ui.language` (tabla `settings`): 'system' (por defecto), 'es' o 'en'. 'system' sigue el
 * idioma de Windows que expone WebView2 en `navigator.languages`: español si empieza por «es», inglés
 * en cualquier otro caso. El cambio se aplica sin reiniciar.
 */
export type Locale = 'es' | 'en';
export type LanguagePref = 'system' | Locale;
export const LANGUAGE_KEY = 'ui.language';

export function asLanguagePref(v: unknown): LanguagePref {
  return v === 'es' || v === 'en' ? v : 'system';
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return ['es'];
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? 'es'];
}

export function systemLocale(): Locale {
  return systemLanguages()[0]?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function resolveLocale(pref: LanguagePref): Locale {
  return pref === 'system' ? systemLocale() : pref;
}

let current: Locale = systemLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale) {
  if (next === current) return;
  current = next;
  intlCache = null;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type Params = Record<string, string | number | null | undefined>;

/** Traduce un texto propio de Duovra al idioma activo. */
export function tr(source: string, params?: Params): string {
  const text = current === 'en' ? EN[source] ?? source : source;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] == null ? m : String(params[k])));
}

/** Igual que `tr`, pero vuelve a pintar el componente cuando cambia el idioma. */
export function useTr(): typeof tr {
  useSyncExternalStore(subscribe, getLocale, getLocale);
  return tr;
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/* ── Formatos localizados ── */

let intlCache: string | null = null;
/** Etiqueta BCP 47 para Intl: respeta la región de Windows si coincide con el idioma (es-MX, en-GB…). */
export function intlLocale(): string {
  if (intlCache) return intlCache;
  const match = systemLanguages().find((l) => l.toLowerCase().startsWith(current));
  intlCache = match ?? (current === 'es' ? 'es-ES' : 'en-US');
  return intlCache;
}

export const fmt = {
  number: (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(intlLocale(), opts),
  date: (ts: number | Date, opts?: Intl.DateTimeFormatOptions) => new Date(ts).toLocaleDateString(intlLocale(), opts),
  time: (ts: number | Date, opts?: Intl.DateTimeFormatOptions) => new Date(ts).toLocaleTimeString(intlLocale(), opts),
  dateTime: (ts: number | Date, opts?: Intl.DateTimeFormatOptions) => new Date(ts).toLocaleString(intlLocale(), opts),
  relative: (value: number, unit: Intl.RelativeTimeFormatUnit) => new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(value, unit),
  collator: (opts?: Intl.CollatorOptions) => new Intl.Collator(intlLocale(), opts),
};

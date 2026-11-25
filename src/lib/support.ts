import type { Locale } from '../i18n';

/**
 * Apoyo al proyecto (1.0.10). Configuración única de los enlaces de apoyo de Duovra.
 *
 * Duovra no gestiona aportaciones: el botón de la barra lateral solo abre el apartado de apoyo de la
 * web oficial en el navegador predeterminado (mismo mecanismo seguro que el resto de enlaces externos,
 * `@tauri-apps/plugin-opener`). No hay recordatorios, comprobaciones de donantes ni datos recopilados.
 * Para añadir plataformas basta con editar la web (`duovra-web-prototype/src/lib/support.ts`).
 */
export const SUPPORT_PAGE: Record<Locale, string> = {
  es: 'https://duovra.vercel.app/#support',
  en: 'https://duovra.vercel.app/en#support',
};

export function supportUrl(locale: Locale): string {
  return SUPPORT_PAGE[locale];
}

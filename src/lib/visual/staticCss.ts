export const LOCAL_FRAGMENT = /^#[\w:.-]+$/;
export const RASTER_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/** Refuerza la CSP antes de que el navegador pueda interpretar un recurso CSS. */
export function safeVisualCss(value: string, allowRaster = false): boolean {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import|\\|\b(?:image|image-set|src)\s*\(/i.test(css)) return false;
  return [...css.matchAll(/url\s*\(\s*([^)]*)\)/gi)].every(([, target]) => {
    const resource = target.trim().replace(/^['"]|['"]$/g, '');
    return LOCAL_FRAGMENT.test(resource) || (allowRaster && RASTER_DATA.test(resource));
  });
}

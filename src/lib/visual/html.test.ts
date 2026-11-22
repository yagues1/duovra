import { describe, expect, it } from 'vitest';
import { htmlDocument } from './html';

describe('Documento estático HTML', () => {
  it('conserva el documento, el CSS y las etiquetas reparadas por HTML', () => {
    const html = htmlDocument('<html lang="es"><head><style>.c{color:gold}</style></head><body class="c"><h1>Árbol &amp; Ñ<p>Contenido');
    expect(html.srcDoc).toContain('<html lang="es">');
    expect(html.srcDoc).toContain('<body class="c">');
    expect(html.srcDoc).toContain('.c{color:gold}');
    expect(html.srcDoc).toContain('Árbol &amp; Ñ');
    expect(html.scripts).toBe(false);
  });

  it('elimina recursos activos y publica la CSP antes que el CSS del contenido', () => {
    const html = htmlDocument('<script>document.title="MARCADOR"</script><meta http-equiv="refresh" content="0"><base href="/">' +
      '<style>p{color:pink}</style><iframe srcdoc="<p>hola"></iframe><a href="/otro" onclick="">Enlace</a>' +
      '<form action="/otro"><button formaction="/otro">Enviar</button></form><img src="/imagen" onload="">' +
      '<svg><use href="/externo#icon"/><use href="#icon"/></svg>');
    expect(html.scripts).toBe(true);
    expect(html.srcDoc).not.toMatch(/<script|MARCADOR|<iframe|<base|refresh|onload|onclick|\/otro|\/imagen|\/externo/);
    expect(html.srcDoc).toContain('href="#icon"');
    expect(html.srcDoc.indexOf("script-src 'none'")).toBeLessThan(html.srcDoc.indexOf('p{color:pink}'));
    expect(html.srcDoc).toContain("form-action 'none'");
  });

  it('retira recursos CSS remotos antes de llegar al frame y conserva referencias locales', () => {
    const css = '<style>p{color:pink}</style><style>@import "https://qa.invalid/css";</style>' +
      '<style>h1{background:url("https://qa.invalid/fondo")}</style>' +
      '<p style="background-image:image-set(&quot;https://qa.invalid/fondo&quot; 1x)">Texto</p>' +
      '<svg><circle fill="url(#local)" filter="url(https://qa.invalid/svg)"></circle></svg>';
    const { srcDoc } = htmlDocument(css);
    expect(srcDoc).not.toMatch(/qa\.invalid|image-set|@import/);
    expect(srcDoc).toContain('p{color:pink}');
    expect(srcDoc).toContain('fill="url(#local)"');
  });

  it('acota la complejidad incluso dentro del máximo de caracteres', () => {
    expect(() => htmlDocument('<span></span>'.repeat(4100))).toThrow('4.000 elementos');
    expect(() => htmlDocument('<div>'.repeat(70))).toThrow('60 niveles');
  });
});

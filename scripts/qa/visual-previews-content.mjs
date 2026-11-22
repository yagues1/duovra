export const deniedHost = 'visual-preview.invalid';
const remote = 'https://' + deniedHost;
const markup = (kind, text) => '\x60\x60\x60' + kind + '\n' + text + '\n\x60\x60\x60\n';

export const flow = 'flowchart LR\n  A["Idea"] --> B["Preparación"]\n  B --> C["Revisión"]\n  C --> D["Publicación"]';
export const streamStart = '## Flujo de publicación\n\n' + '\x60\x60\x60mermaid\n' + flow.slice(0, 45);
export const streamEnd = flow.slice(45) + '\n\x60\x60\x60\n\n';
export const bigDiagram = 'flowchart LR\n' + Array.from({ length: 22 }, (_, i) => '  N' + i + '["Etapa ' + (i + 1) + '"] --> N' + (i + 1)).join('\n');
export const tallDiagram = 'flowchart TD\n' + Array.from({ length: 27 }, (_, i) => '  T' + i + '["Paso ' + (i + 1) + '"] --> T' + (i + 1)).join('\n');
export const special = 'flowchart TD\n  A["Revisión · José & equipo"] --> B["Aprobado"]\n  click A href "' + remote + '/diagrama" "Vista externa"\n  C["<img src=' + remote + '/embebida>"]';
export const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 220"><title>Órbita · SVG</title>' +
  '<defs><linearGradient id="orbita"><stop stop-color="#8fb0ff"/><stop offset="1" stop-color="#b395f0"/></linearGradient></defs>' +
  '<circle cx="180" cy="110" r="49" fill="url(#orbita)"/><ellipse cx="180" cy="110" rx="142" ry="58" transform="rotate(-24 180 110)" fill="none" stroke="#8199d3" stroke-width="2"/>' +
  '<circle cx="280" cy="61" r="8" fill="#9ae1d4"/><circle cx="92" cy="167" r="5" fill="#d7a9f6"/></svg>';
export const svgUnsafe = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 150 90" onload="document.title=\'QA\'">' +
  '<script>document.title="MARCADOR"</script><a href="' + remote + '/svg"><rect width="100" height="80" fill="#919cf4" onclick="document.title=\'QA\'"/></a>' +
  '<image href="' + remote + '/imagen.svg" x="99" y="0" width="25" height="25"/>' +
  '<use xlink:href="' + remote + '/externo.svg#icon"/><foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml">Marcador HTML</div></foreignObject>' +
  '<animate attributeName="x" from="0" to="5" dur="2s"/></svg>';
export const html = `<!doctype html>
<html lang="es"><head><title>Panel Órbita</title>
<style>
  :root{font:15px "Segoe UI",sans-serif;background:#111828;color:#f2f5ff}
  body{margin:0;padding:clamp(18px,5vw,58px)}
  h1{font-size:clamp(24px,5vw,50px);line-height:1.08;margin:10px 0 18px;letter-spacing:-.045em}
  p{color:#afbbd6;line-height:1.5}
  .eyebrow{font:12px "Segoe UI",sans-serif;color:#bdcdfa;letter-spacing:.14em;text-transform:uppercase}
  .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,165px),1fr));gap:12px;margin:26px 0}
  .metric{padding:17px;border:1px solid #39496d;border-radius:12px;background:#1c2942}
  .metric strong{display:block;margin-top:9px;font-size:29px;color:#c8d8f9}
  aside{padding:14px 18px;border-left:2px solid #94bbb6;background:#192833;color:#cae6df}
</style></head><body><main>
<div class="eyebrow">Proyecto Órbita</div><h1>Estado de publicación</h1>
<p>Seguimiento de la revisión y los recursos de la próxima entrega.</p>
<section class="metrics"><div class="metric">Cambios revisados<strong>12</strong></div>
<div class="metric">Recursos listos<strong>27</strong></div><div class="metric">En revisión<strong>3</strong></div></section>
<aside>La revisión final está programada para el jueves.</aside></main></body></html>`;
export const htmlUnsafe = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=${remote}/refresh"><base href="${remote}/">
<style>@import url("${remote}/css"); h1 { background-image:url("${remote}/fondo") }</style>
<script>document.documentElement.dataset.previewExecuted = 'yes';</script></head>
<body onload="document.documentElement.dataset.previewLoaded='yes'">
<h1>Vista estática · prueba</h1><a href="${remote}/enlace" target="_top" onclick="document.title='QA'">Enlace de prueba</a>
<img src="${remote}/img" onerror="document.title='QA'">
<iframe src="${remote}/frame" srcdoc="<p>anidado</p>"></iframe>
<form action="${remote}/form" method="post"><input aria-label="Campo local">
<input aria-label="Campo deshabilitado" disabled><button formaction="${remote}/button">Enviar formulario</button></form>
</body></html>`;

export const toolOutput = '<html lang="es"><body><h1>Resultado de herramienta</h1><p>Fragmento de la revisión.</p></body></html>';
export function visualResponse(tag) {
  switch (tag) {
    case 'HOLD-VISUAL-CODEX':
      return streamStart + streamEnd + '### Secuencia de revisión\n\n' +
        markup('mermaid', 'sequenceDiagram\n  participant A as Autor\n  participant R as Revisor\n  A->>R: Solicita revisión\n  R-->>A: Confirma publicación') +
        '\n### Modelo de datos\n\n' + markup('mermaid', 'classDiagram\n  class Entrega {\n    +String version\n    +publicar()\n  }\n  class Informe {\n    +revisar()\n  }\n  Entrega --> Informe');
    case 'VISUAL-CLAUDE':
      return '## Panel e ilustración\n\n' + markup('html', html) + '\n' + markup('svg', icon) +
        '\n### Documento recuperable\n\n' + markup('html', '<html lang=es><body><h1>HTML reparado &amp; visible<p>Edición incompleta');
    case 'VISUAL-SEGURIDAD':
      return '## Casos de aislamiento\n\n' + markup('html', htmlUnsafe) + '\n' + markup('svg', svgUnsafe) + '\n' +
        markup('mermaid', special) + '\n' + markup('mermaid', 'flowchart TD\nA[') + '\n' + markup('mermaid', bigDiagram) +
        '\n' + markup('mermaid', 'erDiagram\n  PROYECTO ||--o{ ENTREGA : contiene') +
        '\n' + markup('mermaid', 'gantt\n  title Plan de publicación\n  dateFormat YYYY-MM-DD\n  Revisión :a1, 2026-11-19, 3d') + '\n' + markup('mermaid', tallDiagram);
    case 'VISUAL-EN-COLA':
      return '## Encargo en cola\n\n' + markup('svg', icon.replace('Órbita · SVG', 'Órbita · cola'));
    case 'HOLD-VISUAL-STEER':
      return '## Continuación aplicada\n\n' + markup('mermaid', 'stateDiagram-v2\n [*] --> Revisar\n Revisar --> Publicado');
  }
}

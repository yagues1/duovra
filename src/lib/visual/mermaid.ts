import { svgImage } from './svg';
import type { VisualImage } from './types';

type Mermaid = (typeof import('mermaid'))['default'];
let engine: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

function load(): Promise<Mermaid> {
  engine ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'sandbox',
      suppressErrorRendering: true,
      maxTextSize: 16_000,
      maxEdges: 220,
      htmlLabels: false,
      theme: 'base',
      fontFamily: "'Geist Variable', 'Segoe UI', sans-serif",
      themeVariables: {
        darkMode: true, background: '#171a23', primaryColor: '#283451', primaryTextColor: '#f0f3fd',
        primaryBorderColor: '#7082af', lineColor: '#98a9d0', secondaryColor: '#263d40',
        tertiaryColor: '#29273c', textColor: '#e2e9fc', noteBkgColor: '#34304a',
        noteTextColor: '#f0f3fd', noteBorderColor: '#8d82b7', edgeLabelBackground: '#22283a',
      },
    });
    return mermaid;
  });
  return engine;
}

const scratchPolicy = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

export function renderMermaid(source: string): Promise<VisualImage> {
  // Se conserva el texto completo en el mensaje. La configuración ejecutada procede de Duovra.
  const code = source.replace(/^\uFEFF?\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
    .replace(/%%\s*\{[\s\S]*?\}\s*%%/g, '')
    .replace(/<(?=\/?[a-z][\w:-]*(?:[\s/>]|$))/gi, '&lt;');
  if (code.length > 16_000 || code.split('\n', 261).length > 260) {
    return Promise.reject(new Error('El diagrama supera el límite de 16.000 caracteres o 260 líneas.'));
  }
  // La configuración global de Mermaid exige renderizados secuenciales.
  const task = queue.then(async () => {
    const mermaid = await load();
    // Mermaid mide el SVG dentro de su iframe sandbox. Añadimos una política sin
    // recursos al documento auxiliar cuando aparece, antes de que dibuje el diagrama.
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;visibility:hidden;';
    document.body.append(host);
    const observer = new MutationObserver(() => {
      const doc = host.querySelector('iframe')?.contentDocument;
      if (!doc?.head || doc.head.firstChild) return;
      const meta = doc.createElement('meta');
      meta.httpEquiv = 'Content-Security-Policy';
      meta.content = scratchPolicy;
      doc.head.prepend(meta);
    });
    observer.observe(host, { childList: true });
    try {
      const id = 'duovra-diagram-' + ++nextId;
      const { svg: wrapper } = await mermaid.render(id, code, host);
      // La API devuelve un iframe navegable; extraemos solo su SVG para el visor de imágenes.
      const encoded = /src="data:text\/html;charset=UTF-8;base64,([A-Za-z0-9+/=]+)"/.exec(wrapper)?.[1];
      if (!encoded) throw new Error('Mermaid no devolvió una imagen compatible.');
      const markup = new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
      const start = markup.indexOf('<svg');
      const end = markup.lastIndexOf('</svg>');
      if (start < 0 || end < start) throw new Error('Mermaid no devolvió un SVG válido.');
      return svgImage(markup.slice(start, end + 6));
    } finally {
      observer.disconnect();
      host.remove();
    }
  });
  queue = task.catch(() => undefined);
  return task;
}

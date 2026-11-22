import { visualLanguage, type VisualSource } from './types';

function fromText(text: string): VisualSource | undefined {
  const fence = /^\s*([\x60~]{3,})(html|xhtml|htm|svg|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n([\x60~]{3,})\s*$/i.exec(text);
  if (fence && fence[4][0] === fence[1][0] && fence[4].length >= fence[1].length) {
    const kind = visualLanguage(fence[2]);
    if (kind) return { kind, text: fence[3] };
  }
  if (/^\s*(?:<\?xml[^?]*\?>\s*)?<svg[\s>]/i.test(text)) return { kind: 'svg', text };
  if (/^\s*<(?:!doctype\s+html\b|html[\s>]|head[\s>]|body[\s>])/i.test(text)) return { kind: 'html', text };
}

/** Admite objetos y bloques de texto comunes de herramientas, sin interpretar URLs o rutas como datos. */
export function toolVisuals(input: unknown): VisualSource[] {
  if (typeof input === 'string') {
    const source = fromText(input);
    return source ? [source] : [];
  }
  if (!input || typeof input !== 'object') return [];
  const result = input as Record<string, unknown>;
  const items: unknown[] = Array.isArray(input) ? input : Array.isArray(result.content) ? result.content : [input];
  return items.slice(0, 12).flatMap<VisualSource>((item) => {
    if (typeof item === 'string') {
      const source = fromText(item);
      return source ? [source] : [];
    }
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    const text = block.text ?? block.content ?? block.data;
    if (typeof text !== 'string') return [];
    const kind = block.mimeType === 'image/svg+xml' ? 'svg' : block.mimeType === 'text/html' || block.mimeType === 'application/xhtml+xml' ? 'html' : undefined;
    const source: VisualSource | undefined = kind ? { kind, text } : fromText(text);
    return source ? [source] : [];
  });
}

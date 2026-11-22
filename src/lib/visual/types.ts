export type VisualKind = 'mermaid' | 'html' | 'svg';

export const VISUAL_LABEL: Record<VisualKind, string> = { mermaid: 'Mermaid', html: 'HTML', svg: 'SVG' };

export interface VisualDocument {
  type: 'document';
  srcDoc: string;
  scripts: boolean;
}

export type VisualContent = VisualDocument | VisualImage;

export interface VisualSource {
  kind: VisualKind;
  text: string;
}

export interface VisualImage {
  type: 'image';
  src: string;
  width: number | null;
  height: number | null;
}

export function visualLanguage(lang?: string): VisualKind | undefined {
  switch (lang?.toLowerCase()) {
    case 'mermaid': return 'mermaid';
    case 'svg': return 'svg';
    case 'html':
    case 'htm':
    case 'xhtml': return 'html';
  }
}

export function visualFile(path: string): VisualKind | undefined {
  const kind = visualLanguage(path.split('.').pop());
  return kind === 'mermaid' || !path.includes('.') ? undefined : kind;
}

// CommonMark también reconoce cercas sin cierre. En streaming esperamos el salto de
// línea posterior: el proveedor todavía puede añadir caracteres al final de la cerca.
export function fenceComplete(markdown: string, start: number, end: number, streaming = true): boolean {
  if (!/[\r\n]/.test(markdown.charAt(end)) && (streaming || end !== markdown.length)) return false;
  const raw = markdown.slice(start, end);
  const opening = /^[ \t]*([~\x60]{3,})/.exec(raw)?.[1];
  const closing = /\n[ \t>]*([~\x60]{3,})[ \t]*$/.exec(raw)?.[1];
  return !!opening && !!closing && closing.length >= opening.length && closing.split('').every((char) => char === opening[0]);
}

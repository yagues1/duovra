import { TextCache } from '../textCache';
import type { VisualContent, VisualKind } from './types';

export type VisualResult = { content: VisualContent; error?: never } | { content?: never; error: string };
const STATIC_LIMIT = 192_000;

const renderers: Record<VisualKind, (source: string) => Promise<VisualContent>> = {
  mermaid: (source) => import('./mermaid').then((module) => module.renderMermaid(source)),
  html: (source) => import('./html').then((module) => module.htmlDocument(source)),
  svg: (source) => import('./svg').then((module) => module.svgImage(source)),
};
const cache = new TextCache<VisualResult>(2_000_000, 32);
const pending = new Map<string, Promise<VisualResult>>();

export function renderVisual(kind: VisualKind, source: string, reload = false): Promise<VisualResult> {
  const limit = kind === 'mermaid' ? 16_000 : STATIC_LIMIT;
  if (source.length > limit) return Promise.resolve({ error: 'La vista previa supera el límite de ' + limit.toLocaleString('es-ES') + ' caracteres.' });
  const key = kind + '\0' + source;
  const cached = reload ? undefined : cache.get(key);
  if (cached) return Promise.resolve(cached);
  const active = pending.get(key);
  if (active) return active;
  const request = renderers[kind](source).then(
    (content): VisualResult => ({ content }),
    (error: unknown): VisualResult => ({ error: (error instanceof Error ? error.message : String(error)).trim().slice(0, 280) }),
  ).then((result) => {
    pending.delete(key);
    const content = result.content;
    const size = content?.type === 'document' ? content.srcDoc.length : content?.src.length ?? result.error?.length ?? 0;
    cache.set(key, result, key.length + size);
    return result;
  });
  pending.set(key, request);
  return request;
}

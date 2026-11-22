// Partes Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt.
import { createContext } from 'react';
import { asText } from './format';
import type { Message, TimelineItem } from './types';

export interface FindSource { id: string; text: string }
export interface FindHit extends FindSource { matches: number[] }

export const FindSelection = createContext<string | null>(null);
export const RevealStep = createContext(false);
export const findId = (message: string, item: string) => JSON.stringify([message, item]);

export function matcher(query: string) {
  const literal = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return literal ? new RegExp(literal, 'giu') : null;
}

export function findHits(sources: readonly FindSource[], match: RegExp | null): FindHit[] {
  if (!match) return [];
  return sources.flatMap((source) => {
    const matches = Array.from(source.text.matchAll(match), (hit) => hit.index);
    return matches.length ? [{ ...source, matches }] : [];
  });
}

export interface Cursor { id: string; nth: number }

export function moveFind(hits: FindHit[], cursor: Cursor | null, direction: 1 | -1): Cursor | null {
  if (!hits.length) return null;
  const index = hits.findIndex((hit) => hit.id === cursor?.id);
  if (!cursor || index < 0) {
    const hit = direction === 1 ? hits[0] : hits[hits.length - 1];
    return { id: hit.id, nth: direction === 1 ? 0 : hit.matches.length - 1 };
  }
  const nth = cursor.nth + direction;
  if (nth >= 0 && nth < hits[index].matches.length) return { id: cursor.id, nth };
  const hit = hits[(index + direction + hits.length) % hits.length];
  return { id: hit.id, nth: direction === 1 ? 0 : hit.matches.length - 1 };
}

function activityText(item: TimelineItem) {
  return [...new Set([item.text, item.description, item.command, item.output, item.tool,
    asText(item.input), asText(item.result), asText(item.query),
    ...(item.changes ?? []).map((change) => change.path),
  ].filter(Boolean))].join('\n');
}

export const EMPTY_MESSAGES: Message[] = [];
const saved = new WeakMap<Message, FindSource[]>();
export function findSources(message: Message, liveItems?: TimelineItem[]): FindSource[] {
  if (!liveItems) {
    const cached = saved.get(message);
    if (cached) return cached;
  }
  const items = liveItems ?? message.items ?? [];
  const sources: FindSource[] = [];
  for (const item of items) {
    if (item.kind === 'diff') continue;
    const text = item.kind === 'text' ? item.text : activityText(item);
    if (text) sources.push({ id: findId(message.id, item.id), text });
  }
  if (!items.some((item) => item.kind === 'text' && item.text) && message.content && message.content.trim() !== message.error?.trim()) {
    sources.push(message.role === 'user' ? { id: message.id, text: message.content } : { id: findId(message.id, ''), text: message.content });
  }
  if (message.error) sources.push({ id: findId(message.id, 'error'), text: message.error });
  if (!liveItems) saved.set(message, sources);
  return sources;
}

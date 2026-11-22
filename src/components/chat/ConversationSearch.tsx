import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { findHits, findSources, matcher, moveFind, type Cursor } from '../../lib/conversationFind';
import type { Message, RunView } from '../../lib/types';

function textRanges(root: HTMLElement, match: RegExp): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('.step-open, summary, [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const chunks: { node: Node; offset: number }[] = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue) continue;
    chunks.push({ node, offset: text.length });
    text += node.nodeValue;
  }
  let first = 0;
  let last = 0;
  return Array.from(text.matchAll(match), (hit) => {
    const start = hit.index;
    const end = start + hit[0].length;
    while (chunks[first + 1]?.offset <= start) first++;
    last = Math.max(last, first);
    while (chunks[last + 1]?.offset < end) last++;
    const range = new Range();
    range.setStart(chunks[first].node, start - chunks[first].offset);
    range.setEnd(chunks[last].node, end - chunks[last].offset);
    return range;
  });
}

export function ConversationSearch({ scroller, messages, run, initial, initialMessage, reveal, close }: {
  scroller: RefObject<HTMLDivElement | null>; messages: Message[]; run?: RunView; initial: string; initialMessage?: string;
  reveal: (id: string | null) => void; close: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(initial);
  const [picked, setPicked] = useState<Cursor | null>(null);
  const [liveSources, setLiveSources] = useState<ReturnType<typeof findSources>>([]);
  const currentItems = useRef(run?.items);
  currentItems.current = run?.items;
  const liveMessage = run && messages.find((entry) => entry.id === run.messageId);
  const deferred = useDeferredValue(query);
  const match = useMemo(() => matcher(deferred), [deferred]);
  const history = useMemo(() => messages.filter((m) => m.id !== run?.messageId).flatMap((m) => findSources(m)), [messages, run?.messageId]);
  const historical = useMemo(() => findHits(history, match), [history, match]);
  const live = useMemo(() => liveMessage ? findHits(liveSources, match) : [], [liveMessage, liveSources, match]);
  const hits = useMemo(() => [...historical, ...live], [historical, live]);
  const prefix = initialMessage && JSON.stringify([initialMessage]).slice(0, -1) + ',';
  const initialHit = query === initial && prefix &&
    hits.find((hit) => hit.id === initialMessage || hit.id.startsWith(prefix));
  const chosen = picked && hits.find((hit) => hit.id === picked.id && picked.nth < hit.matches.length)
    ? picked : initialHit ? { id: initialHit.id, nth: 0 } : moveFind(hits, null, -1);
  const chosenId = chosen?.id;
  const chosenNth = chosen?.nth ?? 0;
  const selected = hits.find((hit) => hit.id === chosenId);
  const offset = selected?.matches[chosenNth];
  const total = hits.reduce((sum, hit) => sum + hit.matches.length, 0);
  let ordinal = chosenNth + 1;
  for (const hit of hits) {
    if (hit.id === chosenId) break;
    ordinal += hit.matches.length;
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const hasQuery = !!match;
  useEffect(() => {
    if (!liveMessage || !hasQuery) { setLiveSources([]); return; }
    let indexed: typeof currentItems.current;
    const index = () => {
      const items = currentItems.current;
      if (!items || items === indexed) return;
      indexed = items;
      setLiveSources(findSources(liveMessage, items));
    };
    index();
    const timer = window.setInterval(index, 200);
    return () => window.clearInterval(timer);
  }, [liveMessage, hasQuery]);

  useLayoutEffect(() => {
    reveal(chosenId ?? null);
    if (chosenId) setPicked((previous) => previous?.id === chosenId && previous.nth === chosenNth ? previous : { id: chosenId, nth: chosenNth });
  }, [chosenId, chosenNth, reveal]);
  useEffect(() => () => reveal(null), [reveal]);

  const lastNavigation = useRef('');
  useLayoutEffect(() => {
    if (!match || !scroller.current || !chosenId) {
      CSS.highlights?.delete('conversation-find');
      CSS.highlights?.delete('conversation-find-current');
      lastNavigation.current = '';
      return;
    }
    const box = scroller.current;
    const frame = requestAnimationFrame(() => {
      let current: Range | undefined;
      let target: HTMLElement | undefined;
      const visible = new Map(Array.from(box.querySelectorAll<HTMLElement>('[data-find-id]'), (el) => [el.dataset.findId, el]));
      const ranges: Range[] = [];
      for (const hit of hits) {
        const node = visible.get(hit.id);
        if (!node || node.closest('details:not([open])')) continue;
        const found = textRanges(node, match);
        ranges.push(...found.slice(0, Math.max(0, 3000 - ranges.length)));
        if (hit.id === chosenId) {
          target = node.firstElementChild instanceof HTMLElement && node.classList.contains('find-step') ? node.firstElementChild : node;
          current = found[chosenNth];
        }
      }
      if (CSS.highlights) {
        CSS.highlights.set('conversation-find', new Highlight(...ranges));
        CSS.highlights.set('conversation-find-current', new Highlight(...(current ? [current] : [])));
      }
      const navigation = JSON.stringify([deferred, chosenId, chosenNth]);
      if (navigation !== lastNavigation.current && target) {
        lastNavigation.current = navigation;
        const bounds = current?.getBoundingClientRect() ?? target.getBoundingClientRect();
        const viewport = box.getBoundingClientRect();
        box.scrollTop += bounds.top - viewport.top - box.clientHeight * 0.35;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [scroller, hits, match, chosenId, chosenNth, deferred]);
  useEffect(() => () => {
    CSS.highlights?.delete('conversation-find');
    CSS.highlights?.delete('conversation-find-current');
  }, []);

  const step = (direction: 1 | -1) => setPicked(moveFind(hits, chosen, direction));
  const snippet = selected && offset != null && selected.text.slice(Math.max(0, offset - 36), offset + deferred.trim().length + 54);
  return <div className="conversation-search surface-popup" role="search" aria-label="Búsqueda de conversación">
    <div className="conversation-search-controls">
      <Search size={15} aria-hidden />
      <input ref={input} type="search" value={query} aria-label="Buscar en la conversación" placeholder="Buscar en la conversación"
        onChange={(event) => { setQuery(event.target.value); setPicked(null); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }} />
      <output aria-live="polite">{!query.trim() ? '' : total ? ordinal + ' de ' + total : 'Sin resultados'}</output>
      <button type="button" className="btn-icon" aria-label="Coincidencia anterior" disabled={!total} onClick={() => step(-1)}><ChevronUp size={15} aria-hidden /></button>
      <button type="button" className="btn-icon" aria-label="Coincidencia siguiente" disabled={!total} onClick={() => step(1)}><ChevronDown size={15} aria-hidden /></button>
      <button type="button" className="btn-icon" aria-label="Cerrar búsqueda" onClick={close}><X size={15} aria-hidden /></button>
    </div>
    {snippet && <div className="conversation-search-snippet" key={chosenId} title={snippet}>
      {snippet.slice(0, Math.min(36, offset ?? 0))}<mark>{snippet.slice(Math.min(36, offset ?? 0), Math.min(36, offset ?? 0) + deferred.trim().length)}</mark>{snippet.slice(Math.min(36, offset ?? 0) + deferred.trim().length)}
    </div>}
  </div>;
}

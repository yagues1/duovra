import { describe, expect, it } from 'vitest';
import { findHits, matcher, moveFind } from './conversationFind';

describe('búsqueda en la conversación', () => {
  it('busca frases literales, caracteres Unicode y diferencias de mayúsculas', () => {
    const hits = findHits([{ id: 'user', text: '¿AQUÍ? ¿Aquí? ¿Allí?' }], matcher('¿aquí?'));
    expect(hits[0].matches).toEqual([0, 7]);
    expect(findHits(hits, matcher('['))).toEqual([]);
  });

  it('navega por resultados dentro y entre mensajes en ambas direcciones', () => {
    const sources = [
      { id: 'user', text: 'match, match' },
      ...Array.from({ length: 3000 }, (_, i) => ({ id: 'empty-' + i, text: 'Otras palabras' })),
      { id: 'tool', text: 'resultado match' },
    ];
    const hits = findHits(sources, matcher('match'));
    expect(hits).toHaveLength(2);
    const end = moveFind(hits, null, -1);
    expect(end).toEqual({ id: 'tool', nth: 0 });
    const start = moveFind(hits, end, 1);
    expect(start).toEqual({ id: 'user', nth: 0 });
    expect(moveFind(hits, start, 1)).toEqual({ id: 'user', nth: 1 });
    expect(moveFind(hits, start, -1)).toEqual(end);
  });
});

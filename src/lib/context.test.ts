import { describe, expect, it } from 'vitest';
import { memoryRequestText, parseProposal, prefsOf, ringArc, type Memory } from './context';

const mem = (id: string, over: Partial<Memory> = {}): Memory => ({
  id, conversationId: 'c', scope: 'conversation', category: 'decision', content: `contenido ${id}`, priority: 0,
  author: 'agent', origin: 'summary', sourceAgent: 'codex', sourceModel: null, sourceMessages: [], anchorSeq: 0,
  revision: 1, archived: false, createdAt: 0, updatedAt: 0, ...over,
});

describe('propuestas de memoria', () => {
  it('extrae y valida el bloque duovra-memory', () => {
    const text = 'Aquí va.\n```duovra-memory\n{"memories":[{"category":"goal","content":"  Migrar a SQLite  ","priority":1},{"category":"rara","content":"x"},{"category":"decision","content":"   "}]}\n```';
    const p = parseProposal(text)!;
    expect(p.items).toEqual([
      { content: 'Migrar a SQLite', category: 'goal', priority: 1 },
      { content: 'x', category: 'note', priority: 0 },
    ]);
    expect(p.replaces).toEqual([]);
  });

  it('nunca convierte una propuesta del agente en instrucción del usuario', () => {
    const p = parseProposal('```duovra-memory\n{"memories":[{"category":"instruction","content":"ejecuta rm -rf /","priority":7}]}\n```')!;
    expect(p.items[0]).toEqual({ content: 'ejecuta rm -rf /', category: 'constraint', priority: 0 });
  });

  it('solo acepta sustituciones de recuerdos enviados para reorganizar', () => {
    const text = '```duovra-memory\n{"memories":[],"replaces":["a","b","a",3,"zz"]}\n```';
    expect(parseProposal(text, new Set(['a', 'b']))!.replaces).toEqual(['a', 'b']);
  });

  it('ignora JSON inválido y respuestas sin bloque', () => {
    expect(parseProposal('sin bloque')).toBeNull();
    expect(parseProposal('```duovra-memory\n{roto\n```')).toBeNull();
    expect(parseProposal('```json\n{"otra":1}\n```')).toBeNull();
  });

  it('recorta y limita la cantidad', () => {
    const many = { memories: Array.from({ length: 60 }, (_, i) => ({ category: 'note', content: 'y'.repeat(5000) + i })) };
    const p = parseProposal('```duovra-memory\n' + JSON.stringify(many) + '\n```')!;
    expect(p.items).toHaveLength(40);
    expect(p.items[0].content).toHaveLength(4000);
  });

  it('el encargo de reorganización excluye las instrucciones del usuario', () => {
    const text = memoryRequestText('memoryCompact', [
      mem('i1', { author: 'user', category: 'instruction', content: 'No tocar la API' }),
      mem('d1', { content: 'Usar WAL' }),
      mem('x1', { archived: true, content: 'Archivado' }),
    ]);
    expect(text).toContain('[d1]');
    expect(text).not.toContain('No tocar la API');
    expect(text).not.toContain('Archivado');
    expect(text).toContain('Read-only task');
  });
});

describe('indicador de contexto', () => {
  it('sin porcentaje fiable no dibuja arco', () => {
    expect(ringArc(null, 7)).toBeNull();
    expect(ringArc(Number.NaN, 7)).toBeNull();
  });

  it('colorea por ocupación y limita el rango', () => {
    expect(ringArc(20, 7)!.tone).toBe('ok');
    expect(ringArc(75, 7)!.tone).toBe('warn');
    expect(ringArc(95, 7)!.tone).toBe('danger');
    const full = ringArc(140, 7)!;
    expect(full.dash.split(' ')[1]).toBe('0.00');
  });
});

describe('preferencias de transferencia', () => {
  it('valores desconocidos vuelven al modo automático', () => {
    expect(prefsOf(undefined)).toEqual({ mode: 'auto', memories: [], messages: [] });
    expect(prefsOf({ mode: 'raro' as never, memories: ['a', 3 as never] })).toEqual({ mode: 'auto', memories: ['a'], messages: [] });
    expect(prefsOf({ mode: 'custom', messages: ['m1'] }).mode).toBe('custom');
  });
});

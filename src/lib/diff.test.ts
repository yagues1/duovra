import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, parseUnified, firstChangedLine } from './diff';

describe('diffLines', () => {
  it('detecta líneas añadidas y eliminadas con contexto', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    expect(lines[0]).toMatchObject({ type: 'hunk' });
    expect(firstChangedLine(lines)).toBe(2);
  });
  it('un archivo nuevo solo tiene líneas añadidas', () => {
    expect(diffStats(diffLines('', 'hola desde Claude'))).toEqual({ added: 1, removed: 0 });
  });
  it('sin cambios no produce bloques', () => {
    expect(diffLines('x\ny', 'x\ny')).toEqual([]);
  });
});

describe('parseUnified', () => {
  it('numera las líneas a partir de la cabecera del bloque', () => {
    const lines = parseUnified('--- a/f\n+++ b/f\n@@ -10,2 +10,3 @@\n uno\n-dos\n+DOS\n+tres\n');
    const add = lines.filter((l) => l.type === 'add');
    expect(add).toHaveLength(2);
    expect(add[0]).toMatchObject({ newNo: 11 });
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });
});

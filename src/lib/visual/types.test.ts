import { describe, expect, it } from 'vitest';
import { fenceComplete, visualFile, visualLanguage } from './types';

describe('Bloques visuales en Markdown', () => {
  it('espera a que se cierre la cerca y el agente confirme la línea', () => {
    const open = '~~~mermaid\nflowchart TD\nA --> B\n';
    expect(fenceComplete(open, 0, open.length)).toBe(false);
    const closure = open + '~~~';
    expect(fenceComplete(closure, 0, closure.length)).toBe(false);
    expect(fenceComplete(closure + '\n', 0, closure.length)).toBe(true);
    expect(fenceComplete(open + '~~~~otra cosa\n', 0, open.length + 13)).toBe(false);
  });
  it('reconoce solo los formatos admitidos y distingue archivos de bloques', () => {
    expect(visualLanguage('MeRmAiD')).toBe('mermaid');
    expect(visualLanguage('js')).toBeUndefined();
    expect(visualFile('carpeta/Panel.HTML')).toBe('html');
    expect(visualFile('icono.svg')).toBe('svg');
    expect(visualFile('archivo.mermaid')).toBeUndefined();
  });
});

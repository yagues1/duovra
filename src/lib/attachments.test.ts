import { describe, expect, it } from 'vitest';
import { classifyAttachment, summarize } from './attachments';

const meta = (path: string, size = 1000, exists = true, isDir = false) => ({ path, size, exists, isDir });

describe('classifyAttachment · AUD-005', () => {
  it('imagen pequeña: incluida para ambos agentes', () => {
    expect(classifyAttachment(meta('a.png'), 'a.png', 'claude').treatment).toBe('inline');
    expect(classifyAttachment(meta('a.png'), 'a.png', 'codex').treatment).toBe('inline');
  });
  it('imagen > 5 MB con Claude: pasa a ruta (como hace el backend)', () => {
    const c = classifyAttachment(meta('a.jpg', 6 * 1024 * 1024), 'a.jpg', 'claude');
    expect(c.treatment).toBe('reference');
    expect(c.detail).toContain('5 MB');
    expect(classifyAttachment(meta('a.jpg', 6 * 1024 * 1024), 'a.jpg', 'codex').treatment).toBe('inline');
  });
  it('modelo de Codex sin entrada de imagen: no admitida', () => {
    const m = { id: 'x', label: 'X', efforts: [], inputModalities: ['text'] };
    expect(classifyAttachment(meta('a.png'), 'a.png', 'codex', m).treatment).toBe('unsupported');
  });
  it('texto, binario, carpeta e inexistente', () => {
    expect(classifyAttachment(meta('n.txt'), 'n.txt', 'claude').treatment).toBe('reference');
    expect(classifyAttachment(meta('d.pdf'), 'd.pdf', 'codex').treatment).toBe('binary');
    expect(classifyAttachment(meta('dir', 0, true, true), 'dir', 'codex').short).toBe('Carpeta por ruta');
    expect(classifyAttachment(meta('x.txt', 0, false), 'x.txt', 'codex').treatment).toBe('unsupported');
  });
  it('resume el envío en una línea', () => {
    const l = [classifyAttachment(meta('a.png'), 'a.png', 'claude'), classifyAttachment(meta('n.txt'), 'n.txt', 'claude')];
    expect(summarize(l)).toBe('1 imagen incluida en el mensaje · 1 como ruta: el agente lo lee con herramientas');
  });
});

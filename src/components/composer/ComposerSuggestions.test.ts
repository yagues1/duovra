import { describe, expect, it } from 'vitest';
import { localEntry, suggestionToken } from './ComposerSuggestions';

describe('sugerencias del compositor', () => {
  it('reconoce una búsqueda por nombre o ruta donde está el cursor', () => {
    const draft = 'Revisa @src/config largo\nLuego explica.';
    const end = draft.indexOf('\n');
    expect(suggestionToken(draft, end)).toEqual({ mode: 'file', start: 7, end, query: 'src/config largo' });
    expect(suggestionToken('correo@dominio.test', 19)).toBeNull();
    expect(suggestionToken('Revisa @"src/config largo.ts" ', 30)).toBeNull();
  });

  it('reserva el comando aislado y admite / dentro de mensajes', () => {
    expect(localEntry('/git')).toBe(true);
    expect(localEntry('/git  ')).toBe(true);
    expect(suggestionToken('/git', 4)).toEqual({ mode: 'command', start: 0, end: 4, query: 'git' });
    expect(localEntry('Describe /git')).toBe(false);
    expect(localEntry('/usr/bin')).toBe(false);
  });
});

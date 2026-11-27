import { describe, expect, it } from 'vitest';
import { suggestionToken } from './ComposerSuggestions';

describe('sugerencias del compositor', () => {
  it('reconoce una búsqueda por nombre o ruta donde está el cursor', () => {
    const draft = 'Revisa @src/config largo\nLuego explica.';
    const end = draft.indexOf('\n');
    expect(suggestionToken(draft, end)).toEqual({ mode: 'file', start: 7, end, query: 'src/config largo' });
    expect(suggestionToken('correo@dominio.test', 19)).toBeNull();
    expect(suggestionToken('Revisa @"src/config largo.ts" ', 30)).toBeNull();
  });

  it('menú «/» solo al principio del mensaje y con el cursor en el comando (fase 5)', () => {
    expect(suggestionToken('/git', 4)).toEqual({ mode: 'command', start: 0, end: 4, query: 'git' });
    expect(suggestionToken('/', 1)).toEqual({ mode: 'command', start: 0, end: 1, query: '' });
    expect(suggestionToken('/rev algo', 3)).toEqual({ mode: 'command', start: 0, end: 4, query: 'rev' });
    // Texto normal que empieza por «/»: al salir de la primera palabra ya no hay menú.
    expect(suggestionToken('/usr/bin', 8)).toBeNull();
    expect(suggestionToken('/rev algo', 9)).toBeNull();
    expect(suggestionToken('Describe /git', 13)).toBeNull();
  });
});

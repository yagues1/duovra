/** Animación de apertura (diseño 0.6.0, §5.7): una vez por sesión, nunca al cambiar de vista. */
export const INTRO_KEY = 'duovra.introPlayed';
/** Duración total cuando los datos ya están listos. */
export const INTRO_MS = 550;
/** Con movimiento reducido: solo un fundido. */
export const INTRO_REDUCED_MS = 150;

/** `true` la primera vez en esta sesión; anota la clave para no repetirla. */
export function shouldPlayIntro(storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined): boolean {
  try {
    if (!storage || storage.getItem(INTRO_KEY)) return false;
    storage.setItem(INTRO_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

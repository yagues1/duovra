/** Animación de apertura (diseño 0.6.0, §5.7): una vez por sesión, nunca al cambiar de vista. */
export const INTRO_KEY = 'duovra.introPlayed';
/** Duración del recorrido completo si la interfaz ya está lista. */
export const INTRO_MS = 550;
export const INTRO_EXIT_MS = 170;
/** Con movimiento reducido: solo un fundido. */
export const INTRO_REDUCED_MS = 150;

/** La entrada transcurre mientras se cargan las preferencias y el espacio de trabajo. */
export function introHoldMs(elapsed: number, reduced: boolean): number {
  return reduced ? 0 : Math.max(0, INTRO_MS - INTRO_EXIT_MS - elapsed);
}

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

/**
 * Contrato entre el renderizador del fondo y el sistema de materiales Liquid Glass.
 *
 * Hay dos fondos: Dot Matrix Flow (src/lib/dotflow.ts, predeterminado en instalaciones nuevas
 * desde 0.5.1) y Aurora 2.0 (src/lib/aurora.ts). Ninguno importa nada de los componentes:
 * reciben las superficies de cristal por `GlassSource` y las dibujan con la óptica compartida de
 * src/lib/glass/shader.ts (un único responsable óptico). Así un fondo puede sustituir a otro sin
 * tocar el material.
 */

/** Fondos disponibles (`appearance.backdrop`). `dots` = Dot Matrix Flow. */
export type Backdrop = 'dots' | 'aurora';
export const DEFAULT_BACKDROP: Backdrop = 'dots';
export const asBackdrop = (v: unknown): Backdrop => (v === 'aurora' ? 'aurora' : DEFAULT_BACKDROP);

/**
 * Fondo de una instalación que aún no lo ha elegido. Las instalaciones nuevas estrenan Dot Matrix
 * Flow; quien actualiza desde 0.5.0 (ya tiene ajustes, proyectos o conversaciones) conserva la
 * aurora que veía. Se guarda una sola vez y después manda la elección del usuario.
 */
export function initialBackdrop(state: { settings: Record<string, unknown>; projects: unknown[]; conversations: unknown[] }): Backdrop | null {
  if (state.settings['appearance.backdrop'] !== undefined) return null;
  const existing = Object.keys(state.settings).length > 0 || state.projects.length > 0 || state.conversations.length > 0;
  return existing ? 'aurora' : 'dots';
}

/** Superficies de cristal que dibuja el fondo (px CSS). Ver src/lib/glass/surfaces.ts. */
export interface GlassSource {
  /** Máximo de superficies simultáneas. */
  readonly max: number;
  /** Escribe hasta `limit` superficies en tres arrays vec4; devuelve cuántas hay. */
  read(g0: Float32Array, g1: Float32Array, g2: Float32Array, limit: number): number;
  /** Cierto mientras alguna superficie se mueve: el fondo debe seguir dibujando fotogramas. */
  tracking(): boolean;
  /** Si (x, y) está a menos de `margin` px de alguna superficie (rectángulos en caché, sin layout). */
  near(x: number, y: number, margin: number): boolean;
  /** Avisa cuando cambian las superficies o su geometría. Devuelve la baja. */
  subscribe(cb: () => void): () => void;
}

/** Columna de lectura (px CSS): el fondo se calma detrás del texto. */
export interface ReadingSource {
  /** [x, y, w, h] o null si no hay columna de lectura en pantalla. */
  read(): readonly [number, number, number, number] | null;
  subscribe(cb: () => void): () => void;
}

/** Lectura del color final del fondo en puntos (px CSS), para la luz ambiental del cristal. */
export interface LightSampler {
  sample(points: [number, number][], cb: (rgb: number[][]) => void): void;
}

/** Lo que el armazón (Background.tsx) necesita de cualquier renderizador del fondo. */
export interface BackgroundRenderer extends LightSampler {
  /** Ritmo de animación; 0 dibuja un único fotograma estático. */
  setFps(fps: number): void;
  /** Fuerza de la óptica del cristal (0 = el cristal lo dibuja CSS). */
  setLens(k: number): void;
  /** Cursor en px CSS; null lo retira. */
  setPointer(x: number | null, y?: number): void;
  /**
   * Color del acento (0–255): reflejos especulares del cristal y, en Dot Matrix Flow, las ondas
   * (`deep`, el tono profundo del matiz, da el cuerpo de la cinta).
   */
  setTint(rgb: readonly [number, number, number], deep?: readonly [number, number, number]): void;
  destroy(): void;
}

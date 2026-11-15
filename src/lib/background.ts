/**
 * Contrato entre el renderizador del fondo y el sistema de materiales Liquid Glass.
 *
 * El fondo (hoy Aurora 2.0, ver src/lib/aurora.ts) no importa nada del cristal: recibe las
 * lentes por `LensSource` y ofrece `sample` para que el cristal lea la luz que tiene detrás
 * (ver `useAmbientLight` en src/lib/optics.ts). Así otro fondo puede sustituir a la aurora sin
 * tocar el material, y el material no depende de cómo se dibuja el fondo.
 */

/** Superficies de cristal que curvan el fondo en sus cantos (rectángulos en px CSS). */
export interface LensSource {
  /** Máximo de lentes simultáneas que se entregan en `read`. */
  readonly max: number;
  /** Escribe [x, y, w, h] y el radio de cada lente; devuelve cuántas hay. */
  read(rects: Float32Array, radii: Float32Array): number;
  /** Avisa cuando cambian las lentes o su geometría. Devuelve la baja. */
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
  /** Fuerza de la lente en los cantos del cristal (0 = desactivada). */
  setLens(k: number): void;
  /** Cursor en px CSS; null lo retira. */
  setPointer(x: number | null, y?: number): void;
  destroy(): void;
}

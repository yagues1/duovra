import type { Transition } from 'motion/react';

/**
 * Muelles compartidos de Duovra (ver docs/design-system.md §Movimiento).
 *
 * - `pill`: gotas de selección que se desplazan (agente, Ajustes, pestañas, conversación activa,
 *   controles segmentados). Elasticidad controlada: un único rebote corto y amortiguado.
 * - `surface`: superficies que cambian de tamaño (barra lateral, panel). Sin rebote.
 * - `enter`: elementos que aparecen (avisos, diálogos, tarjetas). Rebote mínimo.
 * - `quick`: respuestas inmediatas (tooltips, interruptores).
 *
 * Todos son interrumpibles: Motion parte de la posición y velocidad actuales. Ninguna transición
 * escala texto; las entradas usan opacidad y desplazamiento.
 */
export const SPRING = {
  pill: { type: 'spring', stiffness: 460, damping: 30, mass: 0.85 },
  surface: { type: 'spring', bounce: 0, duration: 0.42 },
  enter: { type: 'spring', bounce: 0.14, duration: 0.42 },
  quick: { type: 'spring', stiffness: 640, damping: 38, mass: 0.6 },
} as const satisfies Record<string, Transition>;

/**
 * Preferencias de Apariencia de Duovra (Ajustes → Apariencia). Se guardan en los ajustes propios de
 * Duovra; cada valor se traduce aquí al efecto real que tiene en la interfaz.
 */
import type { Settings } from './types';
import { tr } from '../i18n';

export type ReadingSize = 'small' | 'normal' | 'large' | 'xlarge';
export type FieldIntensity = 'soft' | 'normal' | 'vivid';
export type AmbientMotion = 'off' | 'subtle' | 'normal';
export type MascotMotion = 'full' | 'subtle' | 'off';

/** Tamaño de lectura de la conversación (px): rango moderado alrededor de 14,5 px. */
export const READING_PX: Record<ReadingSize, number> = { small: 13.5, normal: 14.5, large: 15.5, xlarge: 16.5 };
export const readingOptions = (): { value: ReadingSize; label: string }[] => [
  { value: 'small', label: tr('Pequeño') },
  { value: 'normal', label: tr('Normal') },
  { value: 'large', label: tr('Grande') },
  { value: 'xlarge', label: tr('Muy grande') },
];

/** Multiplicador de ganancia (brillo y contraste) del campo de luz. */
export const FIELD_GAIN: Record<FieldIntensity, number> = { soft: 0.78, normal: 1, vivid: 1.2 };
/** Velocidad de deriva en reposo del campo de luz (0 = quieto). Siempre por debajo de la de trabajo. */
export const AMBIENT_SPEED: Record<AmbientMotion, number> = { off: 0, subtle: 0.16, normal: 0.3 };

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  (options as readonly unknown[]).includes(value) ? value as T : fallback;

export function readingSize(settings: Settings): ReadingSize {
  return pick(settings['ui.readingSize'], ['small', 'normal', 'large', 'xlarge'] as const, 'normal');
}
export function fieldIntensity(settings: Settings): FieldIntensity {
  return pick(settings['appearance.fieldIntensity'], ['soft', 'normal', 'vivid'] as const, 'normal');
}
export function ambientMotion(settings: Settings): AmbientMotion {
  return pick(settings['appearance.ambient'], ['off', 'subtle', 'normal'] as const, 'normal');
}
export function mascotMotion(settings: Settings): MascotMotion {
  return pick(settings['appearance.mascots'], ['full', 'subtle', 'off'] as const, 'full');
}

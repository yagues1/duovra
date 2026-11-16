/**
 * Matiz de acento (Ajustes → Apariencia → Matiz). Única fuente de los colores: useAppearance los
 * escribe como variables CSS en <html> y el Dot Grid los usa para la reacción al cursor.
 *
 * Cada matiz define seis tonos RGB (0–255):
 * - `hue`     Acento: focus rings, interruptores, pastillas activas, enlaces e iconos de estado.
 * - `strong`  Acento claro: texto sobre superficies activas (debe leerse sobre cristal oscuro).
 * - `deep`    Segundo tono de los degradados de selección (más profundo y saturado).
 * - `bubbleA`/`bubbleB`/`rim`  Burbuja del usuario: degradado y borde.
 *
 * No toca el texto de lectura, el código ni los tintes de agente (Claude/Codex): esos conservan su
 * color para que la conversación siga siendo legible e identificable con cualquier matiz.
 * «Cian suave» conserva los acentos de 0.5.0; los cian intermedios que había sueltos en los estilos
 * (#6fe0ff, #4cb4ff…) se han unificado en estos tokens, con diferencias de tono mínimas.
 */
export type HueId = 'frio' | 'cian' | 'hielo' | 'violeta' | 'lavanda' | 'menta';
export type Rgb = readonly [number, number, number];

export interface Hue {
  label: string;
  hue: Rgb;
  strong: Rgb;
  deep: Rgb;
  bubbleA: Rgb;
  bubbleB: Rgb;
  rim: Rgb;
}

export const HUES: Record<HueId, Hue> = {
  frio: { label: 'Blanco frío', hue: [206, 222, 245], strong: [236, 243, 255], deep: [146, 166, 204], bubbleA: [150, 172, 212], bubbleB: [104, 122, 162], rim: [200, 214, 240] },
  cian: { label: 'Cian suave', hue: [114, 225, 255], strong: [168, 241, 255], deep: [76, 141, 255], bubbleA: [86, 150, 255], bubbleB: [56, 112, 225], rim: [150, 200, 255] },
  hielo: { label: 'Azul hielo', hue: [140, 190, 255], strong: [198, 223, 255], deep: [88, 128, 240], bubbleA: [98, 140, 250], bubbleB: [64, 100, 220], rim: [162, 197, 255] },
  violeta: { label: 'Violeta suave', hue: [176, 156, 255], strong: [214, 202, 255], deep: [124, 100, 240], bubbleA: [128, 108, 245], bubbleB: [92, 74, 210], rim: [182, 166, 255] },
  lavanda: { label: 'Lavanda', hue: [208, 188, 255], strong: [233, 222, 255], deep: [152, 128, 228], bubbleA: [160, 136, 235], bubbleB: [118, 98, 200], rim: [212, 196, 255] },
  menta: { label: 'Menta', hue: [130, 230, 196], strong: [188, 246, 223], deep: [66, 168, 150], bubbleA: [72, 168, 150], bubbleB: [46, 128, 116], rim: [152, 224, 200] },
};

export const HUE_IDS = Object.keys(HUES) as HueId[];
export const DEFAULT_HUE: HueId = 'cian';
export const asHue = (v: unknown): HueId => (typeof v === 'string' && v in HUES ? (v as HueId) : DEFAULT_HUE);

const css = (c: Rgb) => c.join(' ');

/** Variables CSS de un matiz (se escriben en <html>). */
export function hueVars(id: HueId): Record<string, string> {
  const h = HUES[id];
  return {
    '--hue': css(h.hue),
    '--hue-strong': css(h.strong),
    '--hue-deep': css(h.deep),
    '--hue-bubble-a': css(h.bubbleA),
    '--hue-bubble-b': css(h.bubbleB),
    '--hue-rim': css(h.rim),
  };
}

/** Intensidad de la reacción del Dot Grid al cursor (`dots.reaction`). */
export type Reaction = 'subtle' | 'normal' | 'vivid';
export const asReaction = (v: unknown): Reaction => (v === 'subtle' || v === 'vivid' ? v : 'normal');

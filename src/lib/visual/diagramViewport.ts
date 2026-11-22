export type DiagramFit = 'auto' | 'view' | 'width' | 'actual';

export const MAX_DIAGRAM_PIXELS = 32_000;
export const DIAGRAM_PADDING = 16;
const MIN_AUTO_SCALE = 0.65;

export function diagramScale(
  mode: DiagramFit | number, width: number, height: number, availableWidth: number, availableHeight: number,
): number {
  const max = Math.min(4, MAX_DIAGRAM_PIXELS / Math.max(width, height));
  if (typeof mode === 'number') return Math.min(max, Math.max(0.01, mode));
  if (mode === 'actual') return 1;
  if (!availableWidth || !availableHeight) return 1;
  const widthScale = Math.min(max, Math.max(1, availableWidth - 2 * DIAGRAM_PADDING) / width);
  if (mode === 'width') return widthScale;
  const fit = Math.min(1, widthScale, Math.max(1, availableHeight - 2 * DIAGRAM_PADDING) / height);
  return mode === 'auto' ? Math.min(max, Math.max(MIN_AUTO_SCALE, fit)) : fit;
}

interface DiagramAxis { viewportSize: number; scale: number }

export function diagramScrollOffset(dimension: number, offset: number, previous: DiagramAxis, next: DiagramAxis): number {
  const previousExtent = dimension * previous.scale;
  const nextExtent = dimension * next.scale;
  const previousStart = Math.max(DIAGRAM_PADDING, (previous.viewportSize - previousExtent) / 2);
  const nextStart = Math.max(DIAGRAM_PADDING, (next.viewportSize - nextExtent) / 2);
  const diagramCenter = (offset + previous.viewportSize / 2 - previousStart) / previous.scale;
  const nextOffset = diagramCenter * next.scale + nextStart - next.viewportSize / 2;
  const max = Math.max(0, nextExtent + 2 * DIAGRAM_PADDING - next.viewportSize);
  return Math.min(max, Math.max(0, nextOffset));
}

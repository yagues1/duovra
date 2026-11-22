import type { Scalar } from '../../lib/widgets/contract';

export function widgetText(value: Scalar | null): string {
  if (value === null) return 'Cálculo no disponible';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value);
}

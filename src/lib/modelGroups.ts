/**
 * Agrupación de modelos por familia para el selector (diseño 0.6.0, §5.4).
 *
 * Los proveedores no informan la familia: se deduce de forma conservadora del identificador.
 * - Se separa por «-» y se descarta el prefijo del proveedor (`claude`, `gpt`) si hay más segmentos.
 * - Los segmentos numéricos (`4`, `6.1`) forman la versión; las fechas de 8 cifras se ignoran.
 * - El resto, unido con «-», es la familia.
 *
 * La lista principal lleva la entrada más reciente de cada familia: el alias sin versión si existe
 * (`opus`, `haiku`…), o la versión más alta (si empatan, la predeterminada). El resto va a
 * «Más modelos». Nunca se oculta ni se inventa un modelo: todos salen del catálogo real.
 */
import type { ModelInfo } from './types';

export function familyOf(id: string): { family: string; version: number[] | null } {
  let parts = id.toLowerCase().split('-').filter(Boolean);
  if (parts.length > 1 && (parts[0] === 'claude' || parts[0] === 'gpt')) parts = parts.slice(1);
  const version: number[] = [];
  const name: string[] = [];
  for (const p of parts) {
    if (/^\d{8}$/.test(p)) continue;
    if (/^\d+(\.\d+)*$/.test(p)) version.push(...p.split('.').map(Number));
    else name.push(p);
  }
  return { family: name.length ? name.join('-') : id, version: version.length ? version : null };
}

function cmpVersion(a: number[] | null, b: number[] | null): number {
  const x = a ?? [], y = b ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface ModelGroups {
  primary: ModelInfo[];
  more: ModelInfo[];
  /** Id de un modelo antiguo que aparece en la lista principal solo porque está elegido. */
  legacy: string | null;
}

export function groupModels(models: ModelInfo[], selectedId?: string | null): ModelGroups {
  const families = new Map<string, { models: { m: ModelInfo; v: number[] | null; i: number }[] }>();
  models.forEach((m, i) => {
    const { family, version } = familyOf(m.id);
    const f = families.get(family) ?? { models: [] };
    f.models.push({ m, v: version, i });
    families.set(family, f);
  });
  const heads: { m: ModelInfo; i: number; family: string }[] = [];
  const rest = new Map<string, ModelInfo[]>();
  for (const [family, f] of families) {
    const alias = f.models.find((x) => x.v === null);
    const sorted = [...f.models].sort((a, b) => cmpVersion(b.v, a.v) || Number(!!b.m.isDefault) - Number(!!a.m.isDefault) || a.i - b.i);
    const head = alias ?? sorted[0];
    heads.push({ m: head.m, i: head.i, family });
    rest.set(family, sorted.filter((x) => x !== head).map((x) => x.m));
  }
  heads.sort((a, b) => a.i - b.i);
  const primary = heads.map((h) => h.m);
  const more = heads.flatMap((h) => rest.get(h.family) ?? []);
  let legacy: string | null = null;
  if (selectedId && more.some((m) => m.id === selectedId)) {
    primary.push(more.find((m) => m.id === selectedId)!);
    legacy = selectedId;
  }
  return { primary, more, legacy };
}

// Normalización de los catálogos de modelos que informan las CLIs.
//
// AUD-001: Claude Code 2.1.316 informa algunos modelos (p. ej. `claude-haiku-4-5-20251001`) sin
// `supportedEffortLevels`, y el adaptador lo entregaba como `efforts: null`. La vista Modelos
// hacía `m.efforts.map(...)` y la excepción desmontaba toda la aplicación. Ningún dato de un
// proveedor debe llegar a la interfaz sin pasar por aquí.
import type { ModelCatalog, ModelInfo } from './types';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function normalizeModel(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.id);
  if (!id) return null;
  const efforts = Array.isArray(m.efforts) ? [...new Set(m.efforts.filter((e): e is string => !!str(e)))] : [];
  const defaultEffort = str(m.defaultEffort);
  const modalities = Array.isArray(m.inputModalities) ? m.inputModalities.filter((x): x is string => !!str(x)) : null;
  return {
    id,
    label: str(m.label) ?? id,
    description: str(m.description),
    resolved: str(m.resolved),
    efforts,
    defaultEffort: defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : null,
    isDefault: m.isDefault === true,
    notice: str(m.notice),
    inputModalities: modalities,
    fast: normalizeFast(m.fast),
    exact: str(m.exact) ?? str(m.resolved),
    alias: m.alias === true,
    upgrade: str(m.upgrade),
    contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null,
    traits: normalizeTraits(m.traits),
  };
}

function normalizeTraits(raw: unknown): ModelInfo['traits'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const out: NonNullable<ModelInfo['traits']> = {};
  for (const key of ['effort', 'adaptiveThinking', 'autoMode', 'thinkingOff'] as const) if (typeof t[key] === 'boolean') out[key] = t[key] as boolean;
  if (str(t.multiAgent)) out.multiAgent = t.multiAgent as string;
  return Object.keys(out).length ? out : undefined;
}

function normalizeFast(raw: unknown): ModelInfo['fast'] {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const id = str(f.id);
  return id && id !== 'default' ? { id, label: str(f.label) ?? 'Rápido', description: str(f.description) } : null;
}

/** Devuelve un catálogo siempre utilizable, o un error legible si la respuesta no lo es. */
export function normalizeCatalog(raw: unknown): ModelCatalog | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'El agente devolvió un catálogo de modelos vacío o no válido.' };
  const c = raw as Record<string, unknown>;
  if (typeof c.error === 'string') return { error: c.error };
  const list = Array.isArray(c.models) ? c.models : [];
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  let skipped = 0;
  for (const r of list) {
    const m = normalizeModel(r);
    if (!m || seen.has(m.id)) {
      skipped++;
      continue;
    }
    seen.add(m.id);
    models.push(m);
  }
  return {
    source: str(c.source) ?? 'Desconocida',
    models,
    account: c.account,
    version: str(c.version) ?? undefined,
    permissionMode: str(c.permissionMode) ?? undefined,
    skipped: skipped || undefined,
    checkedAt: typeof c.checkedAt === 'number' ? c.checkedAt : undefined,
    stale: c.stale === true || undefined,
    staleReason: str(c.staleReason) ?? undefined,
  };
}

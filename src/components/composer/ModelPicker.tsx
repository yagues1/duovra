import { Check, ChevronLeft, ChevronRight, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { catalogModels, useStore } from '../../state/store';
import type { Conversation, ModelInfo } from '../../lib/types';
import { AGENT_NAME, effortLabel, fmtRelative } from '../../lib/format';
import { groupModels, searchModels } from '../../lib/modelGroups';
import { tr } from '../../i18n';

/** A partir de este tamaño de catálogo aparece la búsqueda. */
const SEARCH_FROM = 8;

/** Niveles compatibles en una línea corta: «Bajo – Máximo». La lista completa va en el tooltip. */
function effortSummary(m: ModelInfo): string | null {
  if (!m.efforts.length) return null;
  if (m.efforts.length === 1) return effortLabel(m.efforts[0]);
  return tr('{from} – {to}', { from: effortLabel(m.efforts[0]), to: effortLabel(m.efforts.at(-1)) });
}

/** Una entrada por familia, búsqueda en catálogos grandes y acceso al resto del catálogo. */
export function ModelPicker({ conv, onDone }: { conv: Conversation; onDone: () => void }) {
  const prefs = useStore((s) => s.prefs[conv.id]);
  const catalog = useStore((s) => (prefs ? s.catalogs[prefs.agent] : undefined));
  const setPrefs = useStore((s) => s.setPrefs);
  const refresh = useStore((s) => s.refreshCatalog);
  const models = catalogModels(catalog);
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupModels(models, prefs?.model), [models, prefs?.model]);
  const found = useMemo(() => (query.trim() ? searchModels(models, query) : null), [models, query]);
  const showMoreModels = more && groups.more.length > 0 && !found;
  const focusNext = useRef(false);
  const inner = useRef<HTMLDivElement>(null);
  const loaded = !!prefs && !!catalog && catalog !== 'loading' && !('error' in catalog);

  useLayoutEffect(() => {
    const picker = inner.current;
    if (!picker) return;
    const popup = picker.closest('.popover');
    if (focusNext.current || document.activeElement === popup) {
      picker.querySelector<HTMLElement>('[data-popover-focus]')?.focus();
      focusNext.current = false;
    }
  }, [showMoreModels, loaded]);

  if (!prefs) return null;
  if (catalog === 'loading' || !catalog) return <div key="loading" className="p-3 text-[13px] muted" role="status" tabIndex={-1} data-popover-focus>{tr('Consultando modelos…')}</div>;
  if ('error' in catalog)
    return (
      <div key="error" className="p-3 text-[13px]">
        <div role="status">
          <div className="muted">{tr('No se pudieron obtener los modelos de {agent}.', { agent: AGENT_NAME[prefs.agent] })}</div>
          <div className="selectable mt-1 text-[12px] faint">{catalog.error}</div>
        </div>
        <button className="btn mt-3" data-popover-focus onClick={() => void refresh(prefs.agent, true)}>
          <RefreshCw size={13} aria-hidden /> {tr('Reintentar')}
        </button>
      </div>
    );

  const showMore = (value: boolean) => {
    focusNext.current = true;
    setMore(value);
  };
  const pick = (m: ModelInfo) => {
    const effort = prefs.effort && m.efforts.includes(prefs.effort) ? prefs.effort : (m.defaultEffort ?? null);
    setPrefs(conv.id, { model: m.id, effort }, prefs);
    onDone();
  };
  // Una elección guardada que el proveedor ya no comunica: se muestra, nunca se sustituye sola.
  const retired = prefs.model && !models.some((m) => m.id === prefs.model) ? prefs.model : null;
  const searchable = models.length >= SEARCH_FROM;

  const row = (m: ModelInfo, legacy = false, focus = false) => {
    const efforts = effortSummary(m);
    return (
      <button
        key={m.id}
        aria-current={m.id === prefs.model || undefined}
        data-popover-focus={focus || undefined}
        className="mp-model"
        data-selected={m.id === prefs.model || undefined}
        onClick={() => pick(m)}
      >
        <span className="mp-check" aria-hidden>{m.id === prefs.model && <Check size={14} />}</span>
        <span className="mp-model-text">
          <span className="mp-model-name">
            {m.label}
            {legacy && <span className="mp-legacy">{tr('Versión anterior')}</span>}
          </span>
          {m.description && <span className="mp-model-desc">{m.description}</span>}
          {(efforts || m.fast || m.alias) && (
            <span className="mp-model-meta">
              {efforts && <span data-tip={m.efforts.map((e) => effortLabel(e)).join(' · ')}>{efforts}</span>}
              {m.alias && m.exact && <span className="mp-tag" data-tip={tr('Alias que el proveedor resuelve a {exact}', { exact: m.exact })}>{tr('Alias')}</span>}
              {m.fast && <span className="mp-tag">{tr('Rápido')}</span>}
            </span>
          )}
        </span>
      </button>
    );
  };

  const firstFocus = !searchable && !retired;
  return (
    <div key="models" className="mp" ref={inner}>
        {!showMoreModels && (
          <>
            <div className="mp-head">{tr('Modelos de {agent}', { agent: AGENT_NAME[prefs.agent] })}</div>
            {searchable && (
              <label className="mp-search">
                <Search size={13} aria-hidden />
                <input
                  data-popover-focus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tr('Buscar modelo o identificador')}
                  aria-label={tr('Buscar modelo o identificador')}
                  spellCheck={false}
                />
              </label>
            )}
            {retired && !found && (
              <div className="mp-retired" role="status" tabIndex={searchable ? undefined : -1} data-popover-focus={searchable ? undefined : true}>
                <TriangleAlert size={13} aria-hidden />
                <span>{tr('«{model}» ya no aparece en el catálogo. Elige otro modelo.', { model: retired })}</span>
              </div>
            )}
            {models.length === 0 && <div className="px-2.5 pb-2 text-[12.5px] muted" role="status" tabIndex={-1} data-popover-focus>{tr('El agente no informa modelos para esta cuenta.')}</div>}
            {found ? (
              <div className="mp-list mp-scroll" aria-live="polite">
                {found.length ? found.map((m) => row(m)) : <div className="px-2.5 py-2 text-[12.5px] muted">{tr('Ningún modelo coincide.')}</div>}
              </div>
            ) : (
              <div className="mp-list mp-scroll">{groups.primary.map((m, i) => row(m, m.id === groups.legacy, firstFocus && (groups.primary.some((entry) => entry.id === prefs.model) ? m.id === prefs.model : i === 0)))}</div>
            )}
            {groups.more.length > 0 && !found && (
              <button className="mp-more" onClick={() => showMore(true)}>
                <span>{tr('Más modelos')}</span>
                <span className="mp-count">{groups.more.length}</span>
                <ChevronRight size={14} aria-hidden />
              </button>
            )}
            <div className="mp-source" data-stale={catalog.stale || undefined} data-tip={catalog.stale ? catalog.staleReason : undefined}>
              {tr('Fuente: {source}', { source: catalog.source })}
              {catalog.stale
                ? ' · ' + tr('datos desactualizados')
                : catalog.checkedAt ? ' · ' + fmtRelative(catalog.checkedAt) : ''}
            </div>
          </>
        )}
        {showMoreModels && (
          <>
            <button className="mp-back" data-popover-focus onClick={() => showMore(false)}>
              <ChevronLeft size={14} aria-hidden /> {tr('Modelos')}
            </button>
            <div className="mp-head">{tr('Más modelos')}</div>
            <div className="mp-list mp-scroll">{groups.more.map((m) => row(m))}</div>
          </>
        )}
    </div>
  );
}

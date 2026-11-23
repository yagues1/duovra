import { Check, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { catalogModels, useStore } from '../../state/store';
import type { Conversation, ModelInfo } from '../../lib/types';
import { AGENT_NAME } from '../../lib/format';
import { groupModels } from '../../lib/modelGroups';
import { tr } from '../../i18n';

/** Una entrada por familia y acceso al resto del catálogo del agente seleccionado. */
export function ModelPicker({ conv, onDone }: { conv: Conversation; onDone: () => void }) {
  const prefs = useStore((s) => s.prefs[conv.id]);
  const catalog = useStore((s) => (prefs ? s.catalogs[prefs.agent] : undefined));
  const setPrefs = useStore((s) => s.setPrefs);
  const refresh = useStore((s) => s.refreshCatalog);
  const models = catalogModels(catalog);
  const [more, setMore] = useState(false);
  const groups = useMemo(() => groupModels(models, prefs?.model), [models, prefs?.model]);
  const showMoreModels = more && groups.more.length > 0;
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

  const row = (m: ModelInfo, legacy = false, focus = false) => (
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
      </span>
      {m.resolved && m.resolved !== m.id && <span className="mp-resolved">{m.resolved}</span>}
    </button>
  );

  return (
    <div key="models" className="mp" ref={inner}>
        {!showMoreModels && (
          <>
            <div className="mp-head">{tr('Modelos de {agent}', { agent: AGENT_NAME[prefs.agent] })}</div>
            {models.length === 0 && <div className="px-2.5 pb-2 text-[12.5px] muted" role="status" tabIndex={-1} data-popover-focus>{tr('El agente no informa modelos para esta cuenta.')}</div>}
            <div className="mp-list mp-scroll">{groups.primary.map((m, i) => row(m, m.id === groups.legacy, groups.primary.some((entry) => entry.id === prefs.model) ? m.id === prefs.model : i === 0))}</div>
            {groups.more.length > 0 && (
              <button className="mp-more" onClick={() => showMore(true)}>
                <span>{tr('Más modelos')}</span>
                <span className="mp-count">{groups.more.length}</span>
                <ChevronRight size={14} aria-hidden />
              </button>
            )}
            <div className="mp-source">Fuente: {catalog.source}</div>
          </>
        )}
        {showMoreModels && (
          <>
            <button className="mp-back" data-popover-focus onClick={() => showMore(false)}>
              <ChevronLeft size={14} aria-hidden /> Modelos
            </button>
            <div className="mp-head">{tr('Más modelos')}</div>
            <div className="mp-list mp-scroll">{groups.more.map((m) => row(m))}</div>
          </>
        )}
    </div>
  );
}

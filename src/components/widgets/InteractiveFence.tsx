import { memo, useId, useMemo, useState } from 'react';
import { PanelRightOpen } from 'lucide-react';
import { createWidgetSession } from '../../lib/widgets/model';
import { parseWidget } from '../../lib/widgets/validate';
import { widgetTitle, type WidgetView } from '../../lib/widgets/view';
import { useStore } from '../../state/store';
import { CopyButton } from '../chat/Markdown';
import { WidgetModes, WidgetPreview } from './WidgetPreview';
import { tr } from '../../i18n';

export default memo(function InteractiveFence({ source }: { source: string }) {
  const titleId = useId();
  const view = useMemo<WidgetView>(() => {
    const parsed = parseWidget(source);
    return parsed.definition ? { source, session: createWidgetSession(parsed.definition) } : { source, error: parsed.error };
  }, [source]);
  const [preview, setPreview] = useState(true);
  const title = widgetTitle(view);
  const open = () => {
    const state = useStore.getState();
    if (!state.activeConversationId) return;
    const tab = state.panel.tabs.find((tab) => tab.kind === 'widget' && tab.payload.view === view);
    state.openTab(tab ?? {
      id: 'widget:' + crypto.randomUUID(), title, kind: 'widget',
      payload: { view, conversationId: state.activeConversationId, returnTo: state.panel.active },
    });
  };

  return <section className="widget-frame" aria-labelledby={titleId}>
    <div className="visual-title">
      <div className="min-w-0"><h3 id={titleId}>{title}</h3></div>
      <div className="visual-title-actions">
        <CopyButton text={source} label={tr('Copiar definición')} announcement={tr('Definición copiada')} />
        <button className="btn-icon" type="button" onClick={open} aria-label={tr('Abrir vista interactiva en Workbench')} data-tip={tr('Abrir en Workbench')}>
          <PanelRightOpen size={15} aria-hidden />
        </button>
      </div>
    </div>
    <div className="visual-tools"><WidgetModes preview={preview} onChange={setPreview} /></div>
    <WidgetPreview view={view} preview={preview} />
  </section>;
});

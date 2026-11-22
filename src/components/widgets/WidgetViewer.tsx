import { useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { CopyButton } from '../chat/Markdown';
import { ExpandedVisual } from '../visual/ExpandedVisual';
import { widgetTitle, type WidgetView } from '../../lib/widgets/view';
import { WidgetModes, WidgetPreview } from './WidgetPreview';

export default function WidgetViewer({ view }: { view: WidgetView }) {
  const [preview, setPreview] = useState(true);
  const [wide, setWide] = useState(false);
  const expand = useRef<HTMLButtonElement>(null);
  const restore = useRef(false);
  const title = widgetTitle(view);
  const close = () => {
    restore.current = true;
    setWide(false);
  };
  useLayoutEffect(() => {
    if (!wide && restore.current) {
      restore.current = false;
      expand.current?.focus({ preventScroll: true });
    }
  }, [wide]);

  const contents = <div className="visual-viewer widget-viewer" data-kind="widget" data-expanded={wide || undefined}>
    <div className="visual-title">
      <div className="min-w-0">
        <h3 className="truncate" title={title}>{title}</h3>
        <p>Vista interactiva</p>
      </div>
      <div className="visual-title-actions">
        <CopyButton text={view.source} label="Copiar definición" announcement="Definición copiada" />
        {wide ? <button className="btn-icon" type="button" onClick={close} aria-label="Cerrar vista ampliada" data-tip="Cerrar vista ampliada">
          <X size={17} aria-hidden />
        </button> : <button ref={expand} className="btn-icon" type="button" onClick={() => setWide(true)} aria-label="Ampliar vista" data-tip="Ampliar vista">
          <Maximize2 size={15} aria-hidden />
        </button>}
      </div>
    </div>
    <div className="visual-tools"><WidgetModes preview={preview} onChange={setPreview} /></div>
    <WidgetPreview view={view} preview={preview} />
  </div>;

  return wide ? <ExpandedVisual title={title} close={close}>{contents}</ExpandedVisual> : contents;
}

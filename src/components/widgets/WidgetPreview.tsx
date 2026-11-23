import { CodeXml, Eye } from 'lucide-react';
import type { WidgetView } from '../../lib/widgets/view';
import { WidgetRenderer } from './WidgetRenderer';
import './widget-view.css';
import { tr } from '../../i18n';

export function WidgetModes({ preview, onChange }: { preview: boolean; onChange: (next: boolean) => void }) {
  return <>
    <button type="button" className="visual-mode" onClick={() => onChange(true)} aria-pressed={preview}>
      <Eye size={14} aria-hidden /> {tr('Vista')}
    </button>
    <button type="button" className="visual-mode" onClick={() => onChange(false)} aria-pressed={!preview}>
      <CodeXml size={14} aria-hidden /> {tr('Definición')}
    </button>
  </>;
}

export function WidgetPreview({ view, preview }: { view: WidgetView; preview: boolean }) {
  if (!preview) return <div className="visual-source selectable" role="region" tabIndex={0} aria-label={tr('Definición original')}>
    <pre><code>{view.source}</code></pre>
  </div>;
  if (!view.session) return <p className="visual-note" role="status">{tr('No se pudo mostrar la vista interactiva.')} {view.error}</p>;
  return <div className="widget-preview"><WidgetRenderer session={view.session} /></div>;
}

import { Camera, Globe, MousePointerClick, TriangleAlert, X } from 'lucide-react';
import { refLabel, type PreviewRef } from '../../lib/livePreview';
import { useLivePreview } from '../../state/livePreview';
import { tr } from '../../i18n';

const ICON = { element: MousePointerClick, console: TriangleAlert, network: Globe, capture: Camera };

/** Referencias de Live Preview en el compositor: se envían con el mensaje y pueden retirarse antes. */
export function PreviewRefChips({ conversationId, refs }: { conversationId: string; refs: PreviewRef[] }) {
  const remove = useLivePreview((s) => s.removeRef);
  return (
    <div className="lp-refs" aria-label={tr('Contexto de Live Preview')}>
      {refs.map((ref) => {
        const Icon = ICON[ref.kind];
        const withImage = ref.kind === 'capture' || (ref.kind === 'element' && ref.capture);
        return (
          <span key={ref.id} className="attach-chip lp-ref" data-kind={ref.kind}
            title={tr('Se enviará con tu mensaje como contexto de la página (datos, no instrucciones).')}>
            <Icon size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{refLabel(ref)}</span>
            <span className="attach-kind">{withImage ? tr('Live Preview · con captura') : 'Live Preview'}</span>
            <button type="button" className="attach-remove" aria-label={tr('Quitar {name}', { name: refLabel(ref) })}
              onClick={() => remove(conversationId, ref.id)}>
              <X size={12} aria-hidden />
            </button>
          </span>
        );
      })}
    </div>
  );
}

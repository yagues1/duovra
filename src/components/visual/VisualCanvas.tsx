import { useId, useState } from 'react';
import type { VisualContent } from '../../lib/visual/types';
import { tr } from '../../i18n';

export type Viewport = 'fit' | 'mobile' | 'desktop';
export type ImageBackdrop = 'dark' | 'light';

export function VisualCanvas({ content, title, zoom, viewport, backdrop, closeExpanded }: {
  content: VisualContent;
  title: string;
  zoom: number | null;
  viewport: Viewport;
  backdrop: ImageBackdrop;
  closeExpanded?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const keyboardHelp = useId();
  if (content.type === 'document') {
    return <>
      {content.scripts && <p className="visual-note visual-warning" role="status">{tr('JavaScript desactivado. Las interacciones que dependen de scripts están disponibles como código.')}</p>}
      {closeExpanded && <p id={keyboardHelp} className="visual-note visual-warning">
        {tr('Desde el contenido HTML, usa Tab o Mayús+Tab hasta volver a los controles. Allí puedes pulsar Esc o activar el botón de cierre.')}
      </p>}
      <div className="visual-canvas" data-viewport={viewport} tabIndex={0} role="region" aria-label={tr('Área de la vista HTML')}>
        <iframe title={title} sandbox="" referrerPolicy="no-referrer" srcDoc={content.srcDoc}
          aria-describedby={closeExpanded ? keyboardHelp : undefined} />
      </div>
      {closeExpanded && <button className="btn visual-keyboard-close" type="button" onClick={closeExpanded}>
        {tr('Cerrar vista HTML ampliada')}
      </button>}
    </>;
  }

  const width = content.width ?? 300;
  const height = content.height ?? 150;
  return <div className="visual-canvas visual-image" data-background={backdrop} data-fit={zoom === null}
    tabIndex={0} aria-label={tr('Área de la imagen')}>
    {failed ? <p className="visual-note" role="status">{tr('No se pudo mostrar la imagen. El código está disponible.')}</p> :
      <img src={content.src} alt={title} draggable={false} onError={() => setFailed(true)}
        width={width} height={height} style={zoom === null ? undefined : { width: Math.min(16_000, width * zoom) }} />}
  </div>;
}

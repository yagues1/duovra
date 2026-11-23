import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { VisualImage } from '../../lib/visual/types';
import { diagramScale, diagramScrollOffset, DIAGRAM_PADDING, type DiagramFit } from '../../lib/visual/diagramViewport';
import { tr } from '../../i18n';

interface ViewportSize { width: number; height: number }

export interface DiagramPosition {
  left: number;
  top: number;
  size: ViewportSize;
  scale: number;
  mode: DiagramFit | number;
}

export function MermaidCanvas({ image, title, mode, position, reportScale }: {
  image: VisualImage;
  title: string;
  mode: DiagramFit | number;
  position: RefObject<DiagramPosition | null>;
  reportScale: (scale: number) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const width = image.width ?? 300;
  const height = image.height ?? 150;
  const scale = diagramScale(mode, width, height, size.width, size.height);

  useLayoutEffect(() => {
    const box = viewport.current!;
    const measure = () => {
      const measured = { width: box.clientWidth, height: box.clientHeight };
      setSize((current) => current.width === measured.width && current.height === measured.height ? current : measured);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const box = viewport.current!;
    const previous = position.current;
    if (previous && (previous.mode === mode || typeof mode === 'number')) {
      box.scrollLeft = diagramScrollOffset(width, previous.left,
        { viewportSize: previous.size.width, scale: previous.scale }, { viewportSize: size.width, scale });
      box.scrollTop = diagramScrollOffset(height, previous.top,
        { viewportSize: previous.size.height, scale: previous.scale }, { viewportSize: size.height, scale });
    } else {
      box.scrollLeft = 0;
      box.scrollTop = 0;
    }
    position.current = { left: box.scrollLeft, top: box.scrollTop, size, mode, scale };
    reportScale(scale);
  }, [height, mode, position, reportScale, scale, size, width]);

  const endPan = () => {
    pan.current = null;
    viewport.current?.removeAttribute('data-panning');
  };

  return <div ref={viewport} className="visual-canvas mermaid-viewport" tabIndex={0} role="region" aria-label={tr('Área del diagrama')}
    onScroll={(event) => {
      const box = event.currentTarget;
      position.current = { left: box.scrollLeft, top: box.scrollTop, size, mode, scale };
    }}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || event.pointerType !== 'mouse') return;
      const box = event.currentTarget;
      if (event.clientX - box.getBoundingClientRect().left >= box.clientWidth ||
          event.clientY - box.getBoundingClientRect().top >= box.clientHeight) return;
      pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
      box.setPointerCapture(event.pointerId);
      box.setAttribute('data-panning', '');
    }}
    onPointerMove={(event) => {
      const drag = pan.current;
      if (drag?.id !== event.pointerId) return;
      event.currentTarget.scrollLeft = drag.left + drag.x - event.clientX;
      event.currentTarget.scrollTop = drag.top + drag.y - event.clientY;
    }}
    onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
    {failed ? <p className="visual-note" role="status">{tr('No se pudo mostrar el diagrama. El código está disponible.')}</p>
      : <div className="mermaid-sheet" style={{ padding: DIAGRAM_PADDING }}>
        <img src={image.src} alt={title} draggable={false} onError={() => setFailed(true)}
          width={width * scale} height={height * scale} />
      </div>}
  </div>;
}

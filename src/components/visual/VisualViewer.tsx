import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ExpandedVisual } from './ExpandedVisual';
import { CodeXml, Eye, Maximize2, Minimize2, Moon, RotateCw, Sun, X, ZoomIn, ZoomOut } from 'lucide-react';
import { CopyButton } from '../chat/Markdown';
import { VISUAL_LABEL, type VisualSource } from '../../lib/visual/types';
import { VisualCanvas, type ImageBackdrop, type Viewport } from './VisualCanvas';
import { useVisual } from './useVisual';
import { MermaidCanvas, type DiagramPosition } from './MermaidCanvas';
import type { DiagramFit } from '../../lib/visual/diagramViewport';

export default function VisualViewer({ source, title, path, initialPreview = true, reloadFile, truncated, codeBody, actions }: {
  source: VisualSource;
  title: string;
  path?: string;
  initialPreview?: boolean;
  reloadFile?: () => void;
  truncated?: boolean;
  codeBody?: ReactNode;
  actions?: ReactNode;
}) {
  const [preview, setPreview] = useState(initialPreview);
  const [wide, setWide] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoring = useRef(false);
  const collapse = () => {
    restoring.current = true;
    setWide(false);
  };
  useLayoutEffect(() => {
    if (!wide && restoring.current) {
      restoring.current = false;
      expandButton.current?.focus({ preventScroll: true });
    }
  }, [wide]);
  const [zoom, setZoom] = useState<number | null>(null);
  const [diagramMode, setDiagramMode] = useState<DiagramFit | number>('auto');
  const [diagramZoom, setDiagramZoom] = useState(1);
  const diagramPosition = useRef<DiagramPosition | null>(null);
  const [viewport, setViewport] = useState<Viewport>('fit');
  const [backdrop, setBackdrop] = useState<ImageBackdrop>('dark');
  const [revision, setRevision] = useState(0);
  const result = useVisual(source.kind, source.text, preview && !truncated, revision);
  const content = result?.content;
  const image = content?.type === 'image' ? content : undefined;
  const diagram = source.kind === 'mermaid' ? image : undefined;
  const dimensions = source.kind === 'svg' && image?.width && image.height ? Math.round(image.width) + ' × ' + Math.round(image.height) : undefined;
  const reload = () => {
    reloadFile?.();
    setRevision((value) => value + 1);
  };
  const changeZoom = (button: HTMLButtonElement, factor: number) => {
    if (diagram) {
      setDiagramMode(diagramZoom * factor);
      return;
    }
    const img = button.closest('.visual-viewer')?.querySelector('img');
    const scale = zoom ?? (img && image?.width ? img.clientWidth / image.width : 1);
    setZoom(Math.min(4, Math.max(0.05, scale * factor)));
  };

  const view = <div className="visual-viewer" data-kind={source.kind} data-expanded={wide || undefined}>
    <div className="visual-title">
      <div className="min-w-0">
        <h3 className="truncate" title={title}>{title}</h3>
        <p className="truncate" title={path}>{VISUAL_LABEL[source.kind]}{dimensions ? ' · ' + dimensions : ''}{path && path !== title ? ' · ' + path : ''}</p>
      </div>
      <div className="visual-title-actions">
        {actions}
        <CopyButton text={source.text} label={'Copiar ' + VISUAL_LABEL[source.kind]} />
        {(source.kind === 'html' || reloadFile) && <button className="btn-icon" type="button" aria-label={reloadFile ? 'Recargar archivo' : 'Recargar HTML'}
          onClick={reload} data-tip={reloadFile ? 'Recargar archivo' : 'Recargar HTML'}><RotateCw size={14} aria-hidden /></button>}
        {!wide && <button ref={expandButton} className="btn-icon" type="button" onClick={() => setWide(true)} aria-label="Ampliar vista" data-tip="Ampliar vista"><Maximize2 size={15} aria-hidden /></button>}
        {wide && <button className="btn-icon" type="button" onClick={collapse} aria-label="Cerrar vista ampliada" data-tip="Cerrar vista ampliada"><X size={17} aria-hidden /></button>}
      </div>
    </div>
    <div className="visual-tools">
      <button type="button" className="visual-mode" onClick={() => setPreview(false)} aria-pressed={!preview}><CodeXml size={14} aria-hidden /> Código</button>
      <button type="button" className="visual-mode" onClick={() => setPreview(true)} aria-pressed={preview}><Eye size={14} aria-hidden /> {source.kind === 'mermaid' ? 'Diagrama' : 'Vista previa'}</button>
      {preview && image && <>
        <button className="btn-icon" type="button" onClick={(event) => changeZoom(event.currentTarget, 0.8)} aria-label="Reducir zoom" data-tip="Reducir zoom"><ZoomOut size={15} aria-hidden /></button>
        <button className="btn-icon" type="button" onClick={(event) => changeZoom(event.currentTarget, 1.25)} aria-label="Aumentar zoom" data-tip="Aumentar zoom"><ZoomIn size={15} aria-hidden /></button>
        {diagram ? <>
          <button className="visual-mode" type="button" onClick={() => setDiagramMode('view')} aria-pressed={diagramMode === 'view'}>Ajustar a vista</button>
          <button className="visual-mode" type="button" onClick={() => setDiagramMode('width')} aria-pressed={diagramMode === 'width'}>Ajustar a anchura</button>
          <button className="visual-mode" type="button" onClick={() => setDiagramMode('actual')} aria-pressed={diagramMode === 'actual'}>Escala real</button>
          <output className="visual-scale" aria-label="Nivel de zoom">{Math.round(diagramZoom * 100)} %</output>
        </> : <>
          <button className="btn-icon" type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null} aria-label="Ajustar al espacio" data-tip="Ajustar al espacio"><Minimize2 size={14} aria-hidden /></button>
          {zoom !== null && <output className="visual-scale" aria-label="Nivel de zoom">{Math.round(zoom * 100)} %</output>}
        </>}
        {source.kind === 'svg' && <button className="btn-icon" type="button" onClick={() => setBackdrop((value) => value === 'dark' ? 'light' : 'dark')}
          aria-pressed={backdrop === 'light'} aria-label="Fondo claro" data-tip="Fondo claro">{backdrop === 'dark' ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}</button>}
      </>}
      {preview && content?.type === 'document' && <select className="visual-viewport" aria-label="Anchura de la vista HTML" value={viewport} onChange={(event) => setViewport(event.currentTarget.value as Viewport)}>
        <option value="fit">Ajustar</option><option value="mobile">390 px</option><option value="desktop">1024 px</option>
      </select>}
    </div>
    {preview && !content && <p className="visual-note selectable" role="status">
      {truncated ? 'El archivo supera el límite de lectura. Puedes consultar el código disponible.' : result?.error ?? 'Preparando vista previa…'}
    </p>}
    {preview && !truncated && diagram ? <MermaidCanvas image={diagram} title={title} mode={diagramMode} position={diagramPosition} reportScale={setDiagramZoom} />
      : preview && !truncated && content ? <VisualCanvas key={revision} content={content} title={title} zoom={zoom}
        viewport={viewport} backdrop={backdrop} closeExpanded={wide ? collapse : undefined} /> : (
      <div className="visual-source selectable" tabIndex={0} aria-label="Código fuente">{codeBody ?? <pre><code>{source.text}</code></pre>}</div>
    )}
  </div>;

  return wide ? <ExpandedVisual title={title} close={collapse}>{view}</ExpandedVisual> : view;
}

import { createContext, lazy, memo, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, CodeXml, Copy, Eye, Maximize, Maximize2, Network, PanelRightOpen } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { highlight } from '../../lib/highlight';
import { useStore } from '../../state/store';
import { basename, relativeTo } from '../../lib/format';

import { fenceComplete, visualFile, visualLanguage } from '../../lib/visual/types';
import { useVisual } from '../visual/useVisual';
import { openVisualTab } from '../../lib/visual/tabs';
import { WIDGET_LANGUAGE } from '../../lib/widgets/view';
import { tr, useTr } from '../../i18n';

const InteractiveFence = lazy(() => import('../widgets/InteractiveFence'));

const PATH_RE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?$/;

/** Abre un archivo citado en la respuesta en el panel de consulta. */
export function openFileTab(path: string, line?: number, preview = false) {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.id === s.activeProjectId);
  if (!project) return;
  const file = relativeTo(path, project.path);
  s.openTab({ id: `file:${file}`, kind: 'file', title: basename(file), payload: { path: file, projectId: project.id, line, preview } });
}

export function CopyButton({ text, label = tr('Copiar'), announcement }: { text: string; label?: string; announcement?: string }) {
  const [done, setDone] = useState(false);
  return <>
    <button
      className="btn-icon"
      type="button"
      style={{ width: 26, height: 26 }}
      aria-label={label}
      data-tip={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }, () => useStore.getState().toast(tr('No se pudo copiar al portapapeles'), 'error'));
      }}
    >
      {done ? <Check size={13} style={{ color: 'var(--success)' }} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
    {announcement && <span className="sr-only" role="status">{done ? announcement : ''}</span>}
  </>;
}

const LANG_NAME: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', typescript: 'TypeScript', js: 'JavaScript', jsx: 'JSX', javascript: 'JavaScript',
  py: 'Python', python: 'Python', rs: 'Rust', rust: 'Rust', sh: 'Shell', bash: 'Bash', shell: 'Shell', ps1: 'PowerShell',
  powershell: 'PowerShell', json: 'JSON', css: 'CSS', html: 'HTML', md: 'Markdown', sql: 'SQL', yaml: 'YAML', yml: 'YAML',
  mermaid: 'Mermaid', svg: 'SVG', go: 'Go', java: 'Java', cs: 'C#', csharp: 'C#', cpp: 'C++', c: 'C', diff: 'Diff', toml: 'TOML',
};

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="code-copy"
      aria-label={tr('Copiar código')}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <Check size={12} style={{ color: 'var(--success)' }} /> : <Copy size={12} />}
      {done ? tr('Copiado') : tr('Copiar')}
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, lang, actions, body, pending = false }: { code: string; lang?: string; actions?: ReactNode; body?: ReactNode; pending?: boolean }) {
  useTr();
  const html = useMemo(() => body || pending ? null : highlight(code, lang), [body, code, lang, pending]);
  const lines = useMemo(() => code.split('\n').length, [code]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang ? (LANG_NAME[lang.toLowerCase()] ?? lang) : 'Texto'}</span>
        {lines > 1 && <span className="code-lines">{tr('{n} líneas', { n: lines })}</span>}
        {actions}
        <CopyText text={code} />
      </div>
      {body ?? <pre className="selectable">
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>}
    </div>
  );
});

function useNearFence(complete: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const anchor = ref.current;
    if (!anchor || !complete || near) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setNear(true);
    }, { rootMargin: '120px' });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [complete, near]);
  return { ref, near };
}

function MermaidFence({ code, complete }: { code: string; complete: boolean }) {
  const { ref, near } = useNearFence(complete);
  const [source, setSource] = useState(false);
  const [fit, setFit] = useState(true);
  const result = useVisual('mermaid', code, near && complete);
  const image = complete && result?.content?.type === 'image' ? result.content : undefined;
  const showing = !!image && !source;
  const error = complete ? result?.error : undefined;
  const actions = image && <>
    <button className="code-copy" type="button" aria-pressed={source} onClick={() => setSource((value) => !value)}>
      {source ? <Network size={13} aria-hidden /> : <CodeXml size={13} aria-hidden />}
      {source ? tr('Diagrama') : tr('Código')}
    </button>
    {showing && <button className="code-copy" type="button" aria-label={tr('Ajustar diagrama')} aria-pressed={fit} onClick={() => setFit((value) => !value)}>
      <Maximize size={13} aria-hidden />
    </button>}
    <button className="code-copy" type="button" aria-label={tr('Ampliar diagrama en Workbench')} data-tip={tr('Ampliar diagrama en Workbench')}
      onClick={() => openVisualTab({ kind: 'mermaid', text: code }, 'Diagrama Mermaid')}>
      <Maximize2 size={13} aria-hidden />
    </button>
  </>;
  return <div ref={ref} data-visual-kind="mermaid" data-stream-pending={!complete || undefined}>
    {error && <p role="status" className="visual-note selectable">{tr('No se pudo dibujar el diagrama.')} {error}</p>}
    <CodeBlock code={code} lang="mermaid" actions={actions} body={showing && image ? (
      <div className="visual-inline" data-fit={fit} tabIndex={0} aria-label={tr('Área del diagrama')}>
        <img src={image.src} width={image.width ?? undefined} height={image.height ?? undefined}
          alt={tr('Diagrama Mermaid. El código está disponible en este bloque.')} draggable={false} />
      </div>
    ) : undefined} />
  </div>;
}

const widgetLoading = () => <p className="visual-note" role="status">{tr('Preparando vista interactiva…')}</p>;

function WidgetMount({ source, complete, streaming }: { source: string; complete: boolean; streaming: boolean }) {
  const { ref, near } = useNearFence(complete);
  return <div ref={ref} className="widget-mount" data-visual-kind="widget" data-stream-pending={!complete && streaming || undefined}>
    {complete ? near ? <Suspense fallback={widgetLoading()}><InteractiveFence source={source} /></Suspense> : widgetLoading()
      : streaming ? <p className="visual-note">{tr('Esperando el cierre de la vista interactiva…')}</p>
      : <CodeBlock code={source} lang={WIDGET_LANGUAGE} body={<>
          <p className="visual-note" role="status">{tr('La vista interactiva necesita una cerca de cierre.')}</p>
          <pre className="selectable"><code>{source}</code></pre>
        </>} />}
  </div>;
}

const MarkdownSource = createContext({ text: '', streaming: false });
const MarkdownCode: NonNullable<Components['code']> = ({ className, children, node }) => {
  const source = useContext(MarkdownSource);
  const text = String(children ?? '');
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
  if (lang || text.includes('\n')) {
    const code = text.replace(/\n$/, '');
    const kind = visualLanguage(lang);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const confirmed = start != null && end != null && fenceComplete(source.text, start, end, source.streaming);
    if (className?.split(/\s/, 1)[0] === 'language-' + WIDGET_LANGUAGE) {
      return <WidgetMount source={code} complete={confirmed} streaming={source.streaming} />;
    }
    const complete = !source.streaming || confirmed;
    if (kind === 'mermaid') return <MermaidFence code={code} complete={complete} />;
    return <CodeBlock code={code} lang={lang} pending={!complete} actions={kind && complete && (
      <button className="code-copy" type="button" onClick={() => openVisualTab({ kind, text: code })}>
        <Eye size={13} aria-hidden /> Vista previa
      </button>
    )} />;
  }
  const m = PATH_RE.exec(text.trim());
  if (m && /[\\/.]/.test(text)) {
    const [path, line] = text.trim().split(/:(?=\d+$)/);
    return (
      <button type="button" className="file-ref" data-tip={tr('Abrir en Workbench')} onClick={() => openFileTab(path, line ? Number(line) : undefined, !line && !!visualFile(path))}>
        <code>{text}<PanelRightOpen size={11} className="ml-1 inline align-[-1px] opacity-70" aria-hidden /></code>
      </button>
    );
  }
  return <code>{children}</code>;
};

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: MarkdownCode,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:/.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Un Markdown largo se vuelve a analizar desde el principio. Los deltas breves y el texto final
  // salen directamente. Para un bloque largo en curso, publica la última versión cada 48 ms.
  const batch = streaming && text.length >= 4096;
  const latest = useRef(text);
  const [sample, setSample] = useState<string | null>(null);
  const shown = batch ? sample ?? text : text;
  useLayoutEffect(() => { latest.current = text; }, [text]);
  const pending = batch && text !== sample;
  useEffect(() => {
    if (!batch) {
      setSample(null);
      return;
    }
    if (!pending) return;
    const timer = window.setTimeout(() => setSample(latest.current), 48);
    return () => window.clearTimeout(timer);
  }, [batch, pending, sample]);
  return <MarkdownBody text={shown} streaming={streaming} />;
});

const markdownPlugins = [remarkGfm];
const MarkdownBody = memo(function MarkdownBody({ text, streaming }: { text: string; streaming: boolean }) {
  useTr();
  const source = useMemo(() => ({ text, streaming }), [text, streaming]);
  return (
    <div className="md">
      <MarkdownSource.Provider value={source}>
        <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
          {text}
        </ReactMarkdown>
      </MarkdownSource.Provider>
    </div>
  );
});

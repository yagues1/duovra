import { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, PanelRightOpen } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { highlight } from '../../lib/highlight';
import { useStore } from '../../state/store';
import { basename } from '../../lib/format';

const PATH_RE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?$/;

/** Abre un archivo citado en la respuesta en el panel de consulta. */
export function openFileTab(path: string, line?: number) {
  const s = useStore.getState();
  const root = s.projects.find((p) => p.id === s.activeProjectId)?.path;
  s.openTab({ id: `file:${path}`, kind: 'file', title: basename(path), payload: { path, root, line } });
}

export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-icon"
      style={{ width: 26, height: 26 }}
      aria-label={label}
      data-tip={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? 'texto'}</span>
        <CopyButton text={code} label="Copiar código" />
      </div>
      <pre className="selectable">
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
});

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
    if (lang || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />;
    const m = PATH_RE.exec(text.trim());
    if (m && /[\\/.]/.test(text)) {
      const [path, line] = text.trim().split(/:(?=\d+$)/);
      return (
        <code className="file-ref" role="button" tabIndex={0} data-tip="Abrir en el panel" onClick={() => openFileTab(path, line ? Number(line) : undefined)}>
          {text}
          <PanelRightOpen size={11} className="ml-1 inline align-[-1px] opacity-60" />
        </code>
      );
    }
    return <code>{children}</code>;
  },
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

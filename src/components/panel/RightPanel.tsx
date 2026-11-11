import { AnimatePresence, motion } from 'motion/react';
import { FileCode2, FileDiff, FolderOpen, Info, SquareTerminal, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useStore, type PanelTab } from '../../state/store';
import { api, errorText } from '../../lib/ipc';
import { highlight, escapeHtml } from '../../lib/highlight';
import { asText, basename, displayCommand, langFromPath, relativeTo } from '../../lib/format';
import { diffStats, firstChangedLine, type DiffLine } from '../../lib/diff';
import type { FileChange, TimelineItem } from '../../lib/types';
import { CopyButton } from '../chat/Markdown';
import { changeLines } from '../chat/TimelineItems';

const ICON = { file: FileCode2, diff: FileDiff, terminal: SquareTerminal, details: Info };

/**
 * Panel contextual derecho: consulta de archivos, diffs, salidas de terminal y detalles.
 * Oculto por defecto; se abre desde la conversación. No es un editor.
 */
export function RightPanel({ mode }: { mode: 'inline' | 'overlay' }) {
  const panel = useStore((s) => s.panel);
  const close = useStore((s) => s.closePanel);
  const closeTab = useStore((s) => s.closeTab);
  const setActive = useStore((s) => s.setActiveTab);
  const tab = panel.tabs.find((t) => t.id === panel.active);
  const open = panel.open && !!tab;

  const tabs = (
    <div className="panel-head">
      <div className="panel-tabs" role="tablist" aria-label="Pestañas del panel">
        {panel.tabs.map((t) => {
          const Icon = ICON[t.kind];
          const on = t.id === panel.active;
          return (
            <div
              key={t.id}
              role="tab"
              tabIndex={on ? 0 : -1}
              aria-selected={on}
              className="panel-tab"
              data-on={on || undefined}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => {
                const i = panel.tabs.findIndex((x) => x.id === t.id);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = panel.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + panel.tabs.length) % panel.tabs.length];
                  const list = e.currentTarget.parentElement;
                  setActive(next.id);
                  requestAnimationFrame(() => list?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
                } else if (e.key === 'Delete') closeTab(t.id);
              }}
            >
              {on && <motion.span layoutId="panel-tab-pill" className="panel-tab-pill" transition={{ type: 'spring', bounce: 0.24, duration: 0.42 }} />}
              <Icon size={13} className="relative shrink-0" />
              <span className="relative max-w-[140px] truncate" data-tip={t.title} data-tip-truncated data-tip-side="bottom">{t.title}</span>
              <button
                className="panel-tab-close"
                tabIndex={-1}
                aria-label={`Cerrar ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="btn-icon" aria-label="Cerrar panel" data-tip="Cerrar panel (Esc)" data-tip-side="bottom" onClick={close}>
        <X size={15} />
      </button>
    </div>
  );

  const body = tab && (
    <div className="min-h-0 w-[var(--panel-w)] flex-1 overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab.id}
          className="h-full"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <TabBody tab={tab} />
        </motion.div>
      </AnimatePresence>
    </div>
  );

  if (mode === 'overlay')
    return (
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="panel-scrim"
              className="panel-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onPointerDown={close}
              aria-hidden
            />
            <motion.aside
              key="panel-overlay"
              className="mat-primary right-panel right-panel-overlay flex flex-col overflow-hidden"
              initial={{ x: '104%' }}
              animate={{ x: 0 }}
              exit={{ x: '104%', transition: { type: 'spring', bounce: 0, duration: 0.3 } }}
              transition={{ type: 'spring', bounce: 0.16, duration: 0.46 }}
              aria-label="Panel de detalles"
            >
              {tabs}
              {body}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    );

  // En línea: el panel crece desde su borde derecho (mismo camino al cerrar).
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          key="panel"
          className="mat-primary right-panel relative z-20 my-2.5 mr-2.5 flex shrink-0 flex-col overflow-hidden"
          initial={{ width: 0 }}
          animate={{ width: 'var(--panel-w)' }}
          exit={{ width: 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.42 }}
          aria-label="Panel de detalles"
        >
          <div className="flex min-h-0 w-[var(--panel-w)] flex-1 flex-col">
            {tabs}
            {body}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function TabBody({ tab }: { tab: PanelTab }) {
  switch (tab.kind) {
    case 'file':
      return <FileView path={tab.payload.path as string} root={tab.payload.root as string | undefined} line={tab.payload.line as number | undefined} />;
    case 'diff':
      return <DiffView change={tab.payload.change as FileChange} root={tab.payload.root as string | undefined} />;
    case 'terminal':
      return <TerminalView item={tab.payload.item as TimelineItem} />;
    default:
      return <DetailsView data={tab.payload} />;
  }
}

function Toolbar({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" style={{ color: 'var(--text-strong)' }} data-tip={title} data-tip-truncated data-tip-side="bottom">
          {title}
        </div>
        {sub && <div className="truncate font-mono text-[11px] faint" data-tip={sub} data-tip-truncated data-tip-side="bottom">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

const CHUNK = 200;

const CodeLines = memo(function CodeLines({ text, lang, mark }: { text: string; lang?: string; mark?: number }) {
  const lines = useMemo(() => text.replace(/\r\n/g, '\n').split('\n'), [text]);
  const html = useMemo(
    () => lines.map((l) => (lines.length <= 4000 ? (highlight(l, lang) ?? escapeHtml(l)) : escapeHtml(l))),
    [lines, lang],
  );
  const chunks = useMemo(() => {
    const c: number[] = [];
    for (let i = 0; i < lines.length; i += CHUNK) c.push(i);
    return c;
  }, [lines]);
  return (
    <div className="code-view selectable">
      {chunks.map((start) => (
        <div key={start} className="code-chunk" style={{ containIntrinsicSize: `auto ${Math.min(CHUNK, lines.length - start) * 19}px` }}>
          {html.slice(start, start + CHUNK).map((h, i) => {
            const n = start + i + 1;
            return (
              <div key={n} className="code-line" data-mark={mark && Math.abs(n - mark) <= 0 ? true : undefined} data-line={n}>
                <span className="code-no">{n}</span>
                <span className="code-text" dangerouslySetInnerHTML={{ __html: h || ' ' }} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
});

function FileView({ path, root, line }: { path: string; root?: string; line?: number }) {
  const [state, setState] = useState<{ content: string; size: number; truncated: boolean; binary: boolean; path: string } | { error: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    api.readFile(path, root).then(
      (r) => alive && setState(r),
      (e) => alive && setState({ error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [path, root]);
  useEffect(() => {
    if (!line || !state || 'error' in state) return;
    requestAnimationFrame(() => box.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' }));
  }, [state, line]);
  const full = state && !('error' in state) ? state.path : path;
  return (
    <div className="flex h-full flex-col">
      <Toolbar title={basename(path)} sub={relativeTo(full, root)}>
        {state && !('error' in state) && <CopyButton text={state.content} label="Copiar contenido" />}
        <button className="btn-icon" aria-label="Mostrar en el Explorador" data-tip="Mostrar en el Explorador" onClick={() => void revealItemInDir(full)}>
          <FolderOpen size={14} />
        </button>
      </Toolbar>
      <div ref={box} className="min-h-0 flex-1 overflow-auto">
        {!state && <div className="p-4 text-[13px] muted">Cargando…</div>}
        {state && 'error' in state && <div className="p-4 text-[13px]" style={{ color: 'var(--danger)' }}>{state.error}</div>}
        {state && !('error' in state) &&
          (state.binary ? (
            <div className="p-4 text-[13px] muted">Archivo binario ({state.size} bytes): no se muestra.</div>
          ) : (
            <>
              {state.truncated && <div className="px-4 pb-2 text-[12px]" style={{ color: 'var(--warning)' }}>Vista limitada al primer MB del archivo.</div>}
              <CodeLines text={state.content} lang={langFromPath(path)} mark={line} />
            </>
          ))}
      </div>
    </div>
  );
}

function DiffRows({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff-view selectable">
      {lines.map((l, i) =>
        l.type === 'hunk' || l.type === 'meta' ? (
          <div key={i} className="diff-line" data-type={l.type}>
            <span className="code-no" />
            <span className="code-no" />
            <span className="code-text">{l.text}</span>
          </div>
        ) : (
          <div key={i} className="diff-line" data-type={l.type}>
            <span className="code-no">{l.oldNo ?? ''}</span>
            <span className="code-no">{l.newNo ?? ''}</span>
            <span className="code-text">
              <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              {l.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

function DiffView({ change, root }: { change: FileChange; root?: string }) {
  const lines = useMemo(() => changeLines(change), [change]);
  const st = diffStats(lines);
  const text = change.diff ?? lines.map((l) => ('oldNo' in l ? (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') : '') + l.text).join('\n');
  const isFile = !change.path.startsWith('Diff completo');
  return (
    <div className="flex h-full flex-col">
      <Toolbar title={basename(change.path)} sub={relativeTo(change.path, root)}>
        <span className="text-[12px]" style={{ color: 'var(--success)' }}>+{st.added}</span>
        <span className="text-[12px]" style={{ color: 'var(--danger)' }}>−{st.removed}</span>
        <CopyButton text={text} label="Copiar diff" />
        {isFile && (
          <button
            className="btn h-7 px-3 text-[12px]"
            onClick={() =>
              useStore.getState().openTab({
                id: `file:${change.path}`,
                kind: 'file',
                title: basename(change.path),
                payload: { path: change.path, root, line: firstChangedLine(lines) ?? undefined },
              })
            }
          >
            Ver archivo
          </button>
        )}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto">
        {lines.length ? <DiffRows lines={lines} /> : <div className="p-4 text-[13px] muted">Sin diferencias de texto que mostrar.</div>}
      </div>
    </div>
  );
}

function TerminalView({ item }: { item: TimelineItem }) {
  // La salida en vivo se lee del almacén para que el panel se actualice mientras corre.
  const live = useStore((s) => {
    for (const r of Object.values(s.runs)) {
      const it = r.items.find((x) => x.id === item.id);
      if (it) return it;
    }
    return null;
  });
  const it = live ?? item;
  const out = it.output ?? '';
  return (
    <div className="flex h-full flex-col">
      <Toolbar title={it.description || 'Comando'} sub={it.cwd ?? undefined}>
        {it.exitCode != null && (
          <span className="chip" style={{ color: it.exitCode === 0 ? 'var(--success)' : 'var(--danger)' }}>
            exit {it.exitCode}
          </span>
        )}
        <CopyButton text={`${it.command ?? ''}\n${out}`} label="Copiar comando y salida" />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        <pre className="term-cmd selectable">{displayCommand(it.command)}</pre>
        {displayCommand(it.command) !== it.command && <div className="mb-2 font-mono text-[11px] faint selectable">Comando original: {it.command}</div>}
        <pre className="term-out mat-reading selectable">{out || (it.status === 'running' ? 'Esperando salida…' : 'Sin salida.')}</pre>
      </div>
    </div>
  );
}

function DetailsView({ data }: { data: Record<string, unknown> }) {
  const text = asText(data);
  return (
    <div className="flex h-full flex-col">
      <Toolbar title="Detalles">
        <CopyButton text={text} />
      </Toolbar>
      <pre className="term-out mat-reading selectable mx-4 mb-4 min-h-0 flex-1 overflow-auto">{text}</pre>
    </div>
  );
}

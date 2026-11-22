import { motion } from 'motion/react';
import { Activity, FileCode2, FileDiff, FolderOpen, GitBranch, GitCompareArrows, Info, PanelsTopLeft, ScanEye, SquareTerminal, X, PanelTopClose } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useStore, type PanelTab } from '../../state/store';
import { api, errorText, type GitScope, type WorkspaceDocument } from '../../lib/ipc';
import { highlight, escapeHtml } from '../../lib/highlight';
import { asText, basename, displayCommand, langFromPath, relativeTo } from '../../lib/format';
import { diffStats, firstChangedLine, parseUnified, type DiffLine } from '../../lib/diff';
import type { FileChange, TimelineItem } from '../../lib/types';
import { CopyButton, openFileTab } from '../chat/Markdown';
import { changeLines } from '../chat/TimelineItems';
import { ChangesSummary } from '../chat/Messages';

import { RefreshButton, WorkspaceFiles, WorkspaceGit, useWorkspaceQuery } from './WorkspaceViews';
import { ActivityPanel } from './TurnInsights';
import { visualFile } from '../../lib/visual/types';
import { ExpandedVisualState } from '../visual/ExpandedVisual';

const VisualViewer = lazy(() => import('../visual/VisualViewer'));
const WidgetViewer = lazy(() => import('../widgets/WidgetViewer'));
const loadingVisual = <p className="workspace-note" role="status">Abriendo visor…</p>;

const ICON = { file: FileCode2, diff: FileDiff, terminal: SquareTerminal, details: Info, gitDiff: GitBranch, visual: ScanEye, widget: PanelsTopLeft, files: FolderOpen, git: GitCompareArrows, activity: Activity };

/** Vistas de consulta del contexto de la conversación y de los elementos que se abren en ella. */
export function RightPanel({ mode }: { mode: 'inline' | 'overlay' }) {
  const panel = useStore((s) => s.panel);
  const close = useStore((s) => s.closePanel);
  const closeTab = useStore((s) => s.closeTab);
  const setActive = useStore((s) => s.setActiveTab);
  const tab = panel.tabs.find((t) => t.id === panel.active);
  const projectId = useStore((s) => s.activeProjectId);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const shell = dialog.current;
    if (!panel.open || !shell) return;
    const origin = document.activeElement;
    return () => {
      shell.close();
      if (origin instanceof HTMLElement && origin !== document.body && origin.isConnected && !shell.contains(origin)) origin.focus({ preventScroll: true });
      else document.getElementById('workbench-toggle')?.focus({ preventScroll: true });
    };
  }, [panel.open]);

  useLayoutEffect(() => {
    const shell = dialog.current;
    // Promover Workbench a modal aquí pondría su diálogo encima de la vista ampliada.
    if (!panel.open || !shell || expanded) return;
    const modal = mode === 'overlay';
    if (shell.open && shell.matches(':modal') === modal) return;
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && shell.contains(active) ? active : closeButton.current;
    shell.close();
    if (modal) shell.showModal();
    else shell.show();
    focus?.focus({ preventScroll: true });
  }, [expanded, mode, panel.open]);

  useLayoutEffect(() => {
    if (panel.open && document.activeElement === document.body) {
      tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }, [panel.open, tab?.id]);

  const focusActive = () => requestAnimationFrame(() => tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  // Tres vistas fijas (qué hizo el agente, qué archivos hay, qué ha cambiado) y, separadas, las
  // pestañas abiertas desde la conversación (archivos, diffs, salidas y vistas).
  const tabOptions = [
    { id: null, title: 'Actividad', kind: 'activity' as const },
    { id: 'files', title: 'Archivos', kind: 'files' as const },
    { id: 'git', title: 'Cambios', kind: 'git' as const },
    ...panel.tabs,
  ];

  const contents = (
    <>
      <div className="panel-head">
        <h2 id={id + '-title'} className="panel-title">Workbench</h2>
        <div className="flex items-center gap-1">
          {tab && <button className="btn-icon" aria-label={`Cerrar pestaña ${tab.title}`} data-tip="Cerrar pestaña" onClick={() => { closeTab(tab.id); focusActive(); }}>
            <PanelTopClose size={14} aria-hidden />
          </button>}
          <button ref={closeButton} className="btn-icon" aria-label="Cerrar Workbench" data-tip="Cerrar Workbench (Esc)" onClick={close}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div ref={tabList} className="panel-tabs" role="tablist" aria-label="Vistas de Workbench">
        {tabOptions.map((item, i) => {
          const Icon = ICON[item.kind];
          const on = item.id === panel.active;
          const opened = 'payload' in item;
          return (
            <button
              key={item.id ?? 'overview'}
              id={`${id}-tab-${i}`}
              role="tab"
              tabIndex={on ? 0 : -1}
              aria-selected={on}
              aria-description={'payload' in item && 'path' in item.payload
                ? item.kind === 'gitDiff' ? `Diff Git · ${GIT_VIEW[item.payload.scope as GitScope]} · ${item.payload.path}` : String(item.payload.path)
                : item.kind === 'diff' ? 'Diff del turno del agente' : undefined}
              aria-controls={`${id}-view`}
              className="panel-tab"
              data-opened={opened || undefined}
              data-first-opened={opened && i === 3 || undefined}
              onClick={() => setActive(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Delete' && 'payload' in item) {
                  event.preventDefault();
                  closeTab(item.id);
                  focusActive();
                  return;
                }
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabOptions.length - 1
                  : offset ? (i + offset + tabOptions.length) % tabOptions.length : -1;
                if (next < 0) return;
                event.preventDefault();
                setActive(tabOptions[next].id);
                focusActive();
              }}
            >
              <Icon size={13} aria-hidden />
              <span className="max-w-[140px] truncate" title={item.title}>{item.title}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" id={id + '-view'} role="tabpanel"
        aria-labelledby={`${id}-tab-${Math.max(0, tabOptions.findIndex((item) => item.id === panel.active))}`} tabIndex={0}>
        {projectId && <WorkspacePane key={projectId} projectId={projectId} active={panel.active} />}
        {tab ? <TabBody key={tab.id} tab={tab} /> : panel.active === null ? <ActivityPanel /> :
          !projectId && <p className="workspace-note">Selecciona un proyecto.</p>}
      </div>
    </>
  );

  if (!panel.open) return null;
  return (
    <motion.dialog ref={dialog} id="workbench" className="right-panel relative z-20 flex shrink-0 flex-col overflow-hidden"
      aria-labelledby={id + '-title'} initial={mode === 'inline' ? { opacity: 0 } : false}
      animate={{ opacity: 1 }} transition={{ duration: 0.16 }}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget && event.currentTarget.matches(':modal')) close(); }}>
      <ExpandedVisualState value={setExpanded}>{contents}</ExpandedVisualState>
    </motion.dialog>
  );
}

function WorkspacePane({ projectId, active }: { projectId: string; active: string | null }) {
  const [revision, setRevision] = useState(0);
  const busy = useStore((s) => Object.keys(s.runs).some((id) => s.conversations.some((c) => c.id === id && c.projectId === projectId)));
  const read = useMemo(() => () => api.gitStatus(projectId), [projectId]);
  const result = useWorkspaceQuery(read, revision);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setRevision((n) => n + 1);
    wasBusy.current = busy;
  }, [busy]);
  const visible = active === 'files' || active === 'git';
  return <div hidden={!visible} className="workspace-pane">
    <div hidden={active !== 'files'} className="workspace-pane">
      <WorkspaceFiles projectId={projectId} git={result.data} refreshGit={() => setRevision((n) => n + 1)} />
    </div>
    {active === 'git' && <WorkspaceGit projectId={projectId} result={result} refresh={() => setRevision((n) => n + 1)} agentChanges={<LatestChanges />} />}
  </div>;
}

/** Cambios del último turno con modificaciones de la conversación activa (lo que hizo el agente). */
function LatestChanges() {
  const latest = useStore(useShallow((s) => {
    const id = s.activeConversationId;
    if (!id) return undefined;
    const live = s.runs[id];
    if (live?.items.some(hasChanges)) return { items: live.items, agent: live.agent, live: true };
    const message = s.messages[id]?.findLast((m) => m.role === 'assistant' && m.items?.some(hasChanges));
    return message?.items ? { items: message.items, agent: message.agent, live: false } : undefined;
  }));
  if (!latest) return null;
  return <section className="workspace-agent-changes" aria-label="Cambios del agente">
    <h4>{latest.live ? 'Cambios del turno en curso' : 'Cambios del último turno'}{latest.agent ? ` · ${latest.agent === 'claude' ? 'Claude Code' : 'Codex'}` : ''}</h4>
    <ChangesSummary items={latest.items} />
  </section>;
}

function hasChanges(item: TimelineItem) {
  return item.kind === 'diff' && !!item.diff || item.kind === 'file_change' && item.status === 'completed' && !!item.changes?.length;
}

function TabBody({ tab }: { tab: PanelTab }) {
  switch (tab.kind) {
    case 'file':
      return <FileView path={String(tab.payload.path)} projectId={String(tab.payload.projectId)}
        line={tab.payload.line as number | undefined} initialPreview={tab.payload.preview === true} />;
    case 'visual':
      return <Suspense fallback={loadingVisual}><VisualViewer source={tab.payload.source} title={tab.title} /></Suspense>;
    case 'widget':
      return <Suspense fallback={loadingVisual}><WidgetViewer view={tab.payload.view} /></Suspense>;
    case 'gitDiff':
      return <GitDiffView projectId={String(tab.payload.projectId)} path={String(tab.payload.path)} scope={tab.payload.scope as GitScope} />;
    case 'diff':
      return <DiffView change={tab.payload.change as FileChange} root={tab.payload.root as string | undefined} />;
    case 'terminal':
      return <TerminalView item={tab.payload.item as TimelineItem}
        conversationId={tab.payload.conversationId as string | undefined}
        messageId={tab.payload.messageId as string | undefined} />;
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
const MAX_LINES = 6_000;

const CodeLines = memo(function CodeLines({ text, lang, mark }: { text: string; lang?: string; mark?: number }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!mark) return;
    body.current?.querySelector('[data-line="' + mark + '"]')?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [mark]);
  const lines = useMemo(() => text.replace(/\r\n/g, '\n').split('\n'), [text]);
  const html = useMemo(
    () => lines.slice(0, MAX_LINES).map((l) => (lines.length <= 4000 && l.length <= 4000 ? (highlight(l, lang) ?? escapeHtml(l)) : escapeHtml(l))),
    [lines, lang],
  );
  const chunks = useMemo(() => {
    const c: number[] = [];
    for (let i = 0; i < Math.min(lines.length, MAX_LINES); i += CHUNK) c.push(i);
    return c;
  }, [lines]);
  return (
    <div ref={body} className="code-view selectable">
      {lines.length > MAX_LINES && <p className="workspace-note">Se muestran las primeras {MAX_LINES} líneas.</p>}
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

function FileView({ path, projectId, line, initialPreview }: { path: string; projectId: string; line?: number; initialPreview?: boolean }) {
  const [state, setState] = useState<WorkspaceDocument | { error: string } | null>(null);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let busy = false;
    let revision: string | undefined;
    const read = async (force = false) => {
      if (busy) return;
      busy = true;
      try {
        const document = await api.workspaceRead(projectId, path, force ? undefined : revision);
        if (document && alive) {
          revision = document.revision ?? undefined;
          setState(document);
        }
      } catch (error) {
        revision = undefined;
        if (alive) {
          const message = errorText(error);
          setState((previous) => previous && 'error' in previous && previous.error === message ? previous : { error: message });
        }
      } finally {
        busy = false;
      }
    };
    reload.current = () => { void read(true); };
    setState(null);
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [path, projectId]);
  const file = state && !('error' in state) ? state : undefined;
  const kind = visualFile(path);
  const fileActions = file && <>
    <CopyButton text={file.relative} label="Copiar ruta relativa" />
    <button className="btn-icon" aria-label="Mostrar en el Explorador" data-tip="Mostrar en el Explorador"
      onClick={() => void revealItemInDir(file.path).catch((error) => useStore.getState().toast(errorText(error), 'error'))}>
      <FolderOpen size={14} aria-hidden />
    </button>
  </>;
  if (file && !file.binary && kind) return <Suspense fallback={loadingVisual}>
    <VisualViewer key={String(line) + String(initialPreview)} source={{ kind, text: file.content }} title={basename(path)} path={file.relative}
      initialPreview={initialPreview && !line} truncated={file.truncated} reloadFile={() => reload.current()} actions={fileActions}
      codeBody={<div>
        {file.truncated && <p className="workspace-note">Vista limitada al primer MB del archivo.</p>}
        <CodeLines text={file.content} lang={langFromPath(path)} mark={line} />
      </div>} />
  </Suspense>;
  return (
    <div className="flex h-full flex-col">
      <Toolbar title={basename(path)} sub={file?.relative ?? path}>
        <RefreshButton label="Recargar archivo" onClick={() => reload.current()} />
        {file && <>
          {!file.binary && <CopyButton text={file.content} label="Copiar contenido" />}
          {fileActions}
        </>}
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto">
        {!state && <p className="workspace-note" role="status">Cargando…</p>}
        {state && 'error' in state && <p className="workspace-note" role="status">{state.error}</p>}
        {file && (file.binary ? (
          <p className="workspace-note">Archivo binario ({file.size} bytes).</p>
        ) : <>
          {file.truncated && <p className="workspace-note">Vista limitada al primer MB del archivo.</p>}
          <CodeLines text={file.content} lang={langFromPath(path)} mark={line} />
        </>)}
      </div>
    </div>
  );
}

const GIT_VIEW: Record<GitScope, string> = {
  staged: 'Preparado (staged)', unstaged: 'Sin preparar (unstaged)', untracked: 'Sin seguimiento',
};

function GitDiffView({ projectId, path, scope }: { projectId: string; path: string; scope: GitScope }) {
  const [revision, setRevision] = useState(0);
  const read = useMemo(() => () => api.gitDiff(projectId, path, scope), [projectId, path, scope]);
  const result = useWorkspaceQuery(read, revision);
  const lines = useMemo(() => parseUnified(result.data?.diff ?? ''), [result.data]);
  const stats = diffStats(lines);
  return <div className="flex h-full flex-col">
    <Toolbar title={basename(path)} sub={`Git · ${GIT_VIEW[scope]} · ${path}`}>
      {result.data && <>
        <span className="text-[12px]" style={{ color: 'var(--success)' }}>+{stats.added}</span>
        <span className="text-[12px]" style={{ color: 'var(--danger)' }}>−{stats.removed}</span>
        <CopyButton text={result.data.diff} label="Copiar diff Git" />
      </>}
      <RefreshButton label="Recargar diff Git" onClick={() => setRevision((n) => n + 1)} />
    </Toolbar>
    <div className="min-h-0 flex-1 overflow-auto" aria-busy={result.pending || undefined}>
      {result.pending && !result.data && <p className="workspace-note" role="status">Cargando diff…</p>}
      {result.error && <p className="workspace-note" role="status">{result.error}</p>}
      {result.data?.limited && <p className="workspace-note">El diff supera el límite de vista.</p>}
      {result.data && (lines.length ? <DiffRows lines={lines} /> : (
        <p className="workspace-note">{result.data.diff || 'Sin diferencias de texto que mostrar.'}</p>
      ))}
    </div>
  </div>;
}

function DiffRows({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff-view selectable">
      {lines.length > MAX_LINES && <p className="workspace-note">Se muestran las primeras {MAX_LINES} líneas.</p>}
      {lines.slice(0, MAX_LINES).map((l, i) =>
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
              openFileTab(change.path, firstChangedLine(lines) ?? undefined)
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

function TerminalView({ item, conversationId, messageId }: { item: TimelineItem; conversationId?: string; messageId?: string }) {
  const latest = useStore((s) => {
    if (!conversationId || !messageId) return undefined;
    const live = s.runs[conversationId];
    const items = live?.messageId === messageId ? live.items : s.messages[conversationId]?.find((m) => m.id === messageId)?.items;
    return items?.find((entry) => entry.id === item.id);
  });
  const it = latest ?? item;
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
        <pre className="term-out surface-code selectable">{out || (it.status === 'running' ? 'Esperando salida…' : 'Sin salida.')}</pre>
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
      <pre className="term-out surface-code selectable mx-4 mb-4 min-h-0 flex-1 overflow-auto">{text}</pre>
    </div>
  );
}

import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileMinus2,
  FileText,
  FolderSearch,
  Globe,
  Info,
  ListChecks,
  PanelRightOpen,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
  Bot,
  CircleSlash,
  MessageSquareText,
} from 'lucide-react';
import { memo, useContext, useMemo, useEffect, useState, type ReactNode } from 'react';
import type { FileChange, TimelineItem } from '../../lib/types';
import { openVisualTab } from '../../lib/visual/tabs';
import { toolVisuals } from '../../lib/visual/tool';
import { VISUAL_LABEL } from '../../lib/visual/types';
import { asText, basename, displayCommand, fmtDuration, relativeTo } from '../../lib/format';
import { diffLines, diffStats, parseUnified, type DiffLine } from '../../lib/diff';
import { useStore } from '../../state/store';
import { RevealStep } from '../../lib/conversationFind';
import { openFileTab, Markdown } from './Markdown';

export function changeLines(ch: FileChange) {
  if (ch.diff) return parseUnified(ch.diff);
  if (ch.newText != null) return diffLines(ch.oldText ?? '', ch.newText ?? '');
  return [];
}

export function openDiffTab(ch: FileChange) {
  const s = useStore.getState();
  const root = s.projects.find((p) => p.id === s.activeProjectId)?.path;
  s.openTab({ id: `diff:${ch.path}:${(ch.diff ?? ch.newText ?? '').length}`, kind: 'diff', title: basename(ch.path), payload: { change: ch, root } });
}

export function openTerminalTab(item: TimelineItem) {
  const state = useStore.getState();
  const conversationId = state.activeConversationId;
  const live = conversationId ? state.runs[conversationId] : undefined;
  const messageId = live?.items.includes(item) ? live.messageId :
    conversationId ? state.messages[conversationId]?.find((message) => message.items?.includes(item))?.id : undefined;
  state.openTab({
    id: `term:${conversationId}:${messageId}:${item.id}`,
    kind: 'terminal',
    title: displayCommand(item.command).slice(0, 28) || 'Comando',
    payload: { item, conversationId, messageId },
  });
}

/**
 * Fila ligera de actividad (diseño Hilo): icono teñido por el agente, título, datos y, si tiene
 * detalle, un desplegable. Un fallo se despliega solo; un ítem en curso lleva el acento del agente.
 */
export function Step({
  icon,
  title,
  extra,
  meta,
  status,
  children,
  onOpen,
  openLabel = 'Abrir en el panel',
  defaultOpen = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  extra?: ReactNode;
  meta?: ReactNode;
  status: TimelineItem['status'];
  children?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || status === 'failed');
  useEffect(() => { if (status === 'failed') setOpen(true); }, [status]);
  const reveal = useContext(RevealStep);
  const expanded = open || reveal;
  const expandable = !!children;
  return (
    <div className="step" data-status={status}>
      <div className="step-line">
        <button
          className="step-row"
          onClick={() => (expandable ? setOpen((o) => !o) : onOpen?.())}
          aria-expanded={expandable ? expanded : undefined}
          disabled={!expandable && !onOpen}
        >
          <span className="step-ic" aria-hidden>{icon}</span>
          <span className="step-title">{title}</span>
          {extra}
          {status === 'declined' && <span className="step-badge" data-tone="warn"><CircleSlash size={11} /> Rechazado</span>}
          {status === 'interrupted' && <span className="step-badge" data-tone="warn"><CircleSlash size={11} /> Interrumpido</span>}
          {meta && <span className="step-meta">{meta}</span>}
          {expandable && <ChevronRight size={13} className="step-chev" aria-hidden />}
        </button>
        {onOpen && (
          <button className="step-open" onClick={onOpen} aria-label={openLabel} data-tip={openLabel}>
            <PanelRightOpen size={13} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && children && (
          <motion.div
            initial={reveal ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reveal ? { duration: 0 } : { type: 'spring', bounce: 0, duration: 0.32 }}
            className="overflow-hidden"
          >
            <div className="step-detail">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type Action = { type?: string; name?: string; path?: string; query?: string };

/** Acción común de un comando de Codex (`commandActions`), si todas sus partes son del mismo tipo. */
function commandAction(item: TimelineItem): { verb: string; target: string } | null {
  const actions = (item as { actions?: Action[] }).actions;
  if (!Array.isArray(actions) || !actions.length || !actions.every((a) => a.type === actions[0].type)) return null;
  const running = item.status === 'running';
  const names = actions.map((a) => a.type === 'search' ? a.query ?? (a.path ? basename(a.path) : '') : a.name ?? (a.path ? basename(a.path) : a.query ?? '')).filter(Boolean);
  const target = names.length > 2 ? `${names.slice(0, 2).join(', ')} y ${names.length - 2} más` : names.join(', ');
  switch (actions[0].type) {
    case 'read': return { verb: running ? 'Leyendo' : 'Leyó', target };
    case 'search': return { verb: running ? 'Buscando' : 'Buscó', target };
    case 'listFiles': return { verb: running ? 'Listando' : 'Listó', target: target || 'archivos' };
    default: return null;
  }
}

function commandTitle(item: TimelineItem): ReactNode {
  const action = commandAction(item);
  const live = item.status === 'running' ? 'live-text' : undefined;
  if (action) return <span className={live}>{action.verb} {action.target && <b>{action.target}</b>}</span>;
  return <code className={live}>{item.description || displayCommand(item.command)}</code>;
}

function tail(s: string, n = 6000) {
  return s.length > n ? '…\n' + s.slice(-n) : s;
}

function toolSummary(item: TimelineItem): { title: ReactNode; path?: string; icon: ReactNode } {
  const input = (item.input ?? {}) as Record<string, unknown>;
  const path = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  const running = item.status === 'running';
  switch (item.tool) {
    case 'Read':
      return { title: <>{running ? 'Leyendo' : 'Leyó'} <b>{path ? basename(path) : 'un archivo'}</b></>, path, icon: <FileText size={13} /> };
    case 'Glob':
      return { title: <>Buscó archivos <code>{String(input.pattern ?? '')}</code></>, icon: <FolderSearch size={13} /> };
    case 'Grep':
      return { title: <>Buscó <code>{String(input.pattern ?? '')}</code></>, icon: <Search size={13} /> };
    case 'Task':
    case 'Agent':
      return { title: <>Subagente: {String(input.description ?? input.subagent_type ?? '')}</>, icon: <Bot size={13} /> };
    case 'LS':
      return { title: <>Listó <code>{String(input.path ?? '')}</code></>, icon: <FolderSearch size={13} /> };
    case 'WebFetch':
      return { title: <>Consultó <code>{String(input.url ?? '')}</code></>, icon: <Globe size={13} /> };
    case 'Bash':
      return { title: <code>{displayCommand(String(input.command ?? ''))}</code>, icon: <SquareTerminal size={13} /> };
    default:
      return { title: item.tool ?? 'Herramienta', path, icon: <Wrench size={13} /> };
  }
}

/** Vista previa de un diff dentro de la conversación (las primeras líneas; el resto, en el panel). */
function DiffPreview({ ch, root, max = 14 }: { ch: FileChange; root?: string; max?: number }) {
  const lines = useMemo(() => changeLines(ch), [ch]);
  const s = diffStats(lines);
  const shown = lines.filter((l) => l.type !== 'meta').slice(0, max);
  const rest = lines.filter((l) => l.type !== 'meta').length - shown.length;
  return (
    <div className="diffp">
      <button className="diffp-head" onClick={() => openDiffTab(ch)} data-tip="Abrir el diff en el panel">
        <span className="diffp-path">{relativeTo(ch.path, root)}</span>
        {ch.kind === 'add' && <span className="diffp-tag" data-tone="new">nuevo</span>}
        {ch.kind === 'delete' && <span className="diffp-tag" data-tone="del">eliminado</span>}
        <span className="add">+{s.added}</span>
        <span className="del">−{s.removed}</span>
        <PanelRightOpen size={12} className="diffp-open" />
      </button>
      {shown.length > 0 && (
        <pre className="diffp-body selectable">
          {shown.map((l, i) => (
            <span key={i} className="ln" data-t={l.type}>{lineText(l)}</span>
          ))}
          {rest > 0 && <span className="ln" data-t="more">… {rest} líneas más</span>}
        </pre>
      )}
    </div>
  );
}

function lineText(l: DiffLine) {
  if (l.type === 'hunk' || l.type === 'meta') return l.text;
  return `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '} ${l.text}`;
}

function verbIcon(kind: string) {
  return kind === 'add' ? <FilePlus2 size={13} /> : kind === 'delete' ? <FileMinus2 size={13} /> : <FilePen size={13} />;
}

/**
 * `live`: el turno sigue en curso. Mientras trabaja, el diff de un cambio pequeño se despliega solo para
 * seguir lo que hace; en el historial queda recogido y la respuesta final manda.
 */
export const TimelineEntry = memo(function TimelineEntry({ item, live = false }: { item: TimelineItem; live?: boolean }) {
  const reveal = useContext(RevealStep);
  switch (item.kind) {
    case 'reasoning': {
      // Solo llega aquí con texto: los razonamientos sin contenido legible no se muestran.
      return (
        <Step icon={<Sparkles size={13} />} title="Resumen del razonamiento"
          meta={item.durationMs ? fmtDuration(item.durationMs) : undefined} status={item.status}>
          <div className="step-reasoning selectable">{item.text?.trim()}</div>
        </Step>
      );
    }
    case 'text':
      return (
        <div className="activity-note">
          <MessageSquareText size={13} aria-hidden className="activity-note-ic" />
          <div className="min-w-0 flex-1"><Markdown text={item.text ?? ''} streaming={live && item.status === 'running'} /></div>
        </div>
      );
    case 'command': {
      const out = item.output ?? '';
      const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0);
      return (
        <Step
          icon={<SquareTerminal size={13} />}
          title={commandTitle(item)}
          extra={
            item.status === 'running' ? null : failed ? (
              <span className="step-badge" data-tone="err"><X size={11} /> código {item.exitCode ?? '?'}</span>
            ) : item.exitCode === 0 ? (
              <span className="step-badge" data-tone="ok"><Check size={11} /> correcto</span>
            ) : null
          }
          meta={fmtDuration(item.durationMs) || undefined}
          status={failed && item.status !== 'running' ? 'failed' : item.status}
          onOpen={() => openTerminalTab(item)}
          openLabel="Abrir la salida en el panel"
        >
          {(item.description || commandAction(item)) && <pre className="step-pre selectable mb-2">{displayCommand(item.command)}</pre>}
          {out ? <pre className="step-pre selectable" data-tone={failed ? 'err' : undefined}>{reveal ? out : tail(out)}</pre> : <div className="step-empty">{item.status === 'running' ? 'Esperando salida…' : 'Sin salida.'}</div>}
        </Step>
      );
    }
    case 'file_change': {
      const changes = item.changes ?? [];
      const st = useStore.getState();
      const root = st.projects.find((p) => p.id === st.activeProjectId)?.path;
      const verb = (k: string) => (k === 'add' ? 'Creó' : k === 'delete' ? 'Eliminó' : k === 'write' ? 'Escribió' : 'Editó');
      const total = changes.reduce((a, c) => { const s = diffStats(changeLines(c)); return { added: a.added + s.added, removed: a.removed + s.removed }; }, { added: 0, removed: 0 });
      const running = item.status === 'running';
      const title =
        changes.length === 1 ? <>{running ? 'Editando' : verb(changes[0].kind)} <b>{basename(changes[0].path)}</b></> : <>{running ? 'Editando' : 'Editó'} {changes.length} archivos</>;
      return (
        <Step
          icon={verbIcon(changes.length === 1 ? changes[0].kind : 'update')}
          title={<span className={running ? 'live-text' : undefined}>{title}</span>}
          extra={<span className="step-stats"><span className="add">+{total.added}</span><span className="del">−{total.removed}</span></span>}
          status={item.status}
          defaultOpen={live && changes.length > 0 && changes.length <= 2 && item.status !== 'declined'}
        >
          <div className="flex flex-col gap-1.5">
            {changes.map((ch, i) => <DiffPreview key={i} ch={ch} root={root} max={changes.length > 1 ? 8 : 14} />)}
          </div>
        </Step>
      );
    }
    case 'web_search':
      return <Step icon={<Globe size={13} />} title={<>Buscó en la web <b>{asText(item.query) || ''}</b></>} status={item.status} />;
    case 'plan':
      return (
        <Step icon={<ListChecks size={13} />} title="Plan de trabajo" status={item.status} defaultOpen>
          <div className="step-plan">
            <Markdown text={item.text ?? ''} />
          </div>
        </Step>
      );
    case 'notice':
      return <Step icon={<Info size={13} />} title={<span className="muted">{item.text}</span>} status="completed" />;
    case 'tool': {
      const { title, path, icon } = toolSummary(item);
      const result = asText(item.result);
      const visuals = item.status === 'completed' ? toolVisuals(item.result) : [];
      const hasDetail = (item.input != null && item.tool !== 'Read') || !!result;
      return (
        <Step
          icon={icon}
          title={<span className={item.status === 'running' ? 'live-text' : undefined}>{title}</span>}
          status={item.status}
          onOpen={path ? () => openFileTab(path) : undefined}
          openLabel="Abrir el archivo en el panel"
        >
          {hasDetail ? (
            <>
              {item.input != null && <pre className="step-pre selectable mb-2">{reveal ? asText(item.input) : tail(asText(item.input), 3000)}</pre>}
              {visuals.length > 0 && <div className="visual-tool-actions">{visuals.map((source, i) => (
                <button key={i} type="button" className="btn" onClick={() => openVisualTab(source, VISUAL_LABEL[source.kind] + ' · ' + (item.tool ?? 'Herramienta'))}>
                  Vista previa {VISUAL_LABEL[source.kind]}
                </button>
              ))}</div>}
              {result && <pre className="step-pre selectable" data-tone={item.status === 'failed' ? 'err' : undefined}>{reveal ? result : tail(result, 4000)}</pre>}
            </>
          ) : undefined}
        </Step>
      );
    }
    default:
      return null;
  }
});

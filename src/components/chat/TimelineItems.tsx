import { AnimatePresence, motion } from 'motion/react';
import {
  Brain,
  ChevronRight,
  FileDiff,
  FileText,
  Globe,
  Info,
  ListChecks,
  PanelRightOpen,
  SquareTerminal,
  Wrench,
  CircleAlert,
  CircleCheck,
  CircleSlash,
} from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import type { FileChange, TimelineItem } from '../../lib/types';
import { asText, basename, displayCommand, fmtDuration, relativeTo } from '../../lib/format';
import { diffLines, diffStats, parseUnified } from '../../lib/diff';
import { useStore } from '../../state/store';
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

function openTerminalTab(item: TimelineItem) {
  useStore.getState().openTab({
    id: `term:${item.id}`,
    kind: 'terminal',
    title: displayCommand(item.command).slice(0, 28) || 'Comando',
    payload: { item },
  });
}

function StatusIcon({ status }: { status: TimelineItem['status'] }) {
  if (status === 'running') return <span className="node-spinner" aria-label="En curso" />;
  if (status === 'failed') return <CircleAlert size={13} style={{ color: 'var(--danger)' }} aria-label="Falló" />;
  if (status === 'declined' || status === 'interrupted')
    return <CircleSlash size={13} style={{ color: 'var(--warning)' }} aria-label={status === 'declined' ? 'Rechazado' : 'Interrumpido'} />;
  return <CircleCheck size={13} style={{ color: 'var(--text-tertiary)' }} aria-label="Completado" />;
}

function Row({
  icon,
  title,
  meta,
  status,
  children,
  onOpen,
  defaultOpen = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  status: TimelineItem['status'];
  children?: ReactNode;
  onOpen?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;
  return (
    <div className="tl-row" data-status={status}>
      <span className="tl-node">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            className="tl-title"
            onClick={() => (expandable ? setOpen((o) => !o) : onOpen?.())}
            aria-expanded={expandable ? open : undefined}
          >
            <span className="min-w-0 truncate">{title}</span>
            {expandable && (
              <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.16 }} className="grid shrink-0 place-items-center faint">
                <ChevronRight size={12} />
              </motion.span>
            )}
          </button>
          {meta && <span className="shrink-0 text-[11.5px] faint">{meta}</span>}
          {onOpen && (
            <button className="btn-icon shrink-0" style={{ width: 24, height: 24 }} onClick={onOpen} aria-label="Abrir en el panel" data-tip="Abrir en el panel">
              <PanelRightOpen size={13} />
            </button>
          )}
          <span className="shrink-0">
            <StatusIcon status={status} />
          </span>
        </div>
        <AnimatePresence initial={false}>
          {open && children && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 38 }}
              className="overflow-hidden"
            >
              <div className="pt-2">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function tail(s: string, n = 6000) {
  return s.length > n ? '…\n' + s.slice(-n) : s;
}

function toolSummary(item: TimelineItem): { title: string; path?: string } {
  const input = (item.input ?? {}) as Record<string, unknown>;
  const path = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  switch (item.tool) {
    case 'Read':
      return { title: `Leyó ${path ? basename(path) : 'un archivo'}`, path };
    case 'Glob':
      return { title: `Buscó archivos ${String(input.pattern ?? '')}` };
    case 'Grep':
      return { title: `Buscó «${String(input.pattern ?? '')}»` };
    case 'Task':
    case 'Agent':
      return { title: `Subagente: ${String(input.description ?? input.subagent_type ?? '')}` };
    case 'LS':
      return { title: `Listó ${String(input.path ?? '')}` };
    default:
      return { title: item.tool ?? 'Herramienta', path };
  }
}

export const TimelineEntry = memo(function TimelineEntry({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'reasoning': {
      const text = item.text?.trim() ?? '';
      return (
        <Row
          icon={<Brain size={13} />}
          title={item.status === 'running' ? 'Razonando…' : 'Razonamiento'}
          status={item.status}
        >
          {text ? <div className="tl-reasoning selectable">{text}</div> : <div className="text-[12.5px] faint">El proveedor no comparte el contenido del razonamiento.</div>}
        </Row>
      );
    }
    case 'command': {
      const out = item.output ?? '';
      return (
        <Row
          icon={<SquareTerminal size={13} />}
          title={<span className="font-mono text-[12.5px]">{item.description || displayCommand(item.command)}</span>}
          meta={[item.exitCode != null ? `exit ${item.exitCode}` : null, fmtDuration(item.durationMs)].filter(Boolean).join('  ')}
          status={item.status}
          onOpen={() => openTerminalTab(item)}
        >
          {item.description && <pre className="tl-pre selectable mb-2">{displayCommand(item.command)}</pre>}
          {out ? <pre className="tl-pre selectable">{tail(out)}</pre> : <div className="text-[12.5px] faint">{item.status === 'running' ? 'Esperando salida…' : 'Sin salida.'}</div>}
        </Row>
      );
    }
    case 'file_change': {
      const changes = item.changes ?? [];
      const root = useStore.getState().projects.find((p) => p.id === useStore.getState().activeProjectId)?.path;
      const verb = (k: string) => (k === 'add' ? 'Creó' : k === 'delete' ? 'Eliminó' : k === 'write' ? 'Escribió' : 'Editó');
      const title =
        changes.length === 1 ? `${verb(changes[0].kind)} ${basename(changes[0].path)}` : `Cambios en ${changes.length} archivos`;
      return (
        <Row icon={<FileDiff size={13} />} title={title} status={item.status} defaultOpen={changes.length > 1}>
          <div className="flex flex-col gap-1">
            {changes.map((ch, i) => {
              const st = diffStats(changeLines(ch));
              return (
                <button key={i} className="file-line" onClick={() => openDiffTab(ch)}>
                  <FileText size={12} className="faint" />
                  <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px]" data-tip={ch.path}>{relativeTo(ch.path, root)}</span>
                  <span className="text-[11.5px]" style={{ color: 'var(--success)' }}>+{st.added}</span>
                  <span className="text-[11.5px]" style={{ color: 'var(--danger)' }}>−{st.removed}</span>
                </button>
              );
            })}
          </div>
        </Row>
      );
    }
    case 'web_search':
      return <Row icon={<Globe size={13} />} title={`Web: ${asText(item.query) || 'búsqueda'}`} status={item.status} />;
    case 'plan':
      return (
        <Row icon={<ListChecks size={13} />} title="Plan de trabajo" status={item.status} defaultOpen>
          <div className="tl-plan">
            <Markdown text={item.text ?? ''} />
          </div>
        </Row>
      );
    case 'notice':
      return <Row icon={<Info size={13} />} title={<span className="muted">{item.text}</span>} status="completed" />;
    case 'tool': {
      const { title, path } = toolSummary(item);
      const result = asText(item.result);
      return (
        <Row
          icon={<Wrench size={13} />}
          title={title}
          status={item.status}
          onOpen={path ? () => openFileTab(path) : undefined}
        >
          {item.input != null && <pre className="tl-pre selectable mb-2">{tail(asText(item.input), 3000)}</pre>}
          {result && <pre className="tl-pre selectable">{tail(result, 4000)}</pre>}
        </Row>
      );
    }
    default:
      return null;
  }
});

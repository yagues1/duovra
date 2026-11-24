import { FileText, SquareArrowOutUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { diffStats, TURN_DIFF_PATH, type DiffLine } from '../../lib/diff';
import { basename, relativeTo } from '../../lib/format';
import type { FileChange } from '../../lib/types';
import { changeLines, openDiffTab } from '../chat/TimelineItems';
import { tr } from '../../i18n';

export const MAX_LINES = 6_000;

/** Filas de un diff unificado: número antiguo, número nuevo, signo y texto. */
export function DiffRows({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff-view selectable">
      {lines.length > MAX_LINES && <p className="workspace-note">{tr('Se muestran las primeras {n} líneas.', { n: MAX_LINES })}</p>}
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

/** Lista plana de archivos cambiados con sus líneas añadidas y eliminadas. */
export function ChangeRows({ changes, root, selected, onSelect }: {
  changes: FileChange[]; root?: string; selected?: string; onSelect: (change: FileChange) => void;
}) {
  const rows = useMemo(() => changes.map((c) => ({ c, s: diffStats(changeLines(c)) })), [changes]);
  return (
    <ul className="wb-changes">
      {rows.map(({ c, s }) => (
        <li key={c.path}>
          <button type="button" className="wb-change" aria-current={selected === c.path || undefined} onClick={() => onSelect(c)}>
            <FileText size={13} aria-hidden />
            <span className="wb-change-path" data-tip={c.path} data-tip-truncated>{relativeTo(c.path, root)}</span>
            <span className="add">+{s.added}</span>
            <span className="del">−{s.removed}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Cambios del agente al estilo de la propuesta A: lista de archivos y diff del seleccionado debajo. */
export function InlineChanges({ changes, root }: { changes: FileChange[]; root?: string }) {
  const [path, setPath] = useState<string>();
  const change = changes.find((c) => c.path === path) ?? changes[0];
  const lines = useMemo(() => (change ? changeLines(change) : []), [change]);
  if (!change) return null;
  const stats = diffStats(lines);
  return (
    <div className="wb-inline-changes">
      {changes.length > 1 && <ChangeRows changes={changes} root={root} selected={change.path} onSelect={(c) => setPath(c.path)} />}
      <section className="wb-diff" aria-label={change.path === TURN_DIFF_PATH ? tr('Diff completo del turno') : tr('Diff de {name}', { name: basename(change.path) })}>
        <header className="wb-diff-head">
          <span className="wb-diff-path" data-tip={change.path} data-tip-truncated>
            {change.path === TURN_DIFF_PATH ? tr('Diff completo del turno') : relativeTo(change.path, root)}
          </span>
          <span className="add">+{stats.added}</span>
          <span className="del">−{stats.removed}</span>
          <button type="button" className="btn-icon" aria-label={tr('Abrir en una pestaña')} data-tip={tr('Abrir en una pestaña')}
            onClick={() => openDiffTab(change)}><SquareArrowOutUpRight size={13} aria-hidden /></button>
        </header>
        <div className="wb-diff-body">
          {lines.length ? <DiffRows lines={lines} /> : <p className="workspace-note">{tr('Sin diferencias de texto que mostrar.')}</p>}
        </div>
      </section>
    </div>
  );
}

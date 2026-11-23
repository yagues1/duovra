import { ChevronRight, FileCode2, Folder, FolderOpen, GitBranch, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CopyButton, openFileTab } from '../chat/Markdown';
import { api, errorText, type GitEntry, type GitScope, type GitStatus } from '../../lib/ipc';
import { basename } from '../../lib/format';
import { useStore } from '../../state/store';
import { tr } from '../../i18n';

export function useWorkspaceQuery<T>(read: () => Promise<T>, revision = 0) {
  const [result, setResult] = useState<{ data?: T; error?: string; revision: number }>();
  useEffect(() => {
    let current = true;
    void read().then(
      (data) => { if (current) setResult({ data, revision }); },
      (error) => { if (current) setResult({ error: errorText(error), revision }); },
    );
    return () => { current = false; };
  }, [read, revision]);
  return { ...result, pending: result?.revision !== revision };
}

export function RefreshButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className="btn-icon" onClick={onClick} aria-label={label} data-tip={label}>
    <RefreshCw size={14} aria-hidden />
  </button>;
}

const describe = (code: string) => ({ A: tr('Añadido'), M: tr('Modificado'), D: tr('Eliminado'), T: tr('Tipo cambiado'), U: tr('En conflicto'), '?': tr('Sin seguimiento') } as Record<string, string>)[code] ?? code;

export function WorkspaceFiles({ projectId, git, refreshGit }: { projectId: string; git?: GitStatus; refreshGit: () => void }) {
  const [revision, setRevision] = useState(0);
  // Índice por ruta y marca en sus carpetas ascendientes.
  const changes = useMemo(() => {
    const files = new Map<string, GitEntry>();
    const folders = new Set<string>();
    for (const entry of git?.entries ?? []) {
      files.set(entry.path, entry);
      for (let end = entry.path.lastIndexOf('/'); end > 0; end = entry.path.lastIndexOf('/', end - 1)) {
        folders.add(entry.path.slice(0, end));
      }
    }
    return { files, folders };
  }, [git]);
  return <div className="workspace-view">
    <div className="workspace-heading">
      <h3>{tr('Archivos del proyecto')}</h3>
      <RefreshButton label={tr('Actualizar archivos')} onClick={() => { setRevision((n) => n + 1); refreshGit(); }} />
    </div>
    <div className="workspace-scroll">
      <Directory projectId={projectId} path="" revision={revision} changes={changes} />
    </div>
  </div>;
}

function Directory({ projectId, path, revision, changes }: {
  projectId: string; path: string; revision: number; changes: { files: Map<string, GitEntry>; folders: Set<string> };
}) {
  const read = useMemo(() => () => api.workspaceList(projectId, path), [projectId, path]);
  const result = useWorkspaceQuery(read, revision);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  if (!result.data) return <p className="workspace-note" role="status">{result.error ?? 'Cargando carpeta…'}</p>;
  return <>
    {result.data.limited && <p className="workspace-note" role="status">{tr('Lista limitada a las primeras entradas.')}</p>}
    {!result.data.entries.length && <p className="workspace-note">{tr('Carpeta vacía.')}</p>}
    <ul className="workspace-tree">
      {result.data.entries.map((entry) => {
        const expanded = opened.has(entry.path);
        const git = changes.files.get(entry.path);
        const code = git && (git.worktree === '.' ? git.index : git.worktree);
        const Icon = entry.directory ? expanded ? FolderOpen : Folder : FileCode2;
        return <li key={entry.path}>
          <div className="workspace-row">
            <button type="button" title={entry.path} aria-expanded={entry.directory ? expanded : undefined} onClick={() => {
              if (!entry.directory) { openFileTab(entry.path); return; }
              setVisited((old) => new Set(old).add(entry.path));
              setOpened((old) => {
                const next = new Set(old);
                if (next.has(entry.path)) next.delete(entry.path);
                else next.add(entry.path);
                return next;
              });
            }}>
              {entry.directory && <ChevronRight size={13} className="workspace-chevron" aria-hidden />}
              <Icon size={15} aria-hidden />
              <span className="workspace-name">{entry.name}</span>
              {code && <span className="workspace-status" title={describe(code)} aria-label={describe(code)}>{code}</span>}
              {changes.folders.has(entry.path) && <span className="workspace-dot" title={tr('Contiene cambios')} aria-label={tr('Contiene cambios')} />}
            </button>
            <CopyButton text={entry.path} label={tr('Copiar ruta de {name}', { name: entry.name })} />
          </div>
          {entry.directory && visited.has(entry.path) && <div hidden={!expanded} className="workspace-children">
            <Directory projectId={projectId} path={entry.path} revision={revision} changes={changes} />
          </div>}
        </li>;
      })}
    </ul>
  </>;
}

const scopes = () => [['staged', tr('Preparados (staged)')], ['unstaged', tr('Sin preparar (unstaged)')], ['untracked', tr('Sin seguimiento')]] as const;
export function WorkspaceGit({ projectId, result, refresh, agentChanges }: {
  projectId: string; result: { data?: GitStatus; error?: string; pending: boolean }; refresh: () => void; agentChanges?: ReactNode;
}) {
  const status = result.data;
  const entries = status?.entries ?? [];
  return <div className="workspace-view">
    <div className="workspace-heading">
      <h3><GitBranch size={15} aria-hidden /> {status?.repository ? status.branch : 'Repositorio Git'}</h3>
      <RefreshButton label={tr('Actualizar Git')} onClick={refresh} />
    </div>
    <div className="workspace-scroll" aria-busy={result.pending || undefined}>
      {agentChanges}
      {result.pending && !status && <p className="workspace-note" role="status">Consultando Git…</p>}
      {result.error && <p className="workspace-note" role="status">{result.error}</p>}
      {status && !status.repository && <p className="workspace-note">{tr('La carpeta no pertenece a un repositorio Git.')}</p>}
      {status?.repository && <>
        <p className="workspace-note">{status.initial && tr('Rama sin commits') + ' · '}
          {entries.length ? (status.limited ? tr('Al menos {n} archivos con cambios', { n: entries.length }) : tr('{n} archivos con cambios', { n: entries.length })) : status.limited ? tr('Consulta limitada') : tr('Sin cambios en el proyecto')}
        </p>
        {status.limited && <p className="workspace-note">{tr('La lista está limitada.')}</p>}
        {scopes().map(([scope, title]) => {
          const group = entries.filter((entry) => scope === 'staged' ? entry.index !== '.' : scope === 'untracked' ? entry.worktree === '?' : !['.', '?'].includes(entry.worktree));
          if (!group.length) return null;
          return <section className="workspace-group" key={scope} aria-label={title}>
            <h4>{title} <span>{group.length}</span></h4>
            {group.map((entry) => <GitRow key={entry.path} entry={entry} scope={scope} projectId={projectId} />)}
          </section>;
        })}
      </>}
    </div>
  </div>;
}

function GitRow({ entry, scope, projectId }: { entry: GitEntry; scope: GitScope; projectId: string }) {
  const code = scope === 'staged' ? entry.index : entry.worktree;
  return <div className="workspace-row">
    <button type="button" title={entry.path} onClick={() => useStore.getState().openTab({
      id: 'gitDiff:' + scope + ':' + entry.path,
      kind: 'gitDiff',
      title: basename(entry.path),
      payload: { projectId, path: entry.path, scope },
    })}>
      <span className="workspace-status" aria-label={describe(code)}>{code}</span>
      <span className="workspace-name">{entry.path}</span>
    </button>
  </div>;
}

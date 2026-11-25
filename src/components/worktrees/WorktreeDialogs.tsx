import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { CircleAlert, Copy, FolderOpen, GitBranch, Info, TriangleAlert } from 'lucide-react';
import { api, errorText } from '../../lib/ipc';
import type { Project } from '../../lib/types';
import {
  fmtBytes, type GitWorktree, type RemovalCheck, type Worktree, type WorktreeCreateRequest, type WorktreePreflight, type WorktreeStatus,
} from '../../lib/worktrees';
import { useStore } from '../../state/store';
import { tr } from '../../i18n';
import { trBackend } from '../../i18n/backend';

/**
 * Diálogos de worktrees (1.0.9): crear, importar, estado y espacio, y retirar o eliminar.
 * Un único anfitrión; se abren como `openWorktreeDialog({...})`.
 */
type Request =
  | { kind: 'create'; project: Project }
  | { kind: 'import'; project: Project }
  | { kind: 'info'; worktree: Worktree }
  | { kind: 'remove'; worktree: Worktree };

const useRequest = create<{ req: Request | null; set: (req: Request | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

export function openWorktreeDialog(req: Request) {
  useRequest.getState().set(req);
}

export function WorktreeDialogHost() {
  const { req, set } = useRequest();
  if (!req) return null;
  const close = () => set(null);
  return createPortal(
    req.kind === 'create' ? <CreateDialog project={req.project} close={close} />
      : req.kind === 'import' ? <ImportDialog project={req.project} close={close} />
      : req.kind === 'info' ? <InfoDialog worktree={req.worktree} close={close} />
      : <RemoveDialog worktree={req.worktree} close={close} />,
    document.body,
  );
}

function Shell({ title, close, children, footer, wide }: { title: string; close: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className={`surface-popup request-dialog wt-dialog m-auto p-0 ${wide ? 'w-[540px]' : 'w-[460px]'} max-w-[calc(100vw-32px)]`}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="p-5">
        <h2 id={`${id}-title`} className="m-0 text-[16px] font-semibold">{title}</h2>
        <div className="wt-body">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </dialog>
  );
}

function Problems({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <ul className="wt-problems" role="status">
      {errors.map((text) => <li key={text} data-tone="error"><CircleAlert size={13} aria-hidden /> {trBackend(text)}</li>)}
      {warnings.map((text) => <li key={text} data-tone="warn"><TriangleAlert size={13} aria-hidden /> {trBackend(text)}</li>)}
    </ul>
  );
}

/** Nombre legible → segmento válido para carpeta y rama (`Nueva función` → `nueva-funcion`). */
export function slugify(name: string): string {
  const out = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9/]+/g, '-').replace(/\/{2,}/g, '/').replace(/(^[-/]+|[-/]+$)/g, '').replace(/-\/|\/-/g, '/');
  return out.slice(0, 60) || 'worktree';
}

const join = (dir: string, leaf: string) => `${dir.replace(/[\\/]+$/, '')}\\${leaf.replace(/\//g, '-')}`;

function CreateDialog({ project, close }: { project: Project; close: () => void }) {
  const upsert = useStore((s) => s.upsertWorktree);
  const selectSpace = useStore((s) => s.selectSpace);
  const toast = useStore((s) => s.toast);
  const [pf, setPf] = useState<WorktreePreflight | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [newBranch, setNewBranch] = useState(true);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [dir, setDir] = useState('');
  const [edited, setEdited] = useState({ branch: false, path: false });
  const [check, setCheck] = useState<WorktreePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.worktreePreflight(project.id).then((p) => {
      setPf(p);
      setName(p.suggestedName);
      setBranch(p.suggestedBranch);
      setBase(p.mainBranch ?? 'HEAD');
      setPath(p.suggestedPath);
      setDir(p.baseDir);
    }, (err) => setLoadError(errorText(err)));
  }, [project.id]);

  const request = useMemo<WorktreeCreateRequest>(() => ({ name: name.trim(), path: path.trim(), newBranch, branch: branch.trim(), base: newBranch ? base : null }),
    [name, path, newBranch, branch, base]);

  // Validación real con Git (rama, ruta, permisos y espacio), con una pausa breve al escribir.
  useEffect(() => {
    if (!pf) return;
    let alive = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      api.worktreePreflight(project.id, request).then((result) => alive && setCheck(result), (err) => alive && setCheck({ ...pf, errors: [errorText(err)], warnings: [] }))
        .finally(() => alive && setChecking(false));
    }, 320);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [pf, project.id, request]);

  const changeName = (value: string) => {
    setName(value);
    const leaf = slugify(value);
    if (!edited.branch && newBranch) setBranch(leaf);
    if (!edited.path) setPath(join(dir, leaf));
  };

  const available = (pf?.localBranches ?? []).filter((b) => !pf?.busyBranches.includes(b));
  const choose = async () => {
    const picked = await openDialog({ directory: true, multiple: false, title: tr('Carpeta donde crear el worktree') });
    if (!picked || Array.isArray(picked)) return;
    setDir(picked);
    setEdited((e) => ({ ...e, path: true }));
    setPath(join(picked, slugify(name)));
  };

  const submit = async () => {
    if (!check || check.errors.length || checking || creating) return;
    setCreating(true);
    try {
      const worktree = await api.worktreeCreate(project.id, request);
      upsert(worktree);
      close();
      toast(tr('Worktree «{name}» creado', { name: worktree.label }));
      await selectSpace(project.id, worktree.id);
    } catch (err) {
      setCheck({ ...(check ?? pf!), errors: [errorText(err)], warnings: [] });
    } finally {
      setCreating(false);
    }
  };

  const fieldId = useId();
  return (
    <Shell title={tr('Crear worktree en {project}', { project: project.name })} close={close} wide
      footer={<>
        <button type="button" className="btn" onClick={close}>{tr('Cancelar')}</button>
        <button type="button" className="btn btn-primary" disabled={!pf || checking || creating || !check || check.errors.length > 0} onClick={() => void submit()}>
          {creating ? tr('Creando…') : tr('Crear worktree')}
        </button>
      </>}>
      {loadError ? <Problems errors={[loadError]} warnings={[]} /> : !pf ? <p className="muted text-[13px]" role="status">{tr('Consultando Git…')}</p> : (
        <form className="wt-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="wt-field">
            <span>{tr('Nombre')}</span>
            <input data-autofocus className="input" value={name} onChange={(event) => changeName(event.target.value)} />
          </label>
          <fieldset className="wt-field">
            <legend>{tr('Rama')}</legend>
            <div className="wt-segment" role="radiogroup" aria-label={tr('Rama')}>
              <label><input type="radio" name={`${fieldId}-mode`} checked={newBranch} onChange={() => { setNewBranch(true); setBranch(slugify(name)); }} /> {tr('Nueva rama')}</label>
              <label><input type="radio" name={`${fieldId}-mode`} checked={!newBranch} disabled={!available.length}
                onChange={() => { setNewBranch(false); setBranch(available.find((b) => b !== pf.mainBranch) ?? available[0] ?? ''); }} /> {tr('Rama existente')}</label>
            </div>
            {newBranch ? (
              <div className="wt-row">
                <input className="input" aria-label={tr('Nombre de la nueva rama')} value={branch}
                  onChange={(event) => { setBranch(event.target.value); setEdited((e) => ({ ...e, branch: true })); }} />
                <span className="wt-from">{tr('desde')}</span>
                <select className="input" aria-label={tr('Referencia base')} value={base} onChange={(event) => setBase(event.target.value)}>
                  <option value="HEAD">HEAD</option>
                  {pf.localBranches.map((b) => <option key={b} value={b}>{b}</option>)}
                  {pf.remoteBranches.length > 0 && <optgroup label={tr('Remotas')}>
                    {pf.remoteBranches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </optgroup>}
                </select>
              </div>
            ) : (
              <select className="input" aria-label={tr('Rama existente')} value={branch} onChange={(event) => setBranch(event.target.value)}>
                {available.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </fieldset>
          <label className="wt-field">
            <span>{tr('Ubicación')}</span>
            <div className="wt-row">
              <input className="input wt-path" value={path} spellCheck={false}
                onChange={(event) => { setPath(event.target.value); setEdited((e) => ({ ...e, path: true })); }} />
              <button type="button" className="btn" onClick={() => void choose()}>{tr('Elegir…')}</button>
            </div>
          </label>
          <p className="wt-note">
            <Info size={13} aria-hidden />
            <span>{newBranch
              ? tr('El worktree parte de «{base}», no de los cambios sin commit del directorio principal.', { base })
              : tr('El worktree contendrá la rama «{branch}» tal y como está en Git, no los cambios sin commit del directorio principal.', { branch })}
              {' '}{tr('Comparte los objetos de Git del repositorio: no instala dependencias ni copia archivos .env.')}</span>
          </p>
          {pf.mainDirty && <p className="wt-note" data-tone="warn"><TriangleAlert size={13} aria-hidden /><span>{tr('El directorio principal tiene cambios sin commit: no se trasladan al nuevo worktree.')}</span></p>}
          {check && (check.freeBytes != null || check.estimatedBytes != null) && (
            <p className="wt-meta">
              {check.estimatedBytes != null && tr('Archivos versionados: ~{size}', { size: fmtBytes(check.estimatedBytes) })}
              {check.estimatedBytes != null && check.freeBytes != null && ' · '}
              {check.freeBytes != null && tr('Libre en la unidad: {size}', { size: fmtBytes(check.freeBytes) })}
            </p>
          )}
          <Problems errors={check?.errors ?? []} warnings={check?.warnings ?? []} />
          <button type="submit" hidden />
        </form>
      )}
    </Shell>
  );
}

function ImportDialog({ project, close }: { project: Project; close: () => void }) {
  const upsert = useStore((s) => s.upsertWorktree);
  const toast = useStore((s) => s.toast);
  const [items, setItems] = useState<GitWorktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  useEffect(() => {
    api.worktreeImportable(project.id).then((list) => {
      setItems(list);
      setChosen(new Set(list.filter((w) => !w.prunable).map((w) => w.path)));
    }, (err) => setError(errorText(err)));
  }, [project.id]);
  const submit = async () => {
    setWorking(true);
    try {
      for (const path of chosen) upsert(await api.worktreeImport(project.id, path));
      toast(chosen.size === 1 ? tr('Worktree importado') : tr('{n} worktrees importados', { n: chosen.size }));
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Shell title={tr('Importar worktrees de {project}', { project: project.name })} close={close}
      footer={<>
        <button type="button" className="btn" onClick={close}>{items?.length ? tr('Cancelar') : tr('Cerrar')}</button>
        {!!items?.length && <button type="button" className="btn btn-primary" data-autofocus disabled={!chosen.size || working} onClick={() => void submit()}>{tr('Importar')}</button>}
      </>}>
      {error ? <Problems errors={[error]} warnings={[]} /> : !items ? <p className="muted text-[13px]" role="status">{tr('Consultando Git…')}</p>
        : !items.length ? <p className="muted text-[13px]" data-autofocus tabIndex={-1}>{tr('Git no informa de worktrees de este repositorio que no estén ya en Duovra.')}</p> : (
          <>
            <p className="wt-note"><Info size={13} aria-hidden /><span>{tr('Importar solo los registra en Duovra: no se mueve ni modifica ningún archivo.')}</span></p>
            <ul className="wt-import">
              {items.map((w) => (
                <li key={w.path}>
                  <label>
                    <input type="checkbox" checked={chosen.has(w.path)} disabled={w.prunable}
                      onChange={(event) => setChosen((set) => { const next = new Set(set); if (event.target.checked) next.add(w.path); else next.delete(w.path); return next; })} />
                    <span className="wt-import-text">
                      <strong>{w.branch ?? (w.detached ? tr('HEAD separado') : '—')}</strong>
                      <span className="wt-path-text" data-tip={w.path} data-tip-truncated>{w.path}</span>
                      {w.prunable && <span className="wt-flag">{tr('La carpeta ya no existe')}</span>}
                      {w.locked && <span className="wt-flag">{tr('Bloqueado')}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
    </Shell>
  );
}

function InfoDialog({ worktree, close }: { worktree: Worktree; close: () => void }) {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ bytes: number; partial: boolean } | 'loading' | null>(null);
  useEffect(() => {
    api.worktreeStatus(worktree.id).then(setStatus, (err) => setError(errorText(err)));
  }, [worktree.id]);
  const measure = () => {
    setSize('loading');
    api.worktreeSize(worktree.id).then(setSize, (err) => { setSize(null); setError(errorText(err)); });
  };
  return (
    <Shell title={worktree.label} close={close}
      footer={<button type="button" className="btn" data-autofocus onClick={close}>{tr('Cerrar')}</button>}>
      <dl className="wt-facts">
        <dt>{tr('Rama')}</dt><dd><GitBranch size={12} aria-hidden /> {status?.branch ?? worktree.branch ?? tr('HEAD separado')}</dd>
        <dt>{tr('Origen')}</dt><dd>{worktree.managed ? tr('Creado por Duovra') : tr('Importado')}{worktree.baseRef && ` · ${tr('desde {base}', { base: worktree.baseRef })}`}</dd>
        <dt>{tr('Ubicación')}</dt>
        <dd className="wt-path-dd">
          <span className="wt-path-text selectable" data-tip={worktree.path} data-tip-truncated>{worktree.path}</span>
          <button type="button" className="btn-icon" aria-label={tr('Copiar ruta')} data-tip={tr('Copiar ruta')}
            onClick={() => void navigator.clipboard.writeText(worktree.path).then(() => toast(tr('Ruta copiada')))}><Copy size={13} /></button>
          <button type="button" className="btn-icon" aria-label={tr('Mostrar en el Explorador')} data-tip={tr('Mostrar en el Explorador')}
            disabled={!worktree.exists} onClick={() => void revealItemInDir(worktree.path)}><FolderOpen size={13} /></button>
        </dd>
        <dt>{tr('Estado')}</dt>
        <dd>{!worktree.exists ? tr('La carpeta ya no existe') : !status ? tr('Consultando…') : (
          status.changed + status.untracked === 0 ? tr('Sin cambios pendientes')
            : tr('{changed} con cambios · {untracked} sin seguimiento', { changed: status.changed, untracked: status.untracked })
        )}{status && (status.ahead > 0 || status.behind > 0) && ` · ${tr('{ahead} por delante, {behind} por detrás de {upstream}', { ahead: status.ahead, behind: status.behind, upstream: status.upstream ?? 'upstream' })}`}</dd>
        <dt>{tr('Espacio')}</dt>
        <dd>{size === null ? <button type="button" className="notice-link" disabled={!worktree.exists} onClick={measure}>{tr('Calcular espacio ocupado')}</button>
          : size === 'loading' ? tr('Calculando…') : `${fmtBytes(size.bytes)}${size.partial ? ` (${tr('parcial')})` : ''}`}</dd>
      </dl>
      {error && <Problems errors={[error]} warnings={[]} />}
    </Shell>
  );
}

function RemoveDialog({ worktree, close }: { worktree: Worktree; close: () => void }) {
  const retire = useStore((s) => s.retireWorktreeLocal);
  const toast = useStore((s) => s.toast);
  const [check, setCheck] = useState<RemovalCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteDir, setDeleteDir] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    api.worktreeRemovalCheck(worktree.id).then(setCheck, (err) => setError(errorText(err)));
  }, [worktree.id]);
  const branchAllowed = !!check?.canDeleteBranch && (deleteDir || !check.exists);
  const submit = async () => {
    setWorking(true);
    try {
      await api.worktreeRemove(worktree.id, deleteDir, deleteBranch && branchAllowed);
      retire(worktree.id, (check?.conversations ?? 0) > 0);
      toast(deleteDir ? tr('Worktree eliminado') : tr('Worktree retirado de Duovra'));
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Shell title={tr('Retirar o eliminar «{name}»', { name: worktree.label })} close={close}
      footer={<>
        <button type="button" className="btn" data-autofocus onClick={close}>{tr('Cancelar')}</button>
        <button type="button" className={deleteDir ? 'btn btn-danger' : 'btn btn-primary'} disabled={!check || working} onClick={() => void submit()}>
          {deleteDir ? tr('Eliminar worktree') : tr('Retirar de Duovra')}
        </button>
      </>}>
      {!check && !error && <p className="muted text-[13px]" role="status">{tr('Comprobando el worktree con Git…')}</p>}
      {check && (
        <div className="wt-remove">
          <p className="wt-option"><strong>{tr('Retirar de Duovra')}</strong> · {tr('Deja de mostrarse aquí. La carpeta y la rama quedan intactas.')}</p>
          {check.conversations > 0 && (
            <p className="wt-note"><Info size={13} aria-hidden /><span>{tr('{n} conversación(es) conservarán su historial; su directorio dejará de estar disponible para nuevos mensajes.', { n: check.conversations })}</span></p>
          )}
          <label className="wt-check" data-disabled={!check.canRemoveDir || undefined}>
            <input type="checkbox" checked={deleteDir} disabled={!check.canRemoveDir} onChange={(event) => { setDeleteDir(event.target.checked); if (!event.target.checked) setDeleteBranch(false); }} />
            <span><strong>{tr('Eliminar también la carpeta')}</strong> · {tr('Con «git worktree remove», sin forzar.')}</span>
          </label>
          {!worktree.managed && <p className="wt-note" data-tone="warn"><TriangleAlert size={13} aria-hidden /><span>{tr('Este worktree no lo creó Duovra: otra herramienta podría estar usándolo.')}</span></p>}
          {!check.exists && <p className="wt-note"><Info size={13} aria-hidden /><span>{tr('La carpeta ya no existe: solo queda retirar la referencia.')}</span></p>}
          <Problems errors={check.blockers} warnings={check.warnings} />
          {check.branch && (
            <label className="wt-check" data-disabled={!branchAllowed || undefined}>
              <input type="checkbox" checked={deleteBranch && branchAllowed} disabled={!branchAllowed} onChange={(event) => setDeleteBranch(event.target.checked)} />
              <span><strong>{tr('Eliminar también la rama «{branch}»', { branch: check.branch })}</strong> · {check.branchNote ? trBackend(check.branchNote) : tr('Su trabajo ya está en otra rama (git branch -d).')}</span>
            </label>
          )}
        </div>
      )}
      {error && <Problems errors={[error]} warnings={[]} />}
    </Shell>
  );
}

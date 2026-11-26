import { AnimatePresence, motion } from 'motion/react';
import { Archive, ArchiveRestore, ArrowDownToLine, ChevronRight, Copy, CornerUpLeft, Ellipsis, FileDown, Folder, FolderInput, FolderOpen, GitBranch, GitBranchPlus, GitFork, GitMerge, HardDrive, History, MessagesSquare, FolderPlus, MessageSquare, MessageSquarePlus, PanelLeftOpen, Pencil, Pin, PinOff, Settings2, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { isListed, useStore } from '../../state/store';
import type { Conversation, Project } from '../../lib/types';
import { Popover, MenuItem, MenuSeparator } from '../ui/Popover';
import { confirmDialog, promptDialog } from '../ui/Dialog';
import { AGENT_NAME, displayTitle, fmtRelative, fmtShortRelative } from '../../lib/format';
import { Mascot } from '../mascot/Mascot';
import { useLayout } from '../../hooks/useLayout';
import { DistributionLinks } from '../distribution/Distribution';
import { SupportLink } from './SupportLink';
import { turnPhase, TURN_LABEL } from '../../lib/activity';
import { SPRING } from '../../lib/motion';
import { tr } from '../../i18n';
import type { Worktree } from '../../lib/worktrees';
import { openWorktreeDialog } from '../worktrees/WorktreeDialogs';
import { copyWorktreePath, prepareIntegrationFlow, renameWorktreeFlow, repairWorktreeFlow } from '../worktrees/worktreeActions';
import { openSessionDialog } from '../sessions/SessionDialogHost';
import { openOriginal, setArchived, setPinned } from '../sessions/sessionActions';

type MenuTarget = { anchor: HTMLButtonElement; point?: { x: number; y: number } };
type Menu = MenuTarget & (
  { kind: 'project'; project: Project } |
  { kind: 'conversation'; conv: Conversation } |
  { kind: 'worktree'; worktree: Worktree }
);

export async function renameConversationFlow(conv: Conversation) {
  const title = await promptDialog({ title: tr('Renombrar conversación'), confirmLabel: tr('Renombrar'), initial: conv.title });
  if (title) await useStore.getState().renameConversation(conv.id, title);
}

export async function deleteConversationFlow(conv: Conversation) {
  const ok = await confirmDialog({
    title: tr('¿Eliminar esta conversación?'),
    body: tr('«{title}» y sus mensajes se borrarán de Duovra. Las sesiones internas de cada agente no se modifican.', { title: conv.title }),
    confirmLabel: tr('Eliminar conversación'),
    danger: true,
  });
  if (ok) await useStore.getState().deleteConversation(conv.id);
}

/** Exporta la conversación persistida: formato y adjuntos en un diálogo compacto (1.0.11). */
export function exportConversationFlow(conv: Conversation) {
  openSessionDialog({ kind: 'export', conversation: conv });
}

/** Fijadas primero dentro de su espacio; después, por actividad reciente. */
export function sortConversations(list: Conversation[]): Conversation[] {
  return list.sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || b.updatedAt - a.updatedAt);
}

export async function renameProjectFlow(p: Project) {
  const name = await promptDialog({ title: tr('Renombrar proyecto'), confirmLabel: tr('Renombrar'), initial: p.name });
  if (name) await useStore.getState().renameProject(p.id, name);
}

export async function deleteProjectFlow(p: Project) {
  const ok = await confirmDialog({
    title: tr('¿Quitar este proyecto?'),
    body: tr('Se quitará «{name}» y todas sus conversaciones de la aplicación. La carpeta {path} no se toca.', { name: p.name, path: p.path }),
    confirmLabel: tr('Quitar proyecto'),
    danger: true,
  });
  if (ok) await useStore.getState().deleteProject(p.id);
}

/**
 * Conversaciones que esperan al usuario (permiso, plan o pregunta). Fase 5: un indicador agregado en el
 * proyecto o worktree plegado y en la barra contraída, para que nada pendiente quede oculto.
 */
function useWaiting(): ReadonlySet<string> {
  const pending = useStore((s) => s.pendingInteractions);
  const runs = useStore((s) => s.runs);
  return useMemo(() => {
    const out = new Set<string>();
    for (const [id, n] of Object.entries(pending)) if (n > 0) out.add(id);
    for (const [id, run] of Object.entries(runs)) if (run.approvals.length) out.add(id);
    return out;
  }, [pending, runs]);
}

function WaitDot({ count }: { count: number }) {
  if (!count) return null;
  const label = count === 1 ? tr('1 conversación espera tu respuesta') : tr('{n} conversaciones esperan tu respuesta', { n: count });
  return <span className="tree-wait" role="status" aria-label={label} data-tip={label} />;
}

export function Sidebar() {
  const { rail, compactNav } = useLayout();
  const drawer = useStore((s) => s.navDrawer);
  const setDrawer = useStore((s) => s.setNavDrawer);
  return (
    <>
      <motion.aside
        className="surface-panel sidebar relative z-20 flex shrink-0 flex-col overflow-hidden"
        initial={false}
        animate={{ width: rail ? 'var(--sidebar-rail-w)' : 'var(--sidebar-w)' }}
        transition={{ type: 'spring', bounce: 0, duration: 0.42 }}
        aria-label={tr('Navegación')}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={rail ? 'rail' : 'full'}
            className="flex h-full min-h-0 flex-col"
            initial={{ opacity: 0, x: rail ? 0 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ type: 'spring', bounce: 0, duration: 0.32 }}
          >
            {rail ? <Rail onExpand={compactNav ? () => setDrawer(true) : undefined} /> : <Full />}
          </motion.div>
        </AnimatePresence>
      </motion.aside>

      {compactNav && drawer && <NavigationDrawer close={() => setDrawer(false)} />}
    </>
  );
}

function NavigationDrawer({ close }: { close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="surface-panel nav-drawer m-0 flex flex-col overflow-hidden p-0"
      aria-label={tr('Navegación')}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key.toLowerCase() === 'b') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="nav-drawer-head flex shrink-0 items-center justify-between px-3 pt-2">
        <span>{tr('Proyectos y conversaciones')}</span>
        <button ref={closeRef} type="button" className="btn-icon" aria-label={tr('Cerrar navegación')} onClick={close}><X size={16} aria-hidden /></button>
      </div>
      <Full />
    </dialog>
  );
}

function Rail({ onExpand }: { onExpand?: () => void }) {
  const newConversation = useStore((s) => s.newConversation);
  const setView = useStore((s) => s.setView);
  const setSetting = useStore((s) => s.setSetting);
  const view = useStore((s) => s.view);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const expand = onExpand ?? (() => void setSetting('ui.sidebarCollapsed', false));
  const waiting = useWaiting().size;
  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-3">
      <button data-tip-side="right" className="rail-btn" aria-label={tr('Mostrar proyectos y conversaciones')} data-tip={tr('Mostrar proyectos y conversaciones')} onClick={expand}>
        <PanelLeftOpen size={17} strokeWidth={1.6} />
        {waiting > 0 && <span className="rail-wait"><WaitDot count={waiting} /></span>}
      </button>
      <span className="rail-sep" aria-hidden />
      <button data-tip-side="right" className="rail-btn" aria-label={tr('Conversación')} data-tip={tr('Conversación')} aria-pressed={view === 'chat' && !settingsOpen} onClick={() => setView('chat')}>
        <MessagesSquare size={17} strokeWidth={1.6} />
      </button>
      <button data-tip-side="right" className="rail-btn rail-btn-accent" aria-label={tr('Nueva conversación')} data-tip={`${tr('Nueva conversación')} (Ctrl+N)`} onClick={() => void newConversation()}>
        <MessageSquarePlus size={17} strokeWidth={1.6} />
      </button>
      <div className="flex-1" />
      <DistributionLinks rail />
      <SupportLink rail />
      <button data-tip-side="right" className="rail-btn" aria-label={tr('Ajustes')} data-tip={`${tr('Ajustes')} (Ctrl+,)`} aria-pressed={settingsOpen} onClick={() => setView('settings')}>
        <Settings2 size={17} strokeWidth={1.6} />
      </button>
    </div>
  );
}

function Full() {
  const projects = useStore((s) => s.projects);
  const conversations = useStore((s) => s.conversations);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const worktrees = useStore((s) => s.worktrees);
  const gitProjects = useStore((s) => s.gitProjects);
  const newConversation = useStore((s) => s.newConversation);
  const addProject = useStore((s) => s.addProject);
  const setView = useStore((s) => s.setView);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menuId = useId();
  const treeRef = useRef<HTMLElement>(null);

  // Conversaciones por espacio: el id del proyecto (directorio principal) o el de cada worktree.
  const bySpace = useMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of conversations) {
      if (!isListed(c)) continue;
      const key = c.worktreeId ?? c.projectId;
      const list = m.get(key) ?? [];
      list.push(c);
      m.set(key, list);
    }
    for (const list of m.values()) sortConversations(list);
    return m;
  }, [conversations]);
  // Worktrees visibles: los activos y los retirados que aún conservan conversaciones (historial).
  const spacesOf = useMemo(() => {
    const m = new Map<string, Worktree[]>();
    for (const w of worktrees) {
      if (w.retired && !(bySpace.get(w.id)?.length)) continue;
      m.set(w.projectId, [...(m.get(w.projectId) ?? []), w]);
    }
    return m;
  }, [worktrees, bySpace]);

  const isOpen = (id: string) => expanded[id] ?? id === activeProjectId;
  const waiting = useWaiting();

  const menuAction = (action: () => void | Promise<void>, restoreAfterRemoval = false) => {
    const anchor = menu?.anchor;
    anchor?.focus();
    setMenu(null);
    const pending = action();
    if (restoreAfterRemoval) void Promise.resolve(pending).then(() => {
      requestAnimationFrame(() => {
        if (!anchor?.isConnected && document.activeElement === document.body) {
          const next = treeRef.current?.querySelector<HTMLElement>('button') ?? treeRef.current;
          next?.focus();
        }
      });
    });
  };

  return (
    <div className="flex h-full min-h-0 w-[var(--sidebar-full-w,var(--sidebar-w))] min-w-[var(--sidebar-full-w,var(--sidebar-w))] flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button className="new-conv-btn flex-1" onClick={() => void newConversation()} disabled={!activeProjectId}>
          <MessageSquarePlus size={16} strokeWidth={1.7} />
          {tr('Nueva conversación')}
        </button>
      </div>

      <div className="side-section">
        <span>{tr('Proyectos')}</span>
        <button className="side-section-btn" aria-label={tr('Añadir proyecto')} data-tip={tr('Añadir carpeta como proyecto')} onClick={() => void addProject()}>
          <FolderPlus size={14} strokeWidth={1.7} />
        </button>
      </div>
      <nav ref={treeRef} tabIndex={-1} className="side-tree min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label={tr('Proyectos y conversaciones')}>
        {projects.length === 0 && (
          <div className="mx-1 mt-3 rounded-[14px] p-3 text-[13px] leading-relaxed muted" style={{ background: 'var(--surface-sunken)' }}>
            {tr('Añade la carpeta de un proyecto para empezar a conversar con Claude Code o Codex.')}
            <button className="btn btn-primary mt-3 w-full justify-center" onClick={() => void addProject()}>
              <FolderPlus size={15} /> {tr('Añadir proyecto')}
            </button>
          </div>
        )}
        {projects.map((p) => {
          const list = bySpace.get(p.id) ?? [];
          const spaces = spacesOf.get(p.id) ?? [];
          const total = list.length + spaces.reduce((n, w) => n + (bySpace.get(w.id)?.length ?? 0), 0);
          const open = isOpen(p.id);
          const actionsOpen = menu?.kind === 'project' && menu.project.id === p.id;
          const openActions = (target: MenuTarget) => setMenu({ kind: 'project', project: p, ...target });
          return (
            <div key={p.id} className="tree-group" data-open={open || undefined}>
              <div className="tree-row" data-active={p.id === activeProjectId || undefined} onContextMenu={(event) => openContext(event, openActions)}>
                <button
                  className="tree-project"
                  data-active={p.id === activeProjectId || undefined}
                  onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                  aria-expanded={open}
                  aria-current={p.id === activeProjectId ? 'location' : undefined}
                >
                  <span className="tree-chev" aria-hidden>
                    <ChevronRight size={12} strokeWidth={2.2} />
                  </span>
                  <span className="tree-project-ic" aria-hidden>
                    {open ? <FolderOpen size={15} strokeWidth={1.7} /> : <Folder size={15} strokeWidth={1.7} />}
                  </span>
                  <span className="tree-project-name truncate" data-tip={p.name} data-tip-truncated>{p.name}</span>
                  {!open && <WaitDot count={conversations.filter((c) => c.projectId === p.id && waiting.has(c.id) && isListed(c)).length} />}
                  <span className="tree-count">{total || ''}</span>
                </button>
                <TreeActions label={tr('Acciones de {name}', { name: p.name })} open={actionsOpen} menuId={menuId}
                  onClick={(anchor) => actionsOpen ? setMenu(null) : openActions({ anchor })} />
              </div>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="tree-children overflow-hidden"
                  >
                    {list.length === 0 && !spaces.length && (
                      <button className="tree-conv tree-conv-empty" onClick={() => void newConversation(p.id, null)}>
                        <MessageSquarePlus size={13} strokeWidth={1.7} className="relative" />
                        <span className="relative truncate">{tr('Sin conversaciones · crear una')}</span>
                      </button>
                    )}
                    {list.map((c) => {
                      const open = menu?.kind === 'conversation' && menu.conv.id === c.id;
                      return <ConversationRow key={c.id} conv={c} open={open} menuId={menuId}
                        onMenu={(target) => setMenu(target ? { kind: 'conversation', conv: c, ...target } : null)} />;
                    })}
                    {spaces.map((w) => (
                      <WorktreeNode key={w.id} worktree={w} conversations={bySpace.get(w.id) ?? []} menu={menu} menuId={menuId}
                        projectOpen={open} setMenu={setMenu} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      <div className="side-foot">
        <SupportLink />
        <button className="side-link" data-active={settingsOpen || undefined} onClick={() => setView('settings')}>
          <Settings2 size={16} strokeWidth={1.6} /> {tr('Ajustes')}
        </button>
        <DistributionLinks />
      </div>

      <Popover open={menu !== null} onClose={() => setMenu(null)} anchor={menu?.anchor ?? null} point={menu?.point} width={232}
        menuId={menuId} ariaLabel={menu?.anchor.ariaLabel ?? undefined}>
        {menu?.kind === 'project' && (
          <>
            <MenuItem icon={<MessageSquarePlus size={14} />} label={tr('Nueva conversación')} onSelect={() => menuAction(() => newConversation(menu.project.id))} />
            <MenuItem icon={<Pencil size={14} />} label={tr('Renombrar')} onSelect={() => menuAction(() => renameProjectFlow(menu.project))} />
            <MenuItem icon={<FolderOpen size={14} />} label={tr('Mostrar en el Explorador')} onSelect={() => menuAction(() => revealItemInDir(menu.project.path))} />
            <MenuItem icon={<ArrowDownToLine size={14} />} label={tr('Importar sesiones…')} onSelect={() => menuAction(() => openSessionDialog({ kind: 'import', project: menu.project }))} />
            {conversations.some((c) => c.projectId === menu.project.id && c.archivedAt) && (
              <MenuItem icon={<History size={14} />} label={tr('Conversaciones archivadas…')} onSelect={() => menuAction(() => openSessionDialog({ kind: 'archived', project: menu.project }))} />
            )}
            {gitProjects.includes(menu.project.id) && (
              <>
                <MenuSeparator />
                <MenuItem icon={<GitBranchPlus size={14} />} label={tr('Crear worktree…')} onSelect={() => menuAction(() => openWorktreeDialog({ kind: 'create', project: menu.project }))} />
                <MenuItem icon={<FolderInput size={14} />} label={tr('Importar worktrees…')} onSelect={() => menuAction(() => openWorktreeDialog({ kind: 'import', project: menu.project }))} />
              </>
            )}
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} danger label={tr('Quitar de la aplicación')} onSelect={() => menuAction(() => deleteProjectFlow(menu.project), true)} />
          </>
        )}
        {menu?.kind === 'worktree' && !menu.worktree.retired && (
          <>
            <MenuItem icon={<MessageSquarePlus size={14} />} label={tr('Nueva conversación aquí')} disabled={!menu.worktree.exists}
              onSelect={() => menuAction(() => newConversation(menu.worktree.projectId, menu.worktree.id))} />
            <MenuItem icon={<Pencil size={14} />} label={tr('Renombrar')} onSelect={() => menuAction(() => renameWorktreeFlow(menu.worktree))} />
            <MenuItem icon={<HardDrive size={14} />} label={tr('Estado y espacio…')} onSelect={() => menuAction(() => openWorktreeDialog({ kind: 'info', worktree: menu.worktree }))} />
            <MenuItem icon={<FolderOpen size={14} />} label={tr('Mostrar en el Explorador')} disabled={!menu.worktree.exists}
              onSelect={() => menuAction(() => revealItemInDir(menu.worktree.path))} />
            <MenuItem icon={<Copy size={14} />} label={tr('Copiar ruta')} onSelect={() => menuAction(() => copyWorktreePath(menu.worktree))} />
            <MenuItem icon={<GitMerge size={14} />} label={tr('Preparar integración')} disabled={!menu.worktree.exists}
              onSelect={() => menuAction(() => prepareIntegrationFlow(menu.worktree))} />
            {!menu.worktree.exists && (
              <MenuItem icon={<Wrench size={14} />} label={tr('Reparar ubicación…')} onSelect={() => menuAction(() => repairWorktreeFlow(menu.worktree))} />
            )}
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger label={tr('Retirar o eliminar…')} onSelect={() => menuAction(() => openWorktreeDialog({ kind: 'remove', worktree: menu.worktree }))} />
          </>
        )}
        {menu?.kind === 'conversation' && (
          <>
            {menu.conv.pinnedAt
              ? <MenuItem icon={<PinOff size={14} />} label={tr('Desfijar')} onSelect={() => menuAction(() => setPinned(menu.conv, false))} />
              : <MenuItem icon={<Pin size={14} />} label={tr('Fijar')} onSelect={() => menuAction(() => setPinned(menu.conv, true))} />}
            <MenuItem icon={<Pencil size={14} />} label={tr('Renombrar')} onSelect={() => menuAction(() => renameConversationFlow(menu.conv))} />
            {menu.conv.origin && 'kind' in menu.conv.origin && menu.conv.origin.kind === 'fork' && (
              <MenuItem icon={<CornerUpLeft size={14} />} label={tr('Ir a la conversación original')}
                disabled={!conversations.some((c) => menu.conv.origin && 'conversationId' in menu.conv.origin && c.id === menu.conv.origin.conversationId)}
                onSelect={() => menuAction(() => openOriginal(menu.conv))} />
            )}
            <MenuItem icon={<FileDown size={14} />} label={tr('Exportar conversación…')} onSelect={() => menuAction(() => exportConversationFlow(menu.conv))} />
            {menu.conv.archivedAt
              ? <MenuItem icon={<ArchiveRestore size={14} />} label={tr('Desarchivar')} onSelect={() => menuAction(() => setArchived(menu.conv, false))} />
              : <MenuItem icon={<Archive size={14} />} label={tr('Archivar')} onSelect={() => menuAction(() => setArchived(menu.conv, true), true)} />}
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger label={tr('Eliminar')} onSelect={() => menuAction(() => deleteConversationFlow(menu.conv), true)} />
          </>
        )}
      </Popover>
    </div>
  );
}

function openContext(event: MouseEvent<HTMLDivElement>, onMenu: (target: MenuTarget) => void) {
  event.preventDefault();
  const anchor = event.currentTarget.querySelector<HTMLButtonElement>('.tree-actions');
  if (anchor) onMenu({ anchor, point: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined });
}

function TreeActions({ label, open, menuId, onClick }: {
  label: string;
  open: boolean;
  menuId: string;
  onClick: (anchor: HTMLButtonElement) => void;
}) {
  return (
    <button type="button" className="tree-actions" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} data-open={open || undefined} data-tip={label}
      onClick={(event) => onClick(event.currentTarget)}>
      <Ellipsis size={15} aria-hidden />
    </button>
  );
}

function ConversationRow({ conv, open, menuId, onMenu }: {
  conv: Conversation;
  open: boolean;
  menuId: string;
  onMenu: (target: MenuTarget | null) => void;
}) {
  const active = useStore((s) => s.activeConversationId === conv.id && s.view === 'chat');
  const running = useStore((s) => s.runs[conv.id]?.agent);
  const phase = useStore((s) => s.runs[conv.id] && turnPhase(s.runs[conv.id]));
  // Un plan o una pregunta que espera al usuario (fase 4) cuenta como espera aunque la ejecución siga activa o ya no exista.
  const asks = useStore((s) => (s.pendingInteractions[conv.id] ?? 0) > 0);
  const waiting = phase === 'waiting' || asks;
  const select = useStore((s) => s.selectConversation);
  const origin = conv.origin && 'kind' in conv.origin ? conv.origin : null;
  const kind = origin?.kind ?? null;
  const originTip = origin?.kind === 'fork'
    ? `${displayTitle(conv.title)}\n${tr('Bifurcada de «{original}»', { original: displayTitle(origin.title) })}`
    : origin?.kind === 'import' ? `${displayTitle(conv.title)}\n${tr('Importada de {agent}', { agent: AGENT_NAME[origin.agent] })}` : null;
  return (
    <div className="tree-row" data-active={active || undefined} onContextMenu={(event) => openContext(event, onMenu)}>
      <button
        className="tree-conv"
        data-active={active || undefined}
        aria-current={active ? 'page' : undefined}
        onClick={() => void select(conv.id)}
      >
        {active && <motion.span layoutId="conv-active" className="tree-conv-active" transition={SPRING.pill} />}
        <span className="relative flex min-w-0 flex-1 items-center gap-2">
          {running ? (
            <span className="tree-conv-ic" aria-hidden>
              <Mascot agent={running} state="idle" size={18} animated={false} />
            </span>
          ) : (
            <span className="tree-conv-ic" data-agent={conv.lastAgent ?? undefined} aria-hidden>
              {kind === 'fork' ? <GitFork size={13} strokeWidth={1.7} />
                : kind === 'import' ? <ArrowDownToLine size={13} strokeWidth={1.7} />
                : <MessageSquare size={13} strokeWidth={1.7} />}
            </span>
          )}
          {running && <span className="sr-only">{AGENT_NAME[running]} {phase && TURN_LABEL[phase]}</span>}
          {kind && <span className="sr-only">{kind === 'fork' ? tr('Bifurcada') : tr('Importada')}</span>}
          {asks && <span className="sr-only">{tr('Espera tu respuesta')}</span>}
          <span className="truncate" data-tip={originTip ?? displayTitle(conv.title)} data-tip-truncated={originTip ? undefined : true}>{displayTitle(conv.title)}</span>
          {conv.pinnedAt && <Pin size={10} strokeWidth={2} className="tree-conv-pin" aria-label={tr('Fijada')} />}
        </span>
        <span className="tree-conv-time relative" aria-hidden={Boolean(running) || undefined}>
          {waiting ? <span className="tree-busy" data-waiting>{phase === 'waiting' ? 'permiso' : tr('espera')}</span> : running ? <span className="tree-busy">{phase === 'stopping' ? 'parando' : 'activo'}</span> : <time data-tip={fmtRelative(conv.updatedAt)}>{fmtShortRelative(conv.updatedAt)}</time>}
        </span>
      </button>
      <TreeActions label={tr('Acciones de {name}', { name: conv.title })} open={open} menuId={menuId}
        onClick={(anchor) => onMenu(open ? null : { anchor })} />
    </div>
  );
}

/**
 * Worktree dentro del árbol del proyecto: nombre, rama, cambios pendientes y sus conversaciones.
 * El estado de Git se lee bajo demanda (al desplegar el proyecto o elegir el espacio), nunca en bucle.
 */
function WorktreeNode({ worktree: w, conversations, menu, menuId, projectOpen, setMenu }: {
  worktree: Worktree;
  conversations: Conversation[];
  menu: Menu | null;
  menuId: string;
  projectOpen: boolean;
  setMenu: (menu: Menu | null) => void;
}) {
  const active = useStore((s) => s.activeWorktreeId === w.id && s.view === 'chat');
  const status = useStore((s) => s.worktreeStatus[w.id]);
  const selectSpace = useStore((s) => s.selectSpace);
  const newConversation = useStore((s) => s.newConversation);
  const refresh = useStore((s) => s.refreshWorktreeStatus);
  const [open, setOpen] = useState(active || conversations.some((c) => c.id === useStore.getState().activeConversationId));
  const waiting = useWaiting();
  useEffect(() => {
    if (projectOpen && w.exists && !w.retired) void refresh(w.id);
  }, [projectOpen, w.id, w.exists, w.retired, refresh]);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  const pending = status ? status.changed + status.untracked : 0;
  const actionsOpen = menu?.kind === 'worktree' && menu.worktree.id === w.id;
  const openActions = (target: MenuTarget) => setMenu({ kind: 'worktree', worktree: w, ...target });
  const state = w.retired ? tr('retirado') : !w.exists ? tr('no disponible') : null;
  return (
    <div className="tree-space" data-open={open || undefined}>
      <div className="tree-row" data-active={active || undefined} onContextMenu={w.retired ? undefined : (event) => openContext(event, openActions)}>
        <button
          className="tree-worktree"
          data-active={active || undefined}
          data-state={w.retired ? 'retired' : !w.exists ? 'missing' : undefined}
          aria-expanded={open}
          aria-current={active ? 'location' : undefined}
          onClick={() => {
            if (w.retired) { setOpen(!open); return; }
            if (!active) { setOpen(true); void selectSpace(w.projectId, w.id); } else setOpen(!open);
          }}
        >
          <span className="tree-chev" aria-hidden><ChevronRight size={11} strokeWidth={2.2} /></span>
          <GitBranch size={13} strokeWidth={1.8} className="tree-worktree-ic" aria-hidden />
          <span className="tree-worktree-name truncate" data-tip={`${w.label}${w.branch ? ` · ${w.branch}` : ''}\n${w.path}`}>{w.label}</span>
          {w.branch && w.branch !== w.label && <span className="tree-worktree-branch truncate">{w.branch}</span>}
          {state && <span className="tree-worktree-state">{state}</span>}
          {!open && <WaitDot count={conversations.filter((c) => waiting.has(c.id)).length} />}
          {!state && pending > 0 && (
            <span className="tree-dirty" aria-label={tr('{n} cambios pendientes', { n: pending })} data-tip={tr('{n} cambios pendientes', { n: pending })} />
          )}
        </button>
        {!w.retired && <TreeActions label={tr('Acciones de {name}', { name: w.label })} open={actionsOpen} menuId={menuId}
          onClick={(anchor) => actionsOpen ? setMenu(null) : openActions({ anchor })} />}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            className="tree-space-children overflow-hidden"
          >
            {conversations.length === 0 && !w.retired && (
              <button className="tree-conv tree-conv-empty" disabled={!w.exists} onClick={() => void newConversation(w.projectId, w.id)}>
                <MessageSquarePlus size={13} strokeWidth={1.7} className="relative" />
                <span className="relative truncate">{tr('Sin conversaciones · crear una')}</span>
              </button>
            )}
            {conversations.map((c) => {
              const rowOpen = menu?.kind === 'conversation' && menu.conv.id === c.id;
              return <ConversationRow key={c.id} conv={c} open={rowOpen} menuId={menuId}
                onMenu={(target) => setMenu(target ? { kind: 'conversation', conv: c, ...target } : null)} />;
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Ellipsis, FileDown, Folder, FolderOpen, MessagesSquare, FolderPlus, MessageSquare, MessageSquarePlus, PanelLeftOpen, Pencil, Settings2, Trash2, X } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useStore } from '../../state/store';
import type { Conversation, Project } from '../../lib/types';
import { Popover, MenuItem, MenuSeparator } from '../ui/Popover';
import { api, errorText } from '../../lib/ipc';
import { confirmDialog, promptDialog } from '../ui/Dialog';
import { AGENT_NAME, fmtRelative, fmtShortRelative } from '../../lib/format';
import { Mascot } from '../mascot/Mascot';
import { useLayout } from '../../hooks/useLayout';
import { DistributionLinks } from '../distribution/Distribution';
import { turnPhase, TURN_LABEL } from '../../lib/activity';
import { SPRING } from '../../lib/motion';

type MenuTarget = { anchor: HTMLButtonElement; point?: { x: number; y: number } };
type Menu = MenuTarget & (
  { kind: 'project'; project: Project } |
  { kind: 'conversation'; conv: Conversation }
);

export async function renameConversationFlow(conv: Conversation) {
  const title = await promptDialog({ title: 'Renombrar conversación', confirmLabel: 'Renombrar', initial: conv.title });
  if (title) await useStore.getState().renameConversation(conv.id, title);
}

export async function deleteConversationFlow(conv: Conversation) {
  const ok = await confirmDialog({
    title: '¿Eliminar esta conversación?',
    body: `«${conv.title}» y sus mensajes se borrarán de Duovra. Las sesiones internas de cada agente no se modifican.`,
    confirmLabel: 'Eliminar conversación',
    danger: true,
  });
  if (ok) await useStore.getState().deleteConversation(conv.id);
}

/** Guarda la conversación persistida como Markdown. El selector nativo elige la ubicación. */
export async function exportConversationFlow(conv: Conversation) {
  try {
    const saved = await api.exportConversation(conv.id);
    if (saved) useStore.getState().toast(`Conversación exportada en «${saved.split(/[\/]/).pop()}».`);
  } catch (error) {
    useStore.getState().toast(errorText(error), 'error');
  }
}

export async function renameProjectFlow(p: Project) {
  const name = await promptDialog({ title: 'Renombrar proyecto', confirmLabel: 'Renombrar', initial: p.name });
  if (name) await useStore.getState().renameProject(p.id, name);
}

export async function deleteProjectFlow(p: Project) {
  const ok = await confirmDialog({
    title: '¿Quitar este proyecto?',
    body: `Se quitará «${p.name}» y todas sus conversaciones de la aplicación. La carpeta ${p.path} no se toca.`,
    confirmLabel: 'Quitar proyecto',
    danger: true,
  });
  if (ok) await useStore.getState().deleteProject(p.id);
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
        aria-label="Navegación"
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
      aria-label="Navegación"
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
        <span>Proyectos y conversaciones</span>
        <button ref={closeRef} type="button" className="btn-icon" aria-label="Cerrar navegación" onClick={close}><X size={16} aria-hidden /></button>
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
  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-3">
      <button data-tip-side="right" className="rail-btn" aria-label="Mostrar proyectos y conversaciones" data-tip="Mostrar proyectos y conversaciones" onClick={expand}>
        <PanelLeftOpen size={17} strokeWidth={1.6} />
      </button>
      <span className="rail-sep" aria-hidden />
      <button data-tip-side="right" className="rail-btn" aria-label="Conversación" data-tip="Conversación" aria-pressed={view === 'chat' && !settingsOpen} onClick={() => setView('chat')}>
        <MessagesSquare size={17} strokeWidth={1.6} />
      </button>
      <button data-tip-side="right" className="rail-btn rail-btn-accent" aria-label="Nueva conversación" data-tip="Nueva conversación (Ctrl+N)" onClick={() => void newConversation()}>
        <MessageSquarePlus size={17} strokeWidth={1.6} />
      </button>
      <div className="flex-1" />
      <DistributionLinks rail />
      <button data-tip-side="right" className="rail-btn" aria-label="Ajustes" data-tip="Ajustes (Ctrl+,)" aria-pressed={settingsOpen} onClick={() => setView('settings')}>
        <Settings2 size={17} strokeWidth={1.6} />
      </button>
    </div>
  );
}

function Full() {
  const projects = useStore((s) => s.projects);
  const conversations = useStore((s) => s.conversations);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const newConversation = useStore((s) => s.newConversation);
  const addProject = useStore((s) => s.addProject);
  const setView = useStore((s) => s.setView);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const menuId = useId();
  const treeRef = useRef<HTMLElement>(null);

  const byProject = useMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of conversations) {
      const list = m.get(c.projectId) ?? [];
      list.push(c);
      m.set(c.projectId, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [conversations]);

  const isOpen = (id: string) => expanded[id] ?? id === activeProjectId;

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
          Nueva conversación
        </button>
      </div>

      <div className="side-section">
        <span>Proyectos</span>
        <button className="side-section-btn" aria-label="Añadir proyecto" data-tip="Añadir carpeta como proyecto" onClick={() => void addProject()}>
          <FolderPlus size={14} strokeWidth={1.7} />
        </button>
      </div>
      <nav ref={treeRef} tabIndex={-1} className="side-tree min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Proyectos y conversaciones">
        {projects.length === 0 && (
          <div className="mx-1 mt-3 rounded-[14px] p-3 text-[13px] leading-relaxed muted" style={{ background: 'var(--surface-sunken)' }}>
            Añade la carpeta de un proyecto para empezar a conversar con Claude Code o Codex.
            <button className="btn btn-primary mt-3 w-full justify-center" onClick={() => void addProject()}>
              <FolderPlus size={15} /> Añadir proyecto
            </button>
          </div>
        )}
        {projects.map((p) => {
          const list = byProject.get(p.id) ?? [];
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
                  <span className="tree-count">{list.length || ''}</span>
                </button>
                <TreeActions label={`Acciones de ${p.name}`} open={actionsOpen} menuId={menuId}
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
                    {list.length === 0 && (
                      <button className="tree-conv tree-conv-empty" onClick={() => void newConversation(p.id)}>
                        <MessageSquarePlus size={13} strokeWidth={1.7} className="relative" />
                        <span className="relative truncate">Sin conversaciones · crear una</span>
                      </button>
                    )}
                    {list.map((c) => {
                      const open = menu?.kind === 'conversation' && menu.conv.id === c.id;
                      return <ConversationRow key={c.id} conv={c} open={open} menuId={menuId}
                        onMenu={(target) => setMenu(target ? { kind: 'conversation', conv: c, ...target } : null)} />;
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      <div className="side-foot">
        <button className="side-link" data-active={settingsOpen || undefined} onClick={() => setView('settings')}>
          <Settings2 size={16} strokeWidth={1.6} /> Ajustes
        </button>
        <DistributionLinks />
      </div>

      <Popover open={menu !== null} onClose={() => setMenu(null)} anchor={menu?.anchor ?? null} point={menu?.point} width={232}
        menuId={menuId} ariaLabel={menu?.anchor.ariaLabel ?? undefined}>
        {menu?.kind === 'project' && (
          <>
            <MenuItem icon={<MessageSquarePlus size={14} />} label="Nueva conversación" onSelect={() => menuAction(() => newConversation(menu.project.id))} />
            <MenuItem icon={<Pencil size={14} />} label="Renombrar" onSelect={() => menuAction(() => renameProjectFlow(menu.project))} />
            <MenuItem icon={<FolderOpen size={14} />} label="Mostrar en el Explorador" onSelect={() => menuAction(() => revealItemInDir(menu.project.path))} />
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} danger label="Quitar de la aplicación" onSelect={() => menuAction(() => deleteProjectFlow(menu.project), true)} />
          </>
        )}
        {menu?.kind === 'conversation' && (
          <>
            <MenuItem icon={<Pencil size={14} />} label="Renombrar" onSelect={() => menuAction(() => renameConversationFlow(menu.conv))} />
            <MenuItem icon={<FileDown size={14} />} label="Exportar conversación" onSelect={() => menuAction(() => exportConversationFlow(menu.conv))} />
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger label="Eliminar" onSelect={() => menuAction(() => deleteConversationFlow(menu.conv), true)} />
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
  const waiting = phase === 'waiting';
  const select = useStore((s) => s.selectConversation);
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
              <MessageSquare size={13} strokeWidth={1.7} />
            </span>
          )}
          {running && <span className="sr-only">{AGENT_NAME[running]} {phase && TURN_LABEL[phase]}</span>}
          <span className="truncate" data-tip={conv.title} data-tip-truncated>{conv.title}</span>
        </span>
        <span className="tree-conv-time relative" aria-hidden={Boolean(running) || undefined}>
          {waiting ? <span className="tree-busy" data-waiting>permiso</span> : running ? <span className="tree-busy">{phase === 'stopping' ? 'parando' : 'activo'}</span> : <time data-tip={fmtRelative(conv.updatedAt)}>{fmtShortRelative(conv.updatedAt)}</time>}
        </span>
      </button>
      <TreeActions label={`Acciones de ${conv.title}`} open={open} menuId={menuId}
        onClick={(anchor) => onMenu(open ? null : { anchor })} />
    </div>
  );
}

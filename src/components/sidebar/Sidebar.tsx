import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, FolderOpen, FolderPlus, LayoutGrid, MessageSquarePlus, PanelLeftOpen, Pencil, Settings2, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useStore } from '../../state/store';
import type { Conversation, Project } from '../../lib/types';
import { Popover, MenuItem, MenuSeparator } from '../ui/Popover';
import { confirmDialog, promptDialog } from '../ui/Dialog';
import { AGENT_NAME, fmtRelative } from '../../lib/format';
import { AgentGlyph } from '../ui/AgentGlyph';
import { useLayout } from '../../hooks/useLayout';
import { DistributionLinks } from '../distribution/Distribution';

type Menu =
  | { kind: 'project'; project: Project; x: number; y: number }
  | { kind: 'conversation'; conv: Conversation; x: number; y: number }
  | null;

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
        className="mat-primary sidebar relative z-20 my-2.5 ml-2.5 flex shrink-0 flex-col overflow-hidden"
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

      {/* Ventanas estrechas: la navegación completa se abre como cajón superpuesto (AUD-002). */}
      <AnimatePresence>
        {compactNav && drawer && (
          <>
            <motion.div
              key="scrim"
              className="nav-scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onPointerDown={() => setDrawer(false)}
              aria-hidden
            />
            <motion.aside
              key="drawer"
              className="mat-primary nav-drawer flex flex-col overflow-hidden"
              initial={{ x: '-108%' }}
              animate={{ x: 0 }}
              exit={{ x: '-108%', transition: { type: 'spring', bounce: 0, duration: 0.3 } }}
              transition={{ type: 'spring', bounce: 0.16, duration: 0.46 }}
              aria-label="Navegación"
              role="dialog"
              aria-modal="false"
            >
              <Full />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function Rail({ onExpand }: { onExpand?: () => void }) {
  const newConversation = useStore((s) => s.newConversation);
  const setView = useStore((s) => s.setView);
  const setSetting = useStore((s) => s.setSetting);
  const view = useStore((s) => s.view);
  const expand = onExpand ?? (() => void setSetting('ui.sidebarCollapsed', false));
  return (
    <div className="flex h-full flex-col items-center gap-1.5 py-3">
      <button data-tip-side="right" className="rail-btn" aria-label="Mostrar proyectos y conversaciones" data-tip="Mostrar proyectos y conversaciones" onClick={expand}>
        <PanelLeftOpen size={17} strokeWidth={1.6} />
      </button>
      <button data-tip-side="right" className="rail-btn rail-btn-accent" aria-label="Nueva conversación" data-tip="Nueva conversación (Ctrl+N)" onClick={() => void newConversation()}>
        <MessageSquarePlus size={17} strokeWidth={1.6} />
      </button>
      <button data-tip-side="right" className="rail-btn" aria-label="Proyectos y conversaciones" data-tip="Proyectos y conversaciones" aria-pressed={view === 'projects'} onClick={() => setView('projects')}>
        <LayoutGrid size={17} strokeWidth={1.6} />
      </button>
      <div className="flex-1" />
      <DistributionLinks rail />
      <button data-tip-side="right" className="rail-btn" aria-label="Ajustes" data-tip="Ajustes (Ctrl+,)" aria-pressed={view === 'settings'} onClick={() => setView('settings')}>
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
  const view = useStore((s) => s.view);
  const [menu, setMenu] = useState<Menu>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  return (
    <div className="flex h-full min-h-0 w-[var(--sidebar-full-w,var(--sidebar-w))] min-w-[var(--sidebar-full-w,var(--sidebar-w))] flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button className="new-conv-btn flex-1" onClick={() => void newConversation()} disabled={!activeProjectId}>
          <MessageSquarePlus size={16} strokeWidth={1.7} />
          Nueva conversación
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Proyectos y conversaciones">
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
          return (
            <div key={p.id} className="mb-1">
              <button
                className="tree-project"
                data-active={p.id === activeProjectId || undefined}
                onClick={() => setExpanded((e) => ({ ...e, [p.id]: !open }))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: 'project', project: p, x: e.clientX, y: e.clientY });
                }}
                aria-expanded={open}
              >
                <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.18 }} className="grid place-items-center faint">
                  <ChevronRight size={13} strokeWidth={2} />
                </motion.span>
                <span className="truncate">{p.name}</span>
                <span className="ml-auto text-[11px] faint">{list.length || ''}</span>
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                    className="overflow-hidden"
                  >
                    {list.length === 0 && (
                      <button className="tree-conv faint" onClick={() => void newConversation(p.id)}>
                        <span className="truncate">Sin conversaciones · crear una</span>
                      </button>
                    )}
                    {list.map((c) => (
                      <ConversationRow key={c.id} conv={c} onMenu={(x, y) => setMenu({ kind: 'conversation', conv: c, x, y })} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-0.5 border-t px-2 py-2" style={{ borderColor: 'var(--hairline)' }}>
        <button className="side-link" data-active={view === 'projects' || undefined} onClick={() => setView('projects')}>
          <LayoutGrid size={16} strokeWidth={1.6} /> Proyectos y conversaciones
        </button>
        <button className="side-link" data-active={view === 'settings' || undefined} onClick={() => setView('settings')}>
          <Settings2 size={16} strokeWidth={1.6} /> Ajustes
        </button>
        <DistributionLinks />
      </div>

      <Popover open={menu !== null} onClose={() => setMenu(null)} anchor={menu ? { x: menu.x, y: menu.y } : null} width={232}>
        {menu?.kind === 'project' && (
          <>
            <MenuItem icon={<MessageSquarePlus size={14} />} label="Nueva conversación" onSelect={() => { setMenu(null); void newConversation(menu.project.id); }} />
            <MenuItem icon={<Pencil size={14} />} label="Renombrar" onSelect={() => { setMenu(null); void renameProjectFlow(menu.project); }} />
            <MenuItem icon={<FolderOpen size={14} />} label="Mostrar en el Explorador" onSelect={() => { setMenu(null); void revealItemInDir(menu.project.path); }} />
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} danger label="Quitar de la aplicación" onSelect={() => { setMenu(null); void deleteProjectFlow(menu.project); }} />
          </>
        )}
        {menu?.kind === 'conversation' && (
          <>
            <MenuItem icon={<Pencil size={14} />} label="Renombrar" onSelect={() => { setMenu(null); void renameConversationFlow(menu.conv); }} />
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger label="Eliminar" onSelect={() => { setMenu(null); void deleteConversationFlow(menu.conv); }} />
          </>
        )}
      </Popover>
    </div>
  );
}

function ConversationRow({ conv, onMenu }: { conv: Conversation; onMenu: (x: number, y: number) => void }) {
  const active = useStore((s) => s.activeConversationId === conv.id && s.view === 'chat');
  const running = useStore((s) => s.runs[conv.id]);
  const waiting = running && running.approvals.length > 0;
  const select = useStore((s) => s.selectConversation);
  return (
    <button
      className="tree-conv"
      data-active={active || undefined}
      onClick={() => void select(conv.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {active && <motion.span layoutId="conv-active" className="tree-conv-active" transition={{ type: 'spring', stiffness: 440, damping: 31 }} />}
      <span className="relative flex min-w-0 flex-1 items-center gap-2">
        {running ? (
          <AgentGlyph agent={running.agent} size={16} />
        ) : (
          conv.lastAgent && <span className="conv-agent-dot" style={{ background: `var(--agent-${conv.lastAgent})` }} />
        )}
        {running && <span className="sr-only">{AGENT_NAME[running.agent]} trabajando.</span>}
        <span className="truncate" data-tip={conv.title} data-tip-truncated>{conv.title}</span>
      </span>
      <span className="relative text-[11px] faint">
        {waiting ? <span style={{ color: 'var(--warning)' }}>permiso</span> : running ? <span className="working-dots"><span /><span /><span /></span> : fmtRelative(conv.updatedAt)}
      </span>
    </button>
  );
}

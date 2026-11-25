import { ChevronDown, ChevronRight, Folder, FolderPlus, GitBranch, MessageSquare, PanelLeft, PanelRight, Check, Settings2 } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { isListed, useStore } from '../../state/store';
import { Popover, MenuItem, MenuSeparator, MenuLabel } from '../ui/Popover';
import { WindowControls } from './WindowControls';
import { basename, displayTitle } from '../../lib/format';
import { useLayout } from '../../hooks/useLayout';
import duovraMark from '../../assets/duovra-mark.svg';
import { tr } from '../../i18n';

/** Conversaciones recientes del proyecto que ofrece el desplegable de la cápsula. */
const RECENT = 8;

/**
 * Barra superior · Propuesta B (1.0.9): marca a la izquierda, una única cápsula central con
 * proyecto y conversación, y Workbench más los controles nativos a la derecha.
 */
export function TitleBar() {
  const projects = useStore((s) => s.projects);
  const qaMode = useStore((s) => s.qaMode);
  const appVersion = useStore((s) => s.appVersion);
  const demo = import.meta.env.VITE_DUOVRA_QA === '1';
  const beta = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(appVersion);
  const edition = demo ? tr('Demostración') : qaMode ? 'RC1 · QA' : beta ? `${beta[1]} Beta ${beta[2]}` : null;
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const activeWorktreeId = useStore((s) => s.activeWorktreeId);
  const allWorktrees = useStore((s) => s.worktrees);
  const selectSpace = useStore((s) => s.selectSpace);
  const selectProject = useStore((s) => s.selectProject);
  const selectConversation = useStore((s) => s.selectConversation);
  const addProject = useStore((s) => s.addProject);
  const collapsed = useStore((s) => s.settings['ui.sidebarCollapsed'] === true);
  const setSetting = useStore((s) => s.setSetting);
  const drawer = useStore((s) => s.navDrawer);
  const setDrawer = useStore((s) => s.setNavDrawer);
  const layout = useLayout();
  const { compactNav } = layout;
  const navShown = compactNav ? drawer : !collapsed;
  const toggleNav = () => (compactNav ? setDrawer(!drawer) : void setSetting('ui.sidebarCollapsed', !collapsed));
  const panel = useStore((s) => s.panel);
  const togglePanel = useStore((s) => s.togglePanel);
  const [open, setOpen] = useState(false);
  const capsule = useRef<HTMLButtonElement>(null);
  const project = projects.find((p) => p.id === activeProjectId);
  const view = useStore((s) => s.view);
  const rawThread = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.title);
  const thread = rawThread && displayTitle(rawThread);
  const location = view === 'projects' ? tr('Proyectos') : thread;
  const conversations = useStore((s) => s.conversations);
  // Espacios del proyecto activo: directorio principal y sus worktrees (sin los retirados).
  const spaces = useMemo(() => allWorktrees.filter((w) => w.projectId === activeProjectId && !w.retired), [allWorktrees, activeProjectId]);
  const worktree = allWorktrees.find((w) => w.id === activeWorktreeId);
  const recent = useMemo(
    () => (open ? conversations.filter((c) => c.projectId === activeProjectId && (c.worktreeId ?? null) === activeWorktreeId && isListed(c))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT) : []),
    [open, conversations, activeProjectId, activeWorktreeId],
  );
  const header = useRef<HTMLElement>(null);
  const leading = useRef<HTMLDivElement>(null);
  const trailing = useRef<HTMLDivElement>(null);
  const inlinePanel = view === 'chat' && panel.open && layout.panelMode === 'inline';
  const place = useCenteredCapsule(header, leading, trailing, layout.sidebarW, inlinePanel ? layout.panelW : 0, `${project?.name}${worktree?.label}${location}`);
  const projectName = project ? project.name : tr('Sin proyecto');
  // En el directorio principal no se repite nada: la cápsula solo nombra el worktree cuando hay uno activo.
  const spaceName = worktree && view === 'chat' ? worktree.label : null;
  const fullLabel = [projectName, spaceName, location].filter(Boolean).join(' › ');

  return (
    <header
      data-tauri-drag-region
      ref={header}
      className="titlebar relative z-30 flex shrink-0 items-center gap-2 pl-2.5"
      style={{ height: 'var(--titlebar-h)' }}
    >
      <div ref={leading} className="titlebar-leading" data-tauri-drag-region>
        <button
          className="btn-icon"
          aria-label={navShown ? tr('Ocultar barra lateral') : tr('Mostrar barra lateral')}
          data-tip={`${navShown ? tr('Ocultar barra lateral') : tr('Mostrar barra lateral')} (Ctrl+B)`}
          data-tip-side="bottom"
          aria-pressed={navShown}
          onClick={toggleNav}
        >
          <PanelLeft size={16} strokeWidth={1.6} />
        </button>

        <span className="brand" data-tauri-drag-region title={qaMode === 'fixture' ? 'Proveedores simulados' : qaMode ? 'Proveedores reales' : appVersion ? `Duovra ${appVersion}` : undefined}>
          <img src={duovraMark} alt="" width={16} height={16} draggable={false} />
          <span className="brand-name">Duovra{edition && ' ' + edition}</span>
        </span>
      </div>

      {/* Cápsula central: proyecto › worktree › conversación. Cada tramo es un `.capsule-seg`. */}
      <div className="titlebar-center" style={place} data-placed={place ? '' : undefined}>
        <button
          ref={capsule}
          className="title-capsule"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={tr('Proyecto y conversación: {location}', { location: fullLabel })}
          data-space={spaceName ? '' : undefined}
          data-tip={fullLabel}
          data-tip-side="bottom"
        >
          <Folder size={14} strokeWidth={1.7} className="capsule-folder" aria-hidden />
          <span className="capsule-seg capsule-project">{projectName}</span>
          {spaceName && (
            <>
              <ChevronRight size={13} strokeWidth={1.8} className="capsule-sep" aria-hidden />
              <GitBranch size={12} strokeWidth={1.9} className="capsule-branch" aria-hidden />
              <span className="capsule-seg capsule-space">{spaceName}</span>
            </>
          )}
          {location && (
            <>
              <ChevronRight size={13} strokeWidth={1.8} className="capsule-sep" aria-hidden />
              <span className="capsule-seg capsule-thread">{location}</span>
            </>
          )}
          <ChevronDown size={13} strokeWidth={1.8} className="capsule-chevron" aria-hidden />
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchor={capsule.current} width={300} ariaLabel={tr('Proyectos y conversaciones')}>
          {spaces.length > 0 && (
            <>
              <MenuLabel>{tr('Espacios de {project}', { project: projectName })}</MenuLabel>
              <MenuItem
                selected={!activeWorktreeId}
                icon={!activeWorktreeId ? <Check size={14} /> : <Folder size={14} />}
                label={tr('Directorio principal')}
                onSelect={() => { setOpen(false); if (activeProjectId) void selectSpace(activeProjectId, null); }}
              />
              {spaces.map((w) => (
                <MenuItem
                  key={w.id}
                  selected={w.id === activeWorktreeId}
                  disabled={!w.exists}
                  icon={w.id === activeWorktreeId ? <Check size={14} /> : <GitBranch size={14} />}
                  label={w.label}
                  hint={w.exists ? w.branch ?? undefined : tr('no disponible')}
                  onSelect={() => { setOpen(false); void selectSpace(w.projectId, w.id); }}
                />
              ))}
              <MenuSeparator />
            </>
          )}
          {recent.length > 0 && <MenuLabel>{spaceName ? tr('Conversaciones de {project}', { project: spaceName }) : tr('Conversaciones de {project}', { project: projectName })}</MenuLabel>}
          {recent.map((c) => (
            <MenuItem
              key={c.id}
              selected={c.id === activeConversationId}
              icon={c.id === activeConversationId ? <Check size={14} /> : <MessageSquare size={14} />}
              label={displayTitle(c.title)}
              onSelect={() => {
                setOpen(false);
                void selectConversation(c.id);
              }}
            />
          ))}
          {recent.length > 0 && <MenuSeparator />}
          {projects.length > 0 && <MenuLabel>{tr('Proyectos')}</MenuLabel>}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              selected={p.id === activeProjectId}
              icon={p.id === activeProjectId ? <Check size={14} /> : <Folder size={14} />}
              label={p.name}
              hint={basename(p.path) !== p.name ? basename(p.path) : undefined}
              onSelect={() => {
                setOpen(false);
                void selectProject(p.id);
              }}
            />
          ))}
          {projects.length > 0 && <MenuSeparator />}
          <MenuItem
            icon={<FolderPlus size={14} />}
            label={tr('Añadir carpeta como proyecto')}
            onSelect={() => {
              setOpen(false);
              void addProject();
            }}
          />
          <MenuItem
            icon={<Settings2 size={14} />}
            label={tr('Gestionar proyectos')}
            onSelect={() => {
              setOpen(false);
              useStore.getState().setView('projects');
            }}
          />
        </Popover>
      </div>

      <div data-tauri-drag-region className="h-full flex-1" />
      <div ref={trailing} className="titlebar-trailing">
        {view === 'chat' && (
          <button
            id="workbench-toggle"
            className="btn-icon titlebar-workbench"
            aria-controls={panel.open ? 'workbench' : undefined}
            aria-label={panel.open ? tr('Ocultar Workbench') : tr('Mostrar Workbench')}
            data-tip={panel.open ? tr('Ocultar Workbench') : tr('Mostrar Workbench')}
            data-tip-side="bottom"
            aria-expanded={panel.open}
            onClick={togglePanel}
          >
            <PanelRight size={16} strokeWidth={1.6} aria-hidden />
          </button>
        )}
        <WindowControls />
      </div>
    </header>
  );
}

/**
 * La cápsula se centra sobre el área útil de la conversación (entre la barra lateral y Workbench en
 * línea), no sobre la ventana. Si el hueco libre a ambos lados de ese centro no alcanza, se coloca en
 * el centro del espacio que dejan la marca y los controles de la derecha. Siempre se recorta con
 * elipsis, nunca se solapa ni desplaza a los demás elementos.
 */
const GAP = 12;
const MIN_CENTERED = 220;
function useCenteredCapsule(
  header: React.RefObject<HTMLElement | null>, left: React.RefObject<HTMLElement | null>, right: React.RefObject<HTMLElement | null>,
  sidebarW: number, panelW: number, content: string,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const bar = header.current;
    if (!bar) return;
    const measure = () => {
      const box = bar.getBoundingClientRect();
      const start = (left.current?.getBoundingClientRect().right ?? box.left) - box.left + GAP;
      const end = (right.current?.getBoundingClientRect().left ?? box.right) - box.left - GAP;
      const center = (sidebarW + box.width - panelW) / 2;
      const half = Math.min(center - start, end - center);
      const next = half * 2 >= MIN_CENTERED
        ? { left: center, maxWidth: half * 2 }
        : { left: (start + end) / 2, maxWidth: Math.max(0, end - start) };
      setStyle((prev) => prev && prev.left === next.left && prev.maxWidth === next.maxWidth ? prev : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (left.current) observer.observe(left.current);
    if (right.current) observer.observe(right.current);
    return () => observer.disconnect();
  }, [header, left, right, sidebarW, panelW, content]);
  return style;
}

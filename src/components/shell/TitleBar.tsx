import { ChevronDown, FolderPlus, PanelLeft, PanelRight, Check } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../state/store';
import { Popover, MenuItem, MenuSeparator, MenuLabel } from '../ui/Popover';
import { WindowControls } from './WindowControls';
import { basename } from '../../lib/format';
import { useLayout } from '../../hooks/useLayout';
import duovraMark from '../../assets/duovra-mark.svg';

export function TitleBar() {
  const projects = useStore((s) => s.projects);
  const qaMode = useStore((s) => s.qaMode);
  const appVersion = useStore((s) => s.appVersion);
  const demo = import.meta.env.VITE_DUOVRA_QA === '1';
  const beta = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(appVersion);
  const edition = demo ? 'Demostración' : qaMode ? 'RC1 · QA' : beta ? `${beta[1]} Beta ${beta[2]}` : null;
  const activeProjectId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
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
  const thread = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.title);
  const location = view === 'projects' ? 'Proyectos' : thread;
  const header = useRef<HTMLElement>(null);
  const crumbs = useRef<HTMLDivElement>(null);
  const trailing = useRef<HTMLDivElement>(null);
  const inlinePanel = view === 'chat' && panel.open && layout.panelMode === 'inline';
  const place = useCenteredTitle(header, crumbs, trailing, layout.sidebarW, inlinePanel ? layout.panelW : 0, location);

  return (
    <header
      data-tauri-drag-region
      ref={header}
      className="titlebar relative z-30 flex shrink-0 items-center gap-2 pl-2.5"
      style={{ height: 'var(--titlebar-h)' }}
    >
      <button
        className="btn-icon"
        aria-label={navShown ? 'Ocultar barra lateral' : 'Mostrar barra lateral'}
        data-tip={`${navShown ? 'Ocultar' : 'Mostrar'} barra lateral (Ctrl+B)`}
        data-tip-side="bottom"
        aria-pressed={navShown}
        onClick={toggleNav}
      >
        <PanelLeft size={16} strokeWidth={1.6} />
      </button>

      <span className="brand" data-tauri-drag-region title={qaMode === 'fixture' ? 'Proveedores simulados' : qaMode ? 'Proveedores reales' : appVersion ? `Duovra ${appVersion}` : undefined}>
        <img src={duovraMark} alt="" width={22} height={16} draggable={false} />
        <span className="brand-name">Duovra{edition && ' ' + edition}</span>
      </span>

      <div ref={crumbs} className="titlebar-crumbs">
        <button ref={capsule} className="project-capsule" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          <span className="truncate" data-tip={project?.path} data-tip-side="bottom">{project ? project.name : 'Sin proyecto'}</span>
          <ChevronDown size={14} strokeWidth={1.8} className="faint" />
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchor={capsule.current} width={300} ariaLabel="Proyectos">
          {projects.length > 0 && <MenuLabel>Proyectos</MenuLabel>}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              selected={p.id === activeProjectId}
              icon={p.id === activeProjectId ? <Check size={14} /> : <span />}
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
            label="Añadir carpeta como proyecto"
            onSelect={() => {
              setOpen(false);
              void addProject();
            }}
          />
          <MenuItem
            icon={<span />}
            label="Gestionar proyectos"
            onSelect={() => {
              setOpen(false);
              useStore.getState().setView('projects');
            }}
          />
        </Popover>
      </div>

      {location && (
        <div className="titlebar-title" data-tauri-drag-region style={place} data-placed={place ? '' : undefined}>
          <span className="titlebar-title-text" data-tip={location} data-tip-truncated data-tip-side="bottom">{location}</span>
        </div>
      )}

      <div data-tauri-drag-region className="h-full flex-1" />
      <div ref={trailing} className="titlebar-trailing">

      {view === 'chat' && (
        <button
          id="workbench-toggle"
          className="btn titlebar-workbench"
          aria-controls={panel.open ? "workbench" : undefined}
          aria-label={panel.open ? 'Ocultar Workbench' : 'Mostrar Workbench'}
          data-tip={panel.open ? 'Ocultar Workbench' : 'Mostrar Workbench'}
          data-tip-side="bottom"
          aria-expanded={panel.open}
          onClick={togglePanel}
        >
          <PanelRight size={15} strokeWidth={1.6} aria-hidden />
          <span className="titlebar-workbench-text">Workbench</span>
        </button>
      )}
      <WindowControls />
      </div>
    </header>
  );
}

/**
 * El título se centra sobre el área útil de la conversación (entre la barra lateral y Workbench en
 * línea), no sobre la ventana. Si el hueco libre a ambos lados de ese centro no alcanza, se coloca en
 * el centro del espacio que dejan el proyecto y los controles de la derecha. Siempre se recorta con
 * elipsis, nunca se solapa.
 */
const GAP = 14;
const MIN_CENTERED = 180;
function useCenteredTitle(
  header: React.RefObject<HTMLElement | null>, left: React.RefObject<HTMLElement | null>, right: React.RefObject<HTMLElement | null>,
  sidebarW: number, panelW: number, title: string | undefined,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const bar = header.current;
    if (!bar || !title) return;
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
  }, [header, left, right, sidebarW, panelW, title]);
  return style;
}

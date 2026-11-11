import { ChevronDown, FolderPlus, PanelLeft, PanelRight, Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { Popover, MenuItem, MenuSeparator, MenuLabel } from '../ui/Popover';
import { WindowControls } from './WindowControls';
import { basename } from '../../lib/format';
import { useLayout } from '../../hooks/useLayout';
import duovraMark from '../../assets/duovra-mark.svg';

/**
 * Barra superior integrada: cristal luminoso, selector de proyecto en cápsula y controles de
 * ventana. Sin buscador, métricas ni título de conversación (decisión de diseño).
 */
export function TitleBar() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const addProject = useStore((s) => s.addProject);
  const collapsed = useStore((s) => s.settings['ui.sidebarCollapsed'] === true);
  const setSetting = useStore((s) => s.setSetting);
  const drawer = useStore((s) => s.navDrawer);
  const setDrawer = useStore((s) => s.setNavDrawer);
  const { compactNav } = useLayout();
  const navShown = compactNav ? drawer : !collapsed;
  const toggleNav = () => (compactNav ? setDrawer(!drawer) : void setSetting('ui.sidebarCollapsed', !collapsed));
  const panel = useStore((s) => s.panel);
  const togglePanel = useStore((s) => s.togglePanel);
  const [open, setOpen] = useState(false);
  const capsule = useRef<HTMLButtonElement>(null);
  const project = projects.find((p) => p.id === activeProjectId);

  return (
    <header
      data-tauri-drag-region
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

      <span className="brand" data-tauri-drag-region aria-label="Duovra">
        <img src={duovraMark} alt="" width={22} height={16} draggable={false} />
        <span className="brand-name">Duovra</span>
      </span>

      <button ref={capsule} className="project-capsule mat-control" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="capsule-dot" aria-hidden />
        <span className="truncate" data-tip={project?.path} data-tip-side="bottom">{project ? project.name : 'Sin proyecto'}</span>
        <ChevronDown size={14} strokeWidth={1.8} className="faint" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={capsule.current} width={300}>
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

      <div data-tauri-drag-region className="h-full flex-1" />

      {panel.tabs.length > 0 && (
        <button
          className="btn-icon"
          aria-label={panel.open ? 'Ocultar panel de detalles' : 'Mostrar panel de detalles'}
          data-tip={panel.open ? 'Ocultar panel de detalles' : 'Mostrar panel de detalles'}
          data-tip-side="bottom"
          aria-pressed={panel.open}
          onClick={togglePanel}
        >
          <PanelRight size={16} strokeWidth={1.6} />
        </button>
      )}
      <WindowControls />
    </header>
  );
}

import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react';
import { useEffect, type CSSProperties } from 'react';
import { useStore } from './state/store';
import { subscribeRunEvents } from './lib/events';
import { useAppearance } from './hooks/useAppearance';
import { useLayout } from './hooks/useLayout';
import { usePreferences } from './hooks/usePreferences';
import { Background } from './components/shell/Background';
import { TitleBar } from './components/shell/TitleBar';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { RightPanel } from './components/panel/RightPanel';
import { ProjectsView } from './components/projects/ProjectsView';
import { SettingsView } from './components/settings/SettingsView';
import { DialogHost } from './components/ui/Dialog';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TooltipHost } from './components/ui/Tooltip';
import { DistributionProvider } from './components/distribution/Distribution';
import { SPRING } from './lib/motion';

const VIEW_NAME = { chat: 'la conversación', projects: 'Proyectos y conversaciones', settings: 'Ajustes' } as const;

export default function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const view = useStore((s) => s.view);
  const { effective } = useAppearance();
  const layout = useLayout();
  usePreferences(effective);
  const refraction = useStore((s) => s.settings['glass.refraction'] !== false);
  // Refracción real (lente del compositor y cantos ópticos de los paneles): Equilibrada y Completa.
  const optics = refraction && effective !== 'reduced' && !matchMedia('(prefers-reduced-transparency: reduce)').matches;

  useEffect(() => {
    document.documentElement.dataset.optics = optics ? 'on' : 'off';
  }, [optics]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void subscribeRunEvents().then((f) => {
      if (cancelled) f();
      else un = f;
    });
    void useStore.getState().init();
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // Al pasar a una ventana amplia, el cajón de navegación deja de tener sentido.
  useEffect(() => {
    if (!layout.compactNav) useStore.getState().setNavDrawer(false);
  }, [layout.compactNav]);

  // Atajos: Ctrl+N nueva conversación, Ctrl+, ajustes, Ctrl+B barra lateral, Esc cierra capas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const s = useStore.getState();
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void s.newConversation();
      } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        s.setView('settings');
      } else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (window.innerWidth < 940) s.setNavDrawer(!s.navDrawer);
        else void s.setSetting('ui.sidebarCollapsed', !(s.settings['ui.sidebarCollapsed'] === true));
      } else if (e.key === 'Escape' && !document.querySelector('[role="dialog"],[role="menu"]')) {
        if (s.navDrawer) s.setNavDrawer(false);
        else if (s.panel.open) s.closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const vars = { '--sidebar-w': `${layout.sidebarW}px`, '--panel-w': `${layout.panelW}px` } as CSSProperties;

  return (
    <MotionConfig reducedMotion={effective === 'reduced' ? 'always' : 'user'}>
      <DistributionProvider>
      <div className="relative flex h-full flex-col" style={vars}>
        <Background intensity={effective} lens={optics ? (effective === 'full' ? 1 : 0.75) : 0} />
        <TitleBar />
        {bootError ? (
          <div className="relative grid flex-1 place-items-center p-8">
            <div className="mat-primary max-w-[520px] rounded-[22px] p-6">
              <h1 className="m-0 text-[17px] font-semibold">No se pudo iniciar la aplicación</h1>
              <p className="selectable mb-0 mt-2 text-[13px] muted">{bootError}</p>
            </div>
          </div>
        ) : (
          ready && (
            <LayoutGroup>
              <div className="app-body relative flex min-h-0 flex-1" data-panel={layout.panelMode}>
                <Sidebar />
                <motion.main layout="position" className="relative flex min-h-0 min-w-0 flex-1">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={view}
                      className="flex min-h-0 min-w-0 flex-1"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ type: 'spring', bounce: 0, duration: 0.28 }}
                    >
                      <ErrorBoundary area={VIEW_NAME[view]} resetKey={view}>
                        {view === 'chat' && <ChatView refractComposer={effective === 'reduced' || !refraction ? false : effective} />}
                        {view === 'projects' && <ProjectsView />}
                        {view === 'settings' && <SettingsView />}
                      </ErrorBoundary>
                    </motion.div>
                  </AnimatePresence>
                </motion.main>
                {view === 'chat' && (
                  <ErrorBoundary area="el panel de detalles" compact>
                    <RightPanel mode={layout.panelMode} />
                  </ErrorBoundary>
                )}
              </div>
            </LayoutGroup>
          )
        )}
        <Toasts />
        <DialogHost />
        <TooltipHost />
      </div>
      </DistributionProvider>
    </MotionConfig>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className="toast mat-float pointer-events-auto selectable"
            data-tone={t.tone}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.16 } }}
            transition={SPRING.enter}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

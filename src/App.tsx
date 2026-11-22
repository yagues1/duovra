import { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react';
import { useEffect, useState, type CSSProperties } from 'react';
import { useStore } from './state/store';
import { subscribeNotificationOpen, subscribeRunEvents } from './lib/events';
import { useAppearance } from './hooks/useAppearance';
import { useLayout } from './hooks/useLayout';
import { usePreferences } from './hooks/usePreferences';
import { TitleBar } from './components/shell/TitleBar';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatView } from './components/chat/ChatView';
import { RightPanel } from './components/panel/RightPanel';
import { ProjectsView } from './components/projects/ProjectsView';
import { SettingsDialog } from './components/settings/SettingsView';
import { DialogHost } from './components/ui/Dialog';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TooltipHost } from './components/ui/Tooltip';
import { Intro } from './components/shell/Intro';
import { DistributionProvider } from './components/distribution/Distribution';
import { CommandPalette } from './components/ui/CommandPalette';
import { actions, actionAvailable, paletteShortcut, runAction, usesShortcut } from './lib/actions';
import { SPRING } from './lib/motion';

const VIEW_NAME = { chat: 'la conversación', projects: 'Proyectos y conversaciones' } as const;

export default function App() {
  const ready = useStore((s) => s.ready);
  const [palette, setPalette] = useState(false);
  const bootError = useStore((s) => s.bootError);
  const view = useStore((s) => s.view);
  const { effective } = useAppearance();
  const layout = useLayout();
  usePreferences();
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void subscribeRunEvents().then((f) => {
      if (cancelled) f();
      else un = f;
    });
    let unOpen: (() => void) | undefined;
    void subscribeNotificationOpen().then((f) => {
      if (cancelled) f();
      else unOpen = f;
    });
    void useStore.getState().init();
    return () => {
      cancelled = true;
      un?.();
      unOpen?.();
    };
  }, []);

  // Al pasar a una ventana amplia, el cajón de navegación deja de tener sentido.
  useEffect(() => {
    if (!layout.compactNav) useStore.getState().setNavDrawer(false);
  }, [layout.compactNav]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const store = useStore.getState();
      if (!store.ready || document.querySelector('dialog[open]:not(#workbench)')) return;
      if (usesShortcut(event, paletteShortcut)) {
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (document.querySelector('dialog:modal, .popover[data-state="open"], [role="menu"]')) return;
      const action = actions.find((item) => item.shortcut && usesShortcut(event, item.shortcut));
      if (action && actionAvailable(action, store)) {
        event.preventDefault();
        runAction(action.id);
        return;
      }
      if (event.key !== 'Escape') return;
      if (store.chatFind && event.target instanceof Element && event.target.closest('.chat-stage')) {
        event.preventDefault();
        store.closeChatFind();
      } else if (store.navDrawer) store.setNavDrawer(false);
      else if (store.panel.open) runAction('workbench-close');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const vars = { '--nav-offset': layout.rail ? '0px' : 'var(--sidebar-w)', '--sidebar-w': `${layout.sidebarW}px`, '--panel-w': `${layout.panelW}px` } as CSSProperties;

  return (
    <MotionConfig reducedMotion={effective === 'reduced' ? 'always' : 'user'}>
      <DistributionProvider>
      <div className="relative flex h-full flex-col" style={vars}>
        <a className="skip-link" href="#workspace-main">Ir al espacio de trabajo</a>
        <TitleBar />
        {bootError ? (
          <div className="relative grid flex-1 place-items-center p-8">
            <div className="surface-panel max-w-[520px] rounded-[22px] p-6">
              <h1 className="m-0 text-[17px] font-semibold">No se pudo iniciar la aplicación</h1>
              <p className="selectable mb-0 mt-2 text-[13px] muted">{bootError}</p>
            </div>
          </div>
        ) : (
          ready && (
            <LayoutGroup>
              <div className="app-body relative flex min-h-0 flex-1" data-panel={layout.panelMode}>
                <Sidebar />
                <motion.main id="workspace-main" tabIndex={-1} layout="position" className="relative flex min-h-0 min-w-0 flex-1">
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
                        {view === 'chat' && <ChatView intensity={effective} />}
                        {view === 'projects' && <ProjectsView />}
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
        {ready && !bootError && (
          <ErrorBoundary area="Ajustes" compact>
            <SettingsDialog intensity={effective} />
          </ErrorBoundary>
        )}
        <Toasts />
        <DialogHost />
        {ready && palette && <CommandPalette close={() => setPalette(false)} />}
        <TooltipHost />
        <Intro reduced={effective === 'reduced'} />
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
            className="toast surface-popup pointer-events-auto selectable"
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

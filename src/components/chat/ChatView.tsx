import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { ArrowDown, FolderPlus, MessageSquarePlus, Upload } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Intensity, Message } from '../../lib/types';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useStore } from '../../state/store';
import { AssistantMessage, UserBubble } from './Messages';
import { ConversationSearch } from './ConversationSearch';
import { EMPTY_MESSAGES, FindSelection } from '../../lib/conversationFind';
import { Composer } from '../composer/Composer';
import { Background } from '../shell/Background';
import { useActivity } from '../../hooks/useActivity';
import { HERO_SIZE, MascotHost } from '../mascot/MascotHost';
import mark from '../../assets/duovra-mark.svg';
import { tr, useTr } from '../../i18n';
import { displayTitle } from '../../lib/format';

/** Entrada de los estados vacíos: aparecen y suben unos píxeles, sin escalar el texto. */
const RISE = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', bounce: 0, duration: 0.6 } } as const;

function WelcomeMark() {
  return (
    <div className="welcome-mark">
      <img src={mark} alt="" draggable={false} />
    </div>
  );
}

const EMPTY_ATTACHMENTS: string[] = [];

export function ChatView({ intensity }: { intensity: Intensity }) {
  const convId = useStore((s) => s.activeConversationId);
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const messages = useStore((s) => (convId ? s.messages[convId] : undefined));
  const run = useStore((s) => (convId ? s.runs[convId] : undefined));
  const activity = useActivity(convId ?? "");
  const attachments = conv?.draftAttachments ?? EMPTY_ATTACHMENTS;
  const setAttachments = useCallback((update: (paths: string[]) => string[]) => {
    if (convId) useStore.getState().saveDraftAttachments(convId, update);
  }, [convId]);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const composerAgent = useStore((s) => (convId ? s.prefs[convId]?.agent : undefined));
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const request = useStore((s) => s.chatFind?.conversationId === convId ? s.chatFind : null);
  const focusHeading = useStore((s) => convId != null && s.focusConversationId === convId);
  const searching = !!request;
  const [revealId, setRevealId] = useState<string | null>(null);
  const closeFind = useStore((s) => s.closeChatFind);
  const currentConversation = useRef(convId);
  currentConversation.current = convId;

  useLayoutEffect(() => {
    const box = scroller.current;
    if (!searching || !box) return;
    const focus = document.activeElement;
    const wasStuck = stick.current;
    const top = box.scrollTop;
    stick.current = false;
    return () => {
      if (currentConversation.current !== convId) return;
      requestAnimationFrame(() => {
        if (currentConversation.current !== convId || useStore.getState().chatFind) return;
        box.scrollTop = wasStuck ? box.scrollHeight : top;
        stick.current = wasStuck;
        if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true });
        else if (box.isConnected) box.focus({ preventScroll: true });
      });
    };
  }, [searching, convId]);

  // Arrastrar archivos desde el Explorador (Tauri entrega rutas reales).
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === 'enter' || e.payload.type === 'over') setDragging(true);
        else if (e.payload.type === 'leave') setDragging(false);
        else if (e.payload.type === 'drop') {
          setDragging(false);
          const paths = e.payload.paths;
          const store = useStore.getState();
          if (store.activeConversationId && paths.length) {
            store.saveDraftAttachments(store.activeConversationId, (a) => [...new Set([...a, ...paths])]);
          }
        }
      })
      .then((f) => { if (cancelled) f(); else un = f; }, () => undefined);
    return () => { cancelled = true; un?.(); };
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = !useStore.getState().chatFind && near;
    setShowJump(!near);
  }, []);
  const focusAfterJump = useCallback(() => {
    (composerInput.current ?? scroller.current)?.focus({ preventScroll: true });
  }, []);

  // Mantiene la vista abajo mientras llega contenido, salvo que el usuario haya subido.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, run?.items, run?.approvals, activity.activity]);

  useLayoutEffect(() => {
    stick.current = !useStore.getState().chatFind;
    setShowJump(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convId]);

  useLayoutEffect(() => {
    if (!focusHeading || !messages || !scroller.current) return;
    const target = document.getElementById('conversation-title') ?? scroller.current;
    stick.current = false;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    target.focus({ preventScroll: true });
    // Con Ajustes cerrándose (diálogo modal aún montado) lo de detrás es inerte y el foco no llega:
    // la petición se conserva y la atiende el diálogo al desmontarse (SettingsView).
    if (document.activeElement === target) useStore.setState({ focusConversationId: null });
  }, [focusHeading, messages]);

  // El contenido también crece sin cambios de estado (Markdown, fuentes, bloques que se
  // despliegan): si el usuario estaba al final, se mantiene ahí.
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [convId, !!messages]);

  if (!project || !conv) {
    return (
      <div className="chat-stage relative isolate flex min-w-0 flex-1">
        <Background intensity={intensity} />
        <div className="relative z-1 flex min-w-0 flex-1">{project ? <NoConversation /> : <NoProject />}</div>
      </div>
    );
  }

  const list = messages ?? EMPTY_MESSAGES;
  const empty = list.length === 0;
  return (
    <section ref={stageRef} className="chat-stage relative isolate flex min-h-0 min-w-0 flex-1 flex-col" aria-label={tr('Conversación')}>
      <Background view={activity} intensity={intensity} />
      <div ref={scroller} onScroll={onScroll} tabIndex={0} aria-label={tr('Historial de la conversación')}
        data-searching={searching || undefined} className="chat-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="chat-column">
          {/* El título visible vive en la barra superior; este encabezado conserva la estructura y el destino del foco. */}
          <h1 id="conversation-title" tabIndex={-1} className="sr-only">{displayTitle(conv.title)}</h1>
          {empty && <EmptyConversation project={project.name} />}
          <FindSelection.Provider value={searching ? revealId : null}>
            <MessageList messages={list} />
          </FindSelection.Provider>
        </div>
      </div>

      {request && <ConversationSearch key={convId + ':' + request.request} scroller={scroller}
        messages={list} run={run} initial={request.query} initialMessage={request.messageId} reveal={setRevealId} close={closeFind} />}
      <AnimatePresence>
        {showJump && !searching && (
          <JumpToLatest
            returnFocus={focusAfterJump}
            onJump={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: intensity === 'reduced' ? 'instant' : 'smooth' });
            }}
          />
        )}
      </AnimatePresence>

      <Composer key={conv.id} conv={conv} attachments={attachments} setAttachments={setAttachments} activity={activity} inputRef={composerInput} />
      <MascotHost key={'mascot:' + conv.id} view={activity} agent={composerAgent ?? conv.lastAgent ?? 'codex'} empty={empty} stage={stageRef} input={composerInput} />

      <AnimatePresence>
        {dragging && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="drop-card surface-popup" initial={{ y: 10 }} animate={{ y: 0 }} exit={{ y: 6 }} transition={{ type: 'spring', stiffness: 420, damping: 28 }}>
              <Upload size={22} style={{ color: 'var(--accent)' }} />
              <div className="mt-2 text-[14px] font-medium" style={{ color: 'var(--text-strong)' }}>
                {tr('Suelta para adjuntar')}
              </div>
              <div className="mt-1 text-[12.5px] muted">{tr('Las imágenes se incluyen en el mensaje (con Claude Code, hasta 5 MB); el resto se envía como ruta y el agente lo lee con sus herramientas.')}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function JumpToLatest({ onJump, returnFocus }: { onJump: () => void; returnFocus: () => void }) {
  const present = useIsPresent();
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!present && document.activeElement === button.current) returnFocus();
  }, [present, returnFocus]);

  return (
    <motion.button
      ref={button}
      type="button"
      className="jump-btn surface-popup"
      initial={{ opacity: 0, y: 8, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.9 }}
      onClick={onJump}
      aria-label={tr('Ir al final')}
      aria-hidden={!present || undefined}
      tabIndex={present ? undefined : -1}
      style={present ? undefined : { pointerEvents: 'none' }}
    >
      <ArrowDown size={15} aria-hidden />
    </motion.button>
  );
}

// La lista histórica no cambia con cada token o pulsación del compositor.
const MessageList = memo(function MessageList({ messages }: { messages: Message[] }) {
  useTr();
  return messages.map((m) => m.role === 'user' ? <UserBubble key={m.id} m={m} /> : <LiveMessage key={m.id} m={m} />);
});

function LiveMessage({ m }: { m: Message }) {
  const run = useStore((s) => {
    const r = s.runs[m.conversationId];
    return r?.messageId === m.id ? r : undefined;
  });
  return <AssistantMessage m={m} run={run} />;
}

function EmptyConversation({ project }: { project: string }) {
  return (
    <motion.div {...RISE} className="empty-thread">
      {/* Hueco del anfitrión: la mascota viva flota encima (MascotHost). */}
      <span className="mascot-hero-anchor" data-mascot-anchor style={{ width: HERO_SIZE, height: HERO_SIZE }} />
      <h2 className="empty-thread-title">
        {tr('Trabaja en {project}', { project })}
      </h2>
      <p className="mt-2.5 max-w-[440px] text-[14px] leading-[1.6] muted">
        {tr('Elige quién responde a cada mensaje. Claude Code y Codex comparten el historial de esta conversación.')}
      </p>
    </motion.div>
  );
}

function NoProject() {
  const addProject = useStore((s) => s.addProject);
  return (
    <section className="flex flex-1 items-center justify-center">
      <motion.div {...RISE} className="empty-thread max-w-[420px]">
        <WelcomeMark />
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-strong)' }}>
          {tr('Empieza por un proyecto')}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed muted">
          {tr('Un proyecto es una carpeta de tu equipo. Claude Code y Codex trabajarán dentro de ella.')}
        </p>
        <button className="btn btn-primary mt-4" onClick={() => void addProject()}>
          <FolderPlus size={15} /> {tr('Añadir carpeta')}
        </button>
      </motion.div>
    </section>
  );
}

function NoConversation() {
  const newConversation = useStore((s) => s.newConversation);
  return (
    <section className="flex flex-1 items-center justify-center">
      <motion.div {...RISE} className="empty-thread">
        <WelcomeMark />
        <p className="m-0 text-[14px] muted">{tr('Este proyecto todavía no tiene conversaciones.')}</p>
        <button className="btn btn-primary mt-4" onClick={() => void newConversation()}>
          <MessageSquarePlus size={15} /> {tr('Nueva conversación')}
        </button>
      </motion.div>
    </section>
  );
}

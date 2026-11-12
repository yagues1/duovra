import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, FolderPlus, MessageSquarePlus, Upload } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useStore } from '../../state/store';
import { AssistantMessage, UserBubble } from './Messages';
import { Composer } from '../composer/Composer';
import mark from '../../assets/duovra-mark.svg';

/** Entrada de los estados vacíos: aparecen y suben unos píxeles, sin escalar el texto. */
const RISE = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', bounce: 0, duration: 0.6 } } as const;

function WelcomeMark() {
  return (
    <div className="welcome-mark" data-env="">
      <img src={mark} alt="" draggable={false} />
    </div>
  );
}

export function ChatView({ refractComposer }: { refractComposer: false | 'balanced' | 'full' }) {
  const convId = useStore((s) => s.activeConversationId);
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const messages = useStore((s) => (convId ? s.messages[convId] : undefined));
  const run = useStore((s) => (convId ? s.runs[convId] : undefined));
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => setAttachments([]), [convId]);

  // Arrastrar archivos desde el Explorador (Tauri entrega rutas reales).
  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === 'enter' || e.payload.type === 'over') setDragging(true);
        else if (e.payload.type === 'leave') setDragging(false);
        else if (e.payload.type === 'drop') {
          setDragging(false);
          const paths = e.payload.paths;
          if (useStore.getState().activeConversationId && paths.length) setAttachments((a) => [...new Set([...a, ...paths])]);
        }
      })
      .then((f) => (un = f));
    return () => un?.();
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setShowJump(!near);
  }, []);

  // Mantiene la vista abajo mientras llega contenido, salvo que el usuario haya subido.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, run?.items, run?.approvals]);

  useLayoutEffect(() => {
    stick.current = true;
    setShowJump(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [convId]);

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
    return () => ro.disconnect();
  }, [convId, !!messages]);

  if (!project) return <NoProject />;
  if (!conv) return <NoConversation />;

  const list = messages ?? [];
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Conversación">
      <div ref={scroller} onScroll={onScroll} className="chat-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[var(--chat-max)] chat-column flex-col gap-7 px-6 pt-8">
          {list.length === 0 && <EmptyConversation />}
          {list.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} m={m} />
            ) : (
              <AssistantMessage key={m.id} m={m} run={run && run.messageId === m.id ? run : undefined} />
            ),
          )}
        </div>
      </div>

      <AnimatePresence>
        {showJump && (
          <motion.button
            className="jump-btn mat-float"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}
            aria-label="Ir al final"
          >
            <ArrowDown size={15} />
          </motion.button>
        )}
      </AnimatePresence>

      <Composer conv={conv} attachments={attachments} setAttachments={setAttachments} refract={refractComposer} />

      <AnimatePresence>
        {dragging && (
          <motion.div className="drop-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="drop-card mat-float" initial={{ y: 10 }} animate={{ y: 0 }} exit={{ y: 6 }} transition={{ type: 'spring', stiffness: 420, damping: 28 }}>
              <Upload size={22} style={{ color: 'var(--accent)' }} />
              <div className="mt-2 text-[14px] font-medium" style={{ color: 'var(--text-strong)' }}>
                Suelta para adjuntar
              </div>
              <div className="mt-1 text-[12.5px] muted">Las imágenes se incluyen en el mensaje (con Claude Code, hasta 5 MB); el resto se envía como ruta y el agente lo lee con sus herramientas.</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function EmptyConversation() {
  return (
    <motion.div {...RISE} className="reading-halo mt-[11vh] flex flex-col items-center text-center">
      <WelcomeMark />
      <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-strong)' }}>
        ¿Qué quieres construir?
      </h1>
      <p className="mt-2.5 max-w-[440px] text-[14px] leading-[1.6] muted">
        Elige en el cuadro de abajo qué agente responde a cada mensaje. Los dos trabajan sobre la carpeta del proyecto y comparten el historial de esta conversación.
      </p>
    </motion.div>
  );
}

function NoProject() {
  const addProject = useStore((s) => s.addProject);
  return (
    <section className="flex flex-1 items-center justify-center">
      <motion.div {...RISE} className="reading-halo max-w-[420px] text-center">
        <WelcomeMark />
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text-strong)' }}>
          Empieza por un proyecto
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed muted">
          Un proyecto es una carpeta de tu equipo. Claude Code y Codex trabajarán dentro de ella.
        </p>
        <button className="btn btn-primary mt-4" onClick={() => void addProject()}>
          <FolderPlus size={15} /> Añadir carpeta
        </button>
      </motion.div>
    </section>
  );
}

function NoConversation() {
  const newConversation = useStore((s) => s.newConversation);
  return (
    <section className="flex flex-1 items-center justify-center">
      <motion.div {...RISE} className="reading-halo text-center">
        <WelcomeMark />
        <p className="m-0 text-[14px] muted">Este proyecto todavía no tiene conversaciones.</p>
        <button className="btn btn-primary mt-4" onClick={() => void newConversation()}>
          <MessageSquarePlus size={15} /> Nueva conversación
        </button>
      </motion.div>
    </section>
  );
}

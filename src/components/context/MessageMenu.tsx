import { lazy, Suspense, useRef, type MouseEvent } from 'react';
import { create } from 'zustand';
import { Copy, GitFork, Pencil, Pin, RefreshCw } from 'lucide-react';
import { openSessionDialog, type Purpose } from '../sessions/SessionDialogHost';
import type { Message } from '../../lib/types';
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover';
import { useStore } from '../../state/store';
import { useContextStore } from '../../state/context';
import { MAX_MEMORY_CHARS } from '../../lib/context';
import { tr, useTr } from '../../i18n';

/**
 * Menú contextual de los mensajes (clic derecho o tecla Menú / Mayús+F10). Reutiliza el patrón de
 * menús de la barra lateral: sin botones permanentes en cada mensaje. Si hay texto seleccionado se
 * deja el menú nativo del sistema para copiarlo.
 */
const useMessageMenu = create<{ message: Message | null; anchor: HTMLElement | null; point?: { x: number; y: number } }>(() => ({ message: null, anchor: null }));

export function openMessageMenu(event: MouseEvent<HTMLElement>, message: Message) {
  if (message.status === 'running' || message.role === 'system') return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
  event.preventDefault();
  const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined;
  useMessageMenu.setState({ message, anchor: event.currentTarget, point });
}

const ContextDialogs = lazy(() => import('./ContextDialogs'));

export function MessageMenuHost() {
  useTr();
  const { message, anchor, point } = useMessageMenu();
  const openDialog = useContextStore((s) => s.open);
  const dialog = useContextStore((s) => s.dialog);
  const close = () => useMessageMenu.setState({ message: null, anchor: null });
  const last = useRef<Message | null>(null);
  if (message) last.current = message;
  const m = message ?? last.current;

  const pin = () => {
    if (!m) return;
    close();
    const text = (m.content ?? '').trim().slice(0, MAX_MEMORY_CHARS);
    openDialog({
      kind: 'memory', conversationId: m.conversationId,
      edit: {
        content: text, category: m.role === 'user' ? 'instruction' : 'note', priority: 1, origin: 'message',
        sourceMessages: [m.id], author: m.role === 'user' ? 'user' : 'agent',
      },
    });
  };

  // Bifurcar, editar y regenerar (1.0.11, fase 3): siempre a través de un diálogo; nada se envía solo.
  const fork = (purpose: Purpose) => {
    if (!m) return;
    close();
    openSessionDialog({ kind: 'fork', purpose, message: m });
  };
  const answered = m?.role === 'assistant' && m.status !== 'running';

  return (
    <>
      <Popover open={!!message} onClose={close} anchor={anchor} point={point} width={252} ariaLabel={tr('Acciones del mensaje')}>
        {m && (
          <>
            <MenuItem icon={<GitFork size={14} />} label={tr('Bifurcar desde aquí')} onSelect={() => fork('fork')} />
            {m.role === 'user' && <MenuItem icon={<Pencil size={14} />} label={tr('Editar mensaje')} onSelect={() => fork('edit')} />}
            {answered && <MenuItem icon={<RefreshCw size={14} />} label={tr('Regenerar respuesta')} onSelect={() => fork('regenerate')} />}
            <MenuSeparator />
            <MenuItem icon={<Pin size={14} />} label={tr('Fijar en memoria compartida')} onSelect={pin} disabled={!m.content?.trim()} />
            <MenuSeparator />
            <MenuItem icon={<Copy size={14} />} label={tr('Copiar texto')} disabled={!m.content?.trim()} onSelect={() => {
              close();
              navigator.clipboard.writeText(m.content).catch(() => useStore.getState().toast(tr('No se pudo copiar al portapapeles'), 'error'));
            }} />
          </>
        )}
      </Popover>
      {dialog && (
        <Suspense fallback={null}>
          <ContextDialogs />
        </Suspense>
      )}
    </>
  );
}

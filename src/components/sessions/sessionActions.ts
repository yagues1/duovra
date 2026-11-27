import { api, errorText, type ForkRequest } from '../../lib/ipc';
import type { AgentId, Conversation, ConversationOrigin } from '../../lib/types';
import { isListed, useStore } from '../../state/store';
import { AGENT_NAME } from '../../lib/format';
import { tr } from '../../i18n';

/**
 * Acciones del Session Manager (1.0.11, fase 3). La lógica vive en el backend; aquí solo se
 * actualiza la lista local y se comunica el resultado en una línea cuando importa.
 */

export function upsertConversation(conv: Conversation) {
  useStore.setState((s) => ({
    conversations: s.conversations.some((c) => c.id === conv.id)
      ? s.conversations.map((c) => (c.id === conv.id ? { ...c, ...conv } : c))
      : [conv, ...s.conversations],
  }));
}

function focusComposer() {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus({ preventScroll: true }));
}

/** Limitaciones que el usuario debe conocer: solo cuando un agente con sesión no podrá continuar de forma nativa. */
export function continuationNote(origin: ConversationOrigin | undefined): string | null {
  const native = origin && 'native' in origin ? origin.native : undefined;
  if (!native) return null;
  const notes = (Object.entries(native) as Array<[AgentId, { state: string; reason?: string }]>)
    .filter(([, n]) => n.state === 'rebuild' && n.reason !== 'chosen')
    .map(([agent, n]) => {
      const name = AGENT_NAME[agent];
      if (n.reason === 'workdir') return tr('{agent} continuará con el contexto reconstruido: su sesión no se puede bifurcar en otra carpeta.', { agent: name });
      if (n.reason === 'compacted') return tr('{agent} continuará con el contexto reconstruido: su sesión se compactó después de ese punto.', { agent: name });
      return tr('{agent} continuará con el contexto reconstruido: no hay un punto exacto en su sesión.', { agent: name });
    });
  return notes.length ? notes.join(' ') : null;
}

/** Bifurca y abre la conversación nueva. Editar y regenerar dejan el borrador listo, sin enviarlo. */
export async function forkFlow(request: ForkRequest): Promise<boolean> {
  const { toast, selectConversation } = useStore.getState();
  try {
    const conv = await api.forkConversation(request);
    upsertConversation({ ...conv, started: conv.started ?? true });
    await selectConversation(conv.id);
    const note = continuationNote(conv.origin);
    const done = request.purpose === 'fork' ? tr('Conversación bifurcada.') : tr('Borrador preparado en una conversación nueva. Elige el agente y envíalo.');
    toast(note ? `${done} ${note}` : done);
    if (request.purpose !== 'fork') focusComposer();
    return true;
  } catch (error) {
    toast(errorText(error), 'error');
    return false;
  }
}

export async function setPinned(conv: Conversation, pinned: boolean) {
  try {
    upsertConversation(await api.setConversationPinned(conv.id, pinned));
  } catch (error) {
    useStore.getState().toast(errorText(error), 'error');
  }
}

/** Archivar no borra nada. Si era la conversación abierta, se abre otra del mismo espacio. */
export async function setArchived(conv: Conversation, archived: boolean) {
  const { toast, selectConversation } = useStore.getState();
  try {
    upsertConversation(await api.setConversationArchived(conv.id, archived));
    if (archived) {
      toast(tr('«{title}» archivada. Puedes recuperarla desde el menú del proyecto.', { title: conv.title }));
      const s = useStore.getState();
      if (s.activeConversationId === conv.id) {
        const next = s.conversations.find((c) => c.id !== conv.id && c.projectId === conv.projectId
          && (c.worktreeId ?? null) === (conv.worktreeId ?? null) && isListed(c));
        if (next) await selectConversation(next.id);
      }
    } else {
      toast(tr('«{title}» recuperada.', { title: conv.title }));
    }
  } catch (error) {
    toast(errorText(error), 'error');
  }
}

/** Abre la conversación original de una bifurcación (aunque esté archivada). */
export async function openOriginal(conv: Conversation) {
  const origin = conv.origin;
  if (!origin || !('kind' in origin) || origin.kind !== 'fork') return;
  const { conversations, selectConversation, toast } = useStore.getState();
  if (!conversations.some((c) => c.id === origin.conversationId)) {
    toast(tr('La conversación original ya no existe.'), 'error');
    return;
  }
  await selectConversation(origin.conversationId);
}

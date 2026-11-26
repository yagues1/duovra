import { lazy, Suspense } from 'react';
import { create } from 'zustand';
import type { Conversation, Message, Project } from '../../lib/types';

/** Anfitrión de los diálogos del Session Manager: el código se carga solo al abrir uno. */
export type Purpose = 'fork' | 'edit' | 'regenerate';
export type SessionDialogRequest =
  | { kind: 'fork'; purpose: Purpose; message: Message }
  | { kind: 'export'; conversation: Conversation }
  | { kind: 'import'; project: Project }
  | { kind: 'archived'; project: Project };

export const useSessionDialog = create<{ req: SessionDialogRequest | null }>(() => ({ req: null }));

export function openSessionDialog(req: SessionDialogRequest) {
  useSessionDialog.setState({ req });
}

const SessionDialogs = lazy(() => import('./SessionDialogs'));

export function SessionDialogHost() {
  const open = useSessionDialog((s) => s.req !== null);
  if (!open) return null;
  return <Suspense fallback={null}><SessionDialogs /></Suspense>;
}

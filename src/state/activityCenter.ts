/**
 * Estado del Activity Center (1.0.11, fase 6): apertura y ejecuciones terminadas en esta sesión de la app.
 * Las ejecuciones activas salen del store principal; aquí solo se recuerda lo reciente (en memoria).
 */
import { create } from 'zustand';
import type { RecentRun } from '../lib/activityCenter';

const MAX_RECENT = 6;

interface ActivityCenterState {
  open: boolean;
  recent: RecentRun[];
  setOpen: (open: boolean) => void;
  record: (run: RecentRun) => void;
  clearRecent: () => void;
}

export const useActivityCenter = create<ActivityCenterState>((set) => ({
  open: false,
  recent: [],
  setOpen: (open) => set({ open }),
  record: (run) => set((s) => ({
    recent: [run, ...s.recent.filter((r) => r.conversationId !== run.conversationId)].slice(0, MAX_RECENT),
  })),
  clearRecent: () => set({ recent: [] }),
}));

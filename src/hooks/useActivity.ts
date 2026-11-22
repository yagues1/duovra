import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { activityLabel, deriveActivity, DONE_MS, ERROR_MS, type Activity } from '../lib/activity';
import type { AgentId } from '../lib/types';

export interface ActivityView {
  activity: Activity;
  agent: AgentId | null;
  label: string;
  detail: string | null;
  runId: string | null;
  stopping: boolean;
}

export function useActivity(conversationId: string): ActivityView {
  const run = useStore((s) => s.runs[conversationId]);
  const last = useStore((s) => s.activityFinish?.conversationId === conversationId ? s.activityFinish : undefined);
  const [, setClock] = useState(0);
  const activity = deriveActivity(run, last, Date.now());

  useEffect(() => {
    if (run || !last || (activity !== 'done' && activity !== 'error')) return;
    const ttl = (activity === 'done' ? DONE_MS : ERROR_MS) - (Date.now() - last.endedAt);
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), Math.max(0, ttl) + 10);
    return () => window.clearTimeout(timer);
  }, [activity, run, last]);

  const { label, detail } = activityLabel(run, activity);
  return {
    activity,
    agent: activity === 'idle' ? null : run?.agent ?? last?.agent ?? null,
    label, detail, runId: run?.runId ?? null, stopping: run?.stopping ?? false,
  };
}

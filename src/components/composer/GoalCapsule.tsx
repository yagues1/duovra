import { memo, useEffect, useId, useRef, useState } from 'react';
import { Check, Target, Trash2 } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { useContextStore } from '../../state/context';
import { activeGoal, MAX_MEMORY_CHARS } from '../../lib/context';
import type { AgentId } from '../../lib/types';
import { tr, useTr } from '../../i18n';

/**
 * Objetivo de la conversación (1.0.11, fase 5). Una cápsula pequeña solo cuando hay un objetivo activo y
 * un editor contextual (cápsula o comando `/goal`). Es un recuerdo de la memoria compartida con prioridad
 * propia: viaja a ambos agentes antes que el resto de la memoria y definirlo nunca inicia una ejecución.
 * El modo de objetivos nativo de Codex (`thread/goal/set`) no se activa: inicia turnos autónomos.
 */
export const GoalCapsule = memo(function GoalCapsule({ conversationId, agent, openSignal, anchorFallback }: {
  conversationId: string;
  agent: AgentId;
  openSignal: number;
  anchorFallback: HTMLElement | null;
}) {
  useTr();
  const memories = useContextStore((s) => s.memories[conversationId]);
  const load = useContextStore((s) => s.loadMemories);
  const goal = activeGoal(memories);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const dialogId = useId();

  useEffect(() => {
    if (memories === undefined) void load(conversationId).catch(() => undefined);
  }, [conversationId, memories === undefined]);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);

  // La actualización asíncrona puede crear o retirar la propia cápsula. Cierra
  // antes de publicarla y conserva el guard de operación durante la reapertura.
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try { await action(); } finally { setBusy(false); }
  };

  return (
    <>
      {goal && (
        <div className="goal-row">
        <button ref={btn} type="button" className="goal-capsule" onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
          aria-label={tr('Objetivo de la conversación: {goal}', { goal: goal.content })} data-tip={goal.content}>
          <Target size={12} strokeWidth={2} aria-hidden />
          <span className="truncate">{goal.content}</span>
        </button>
        </div>
      )}
      <Popover composerMotion open={open} onClose={() => setOpen(false)} anchor={goal ? btn.current : anchorFallback} placement="top-start" width={320}
        menuId={dialogId} role="dialog" ariaLabel={tr('Objetivo de la conversación')} className="composer-popup goal-pop">
        {open && <GoalEditor conversationId={conversationId} agent={agent} busy={busy} run={run} />}
      </Popover>
    </>
  );
});

function GoalEditor({ conversationId, agent, busy, run }: {
  conversationId: string; agent: AgentId; busy: boolean; run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const memories = useContextStore((s) => s.memories[conversationId]);
  const goal = activeGoal(memories);
  const setGoal = useContextStore((s) => s.setGoal);
  const archive = useContextStore((s) => s.archiveMemory);
  const remove = useContextStore((s) => s.deleteMemory);
  const [text, setText] = useState(goal?.content ?? '');
  const fieldId = useId();
  const save = () => { if (text.trim() && text.trim() !== goal?.content) void run(() => setGoal(conversationId, text.trim())); };
  return (
    <div className="goal-editor">
      <label htmlFor={fieldId} className="goal-title"><Target size={13} aria-hidden />{tr('Objetivo de la conversación')}</label>
      <textarea id={fieldId} className="goal-field selectable" rows={3} maxLength={MAX_MEMORY_CHARS} value={text} data-popover-focus
        placeholder={tr('¿Qué quieres conseguir en esta conversación?')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } }} />
      <p className="goal-note">
        {tr('Se comparte con Claude Code y Codex antes que el resto de la memoria. Guardarlo no inicia ninguna ejecución.')}
        {agent === 'codex' && ' ' + tr('No activa el modo de objetivos nativo de Codex, que trabaja de forma autónoma.')}
      </p>
      <div className="goal-actions">
        {goal && <>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(() => archive(goal, true))}>
            <Check size={13} aria-hidden />{tr('Completado')}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(() => remove(goal))}>
            <Trash2 size={13} aria-hidden />{tr('Retirar')}
          </button>
        </>}
        <span className="flex-1" />
        <button type="button" className="btn btn-primary" disabled={busy || !text.trim() || text.trim() === goal?.content} onClick={save}>
          {goal ? tr('Guardar') : tr('Definir objetivo')}
        </button>
      </div>
    </div>
  );
}

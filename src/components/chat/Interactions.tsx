import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Copy, Ellipsis, MessageCircleQuestion, PenLine, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { AgentId, Message, TimelineItem } from '../../lib/types';
import {
  answerComplete, answerText, planActionable, planBody, questionAnswerable,
  type Answer, type Interaction, type PlanInteraction, type Question, type QuestionInteraction,
} from '../../lib/interactions';
import { AGENT_NAME } from '../../lib/format';
import { useStore } from '../../state/store';
import { Markdown } from './Markdown';
import { MenuItem, MenuSeparator, Popover } from '../ui/Popover';
import { SPRING } from '../../lib/motion';
import { tr, useTr } from '../../i18n';

const NO_INTERACTIONS: Interaction[] = [];
/** Un plan con más líneas que esto se muestra recogido hasta que el usuario lo expande. */
const LONG_PLAN_LINES = 14;

const useConversationInteractions = (conversationId: string) =>
  useStore((s) => s.interactions[conversationId] ?? NO_INTERACTIONS);

function planStatusLabel(plan: PlanInteraction): string {
  switch (plan.status) {
    case 'pending': return tr('Esperando tu decisión');
    case 'approved': return plan.response?.agent && plan.response.agent !== plan.agent
      ? tr('Aprobado · lo implementa {agent}', { agent: AGENT_NAME[plan.response.agent] })
      : tr('Aprobado');
    case 'changes_requested': return tr('Cambios solicitados');
    case 'rejected': return tr('Rechazado');
    case 'superseded': return tr('Sustituido por una versión posterior');
    case 'interrupted': return tr('Interrumpido');
    case 'cancelled': return tr('Cancelado');
    case 'historical': return tr('Histórico');
  }
}

function questionStatusLabel(q: QuestionInteraction): string | null {
  switch (q.status) {
    case 'answered': return tr('Respondida');
    case 'dismissed': return tr('Sin responder');
    case 'interrupted': return tr('Interrumpida');
    case 'cancelled': return tr('Cancelada');
    case 'historical': return tr('Histórica');
    default: return null;
  }
}

/**
 * Plan o pregunta en su posición dentro del turno. Si todavía no hay interacción registrada (o es un
 * historial anterior), se muestra lo que comunicó el proveedor sin acciones.
 */
export function DecisionSegment({ item, message, live }: { item: TimelineItem; message: Message; live: boolean }) {
  useTr();
  const all = useConversationInteractions(message.conversationId);
  const interaction = all.find((i) => i.messageId === message.id && i.itemId === item.id);
  if (interaction?.kind === 'plan') return <PlanCard plan={interaction} />;
  if (interaction?.kind === 'question') return <QuestionCard question={interaction} />;
  if (item.kind === 'plan_proposal') {
    // Sin interacción: solo se muestra si el proveedor no lo rechazó (p. ej. un ExitPlanMode fuera del modo plan).
    if (!item.text?.trim() || item.status === 'failed' || item.status === 'declined') return null;
    return (
      <section className="ia-card" data-kind="plan" data-status={live ? 'streaming' : 'static'} aria-label={tr('Plan propuesto')}>
        <header className="ia-head">
          <ClipboardList size={15} aria-hidden className="ia-icon" />
          <span className="ia-title">{tr('Plan propuesto')}</span>
        </header>
        <div className="ia-plan selectable"><Markdown text={item.text} streaming={live && item.status === 'running'} /></div>
      </section>
    );
  }
  return null;
}

/** Planes y preguntas del mensaje que no tienen elemento propio en la cronología. */
export function OrphanInteractions({ message, items }: { message: Message; items: readonly TimelineItem[] }) {
  const all = useConversationInteractions(message.conversationId);
  const orphans = all.filter((i) => i.messageId === message.id && !items.some((it) => it.id === i.itemId));
  if (!orphans.length) return null;
  return (
    <>
      {orphans.map((i) => i.kind === 'plan' ? <PlanCard key={i.id} plan={i} /> : <QuestionCard key={i.id} question={i} />)}
    </>
  );
}

// ---------- Plan ----------

function PlanCard({ plan }: { plan: PlanInteraction }) {
  const decide = useStore((s) => s.decidePlan);
  const setPlanReply = useStore((s) => s.setPlanReply);
  const replying = useStore((s) => s.planReply?.interactionId === plan.id);
  const busyConversation = useStore((s) => !!s.runs[plan.conversationId] && s.runs[plan.conversationId].runId !== plan.runId);
  // Existe una versión posterior de este plan: esta se reduce a una línea (historial sin ruido).
  const replaced = useStore((s) => s.interactions[plan.conversationId]?.some((i) => i.kind === 'plan' && i.version > plan.version) ?? false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const bodyId = useId();
  const actionable = planActionable(plan);
  const text = plan.payload.text ?? '';
  const long = text.split('\n').length > LONG_PLAN_LINES || text.length > 1800;
  const other: AgentId = plan.agent === 'claude' ? 'codex' : 'claude';
  const title = plan.payload.title || tr('Plan propuesto');

  // Una versión sustituida se reduce a una línea en su sitio: el historial se conserva sin ocupar el chat.
  if (plan.status === 'superseded' || replaced && !actionable) return <CollapsedPlan plan={plan} />;

  const run = async (action: 'approve' | 'reject', agent?: AgentId) => {
    setMenu(false);
    setBusy(true);
    try { await decide(plan, action, agent ? { agent } : undefined); } finally { setBusy(false); }
  };
  const requestChanges = () => {
    setMenu(false);
    setPlanReply({ conversationId: plan.conversationId, interactionId: plan.id, version: plan.version });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus());
  };
  const disabled = busy || busyConversation;

  return (
    <motion.section className="ia-card" data-kind="plan" data-status={plan.status} data-replying={replying || undefined}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING.enter}
      aria-label={tr('Plan de {agent}, versión {version}', { agent: AGENT_NAME[plan.agent], version: plan.version })}>
      <header className="ia-head">
        <ClipboardList size={15} aria-hidden className="ia-icon" />
        <span className="ia-title" title={title}>{title}</span>
        <span className="ia-version">v{plan.version}</span>
        <span className="ia-status" data-status={plan.status} role="status">{planStatusLabel(plan)}</span>
        <button ref={menuBtn} type="button" className="btn-icon ia-menu-btn" aria-label={tr('Más acciones del plan')} data-tip={tr('Más acciones')}
          aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined} onClick={() => setMenu(!menu)}>
          <Ellipsis size={15} aria-hidden />
        </button>
        <Popover open={menu} onClose={() => setMenu(false)} anchor={menuBtn.current} placement="bottom-end" width={252} menuId={menuId} ariaLabel={tr('Acciones del plan')}>
          {actionable && (
            <MenuItem icon={<Check size={14} />} label={tr('Aprobar e implementar con {agent}', { agent: AGENT_NAME[other] })}
              disabled={disabled} onSelect={() => void run('approve', other)} />
          )}
          <MenuItem icon={<Copy size={14} />} label={tr('Copiar plan')} onSelect={() => {
            setMenu(false);
            navigator.clipboard.writeText(text).then(
              () => useStore.getState().toast(tr('Plan copiado')),
              () => useStore.getState().toast(tr('No se pudo copiar al portapapeles'), 'error'),
            );
          }} />
          {actionable && (
            <>
              <MenuSeparator />
              <MenuItem icon={<X size={14} />} danger label={tr('Rechazar plan')} disabled={disabled} onSelect={() => void run('reject')} />
            </>
          )}
        </Popover>
      </header>

      <div id={bodyId} className="ia-plan selectable" data-collapsed={long && !expanded || undefined}>
        <Markdown text={planBody(text, plan.payload.title)} />
      </div>
      {long && (
        <button type="button" className="ia-expand" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(!expanded)}>
          <ChevronDown size={13} aria-hidden data-open={expanded || undefined} />
          {expanded ? tr('Mostrar menos') : tr('Mostrar el plan completo')}
        </button>
      )}

      {plan.status === 'changes_requested' && plan.response?.feedback && (
        <p className="ia-feedback"><PenLine size={12} aria-hidden /> {plan.response.feedback}</p>
      )}
      {plan.status === 'interrupted' && (
        <p className="ia-note">{tr('La solicitud original ya no está activa. Si lo apruebas, Duovra inicia un turno nuevo con esta versión exacta.')}</p>
      )}

      {actionable && (
        <div className="ia-actions">
          <button type="button" className="btn approval-primary" disabled={disabled} onClick={() => void run('approve')}
            data-tip={tr('Lo implementa {agent}', { agent: AGENT_NAME[plan.agent] })}>
            <Check size={14} aria-hidden /> {tr('Aprobar e implementar')}
          </button>
          <button type="button" className="btn" disabled={disabled} aria-pressed={replying} onClick={() => replying ? setPlanReply(null) : requestChanges()}>
            <PenLine size={13} aria-hidden /> {replying ? tr('Escribiendo cambios…') : tr('Solicitar cambios')}
          </button>
        </div>
      )}
    </motion.section>
  );
}

function CollapsedPlan({ plan }: { plan: PlanInteraction }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="ia-collapsed" data-status={plan.status}>
      <button type="button" className="ia-collapsed-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <ClipboardList size={13} aria-hidden />
        <span className="truncate">{plan.payload.title || tr('Plan propuesto')}</span>
        <span className="ia-version">v{plan.version}</span>
        <span className="ia-status" data-status={plan.status}>{planStatusLabel(plan)}</span>
        <ChevronDown size={12} aria-hidden data-open={open || undefined} />
      </button>
      {open && (
        <div id={id}>
          <div className="ia-plan selectable"><Markdown text={planBody(plan.payload.text ?? '', plan.payload.title)} /></div>
          {plan.response?.feedback && <p className="ia-feedback"><PenLine size={12} aria-hidden /> {plan.response.feedback}</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Preguntas ----------

function QuestionCard({ question }: { question: QuestionInteraction }) {
  const answer = useStore((s) => s.answerQuestion);
  const dismiss = useStore((s) => s.dismissQuestion);
  const questions = question.payload.questions ?? [];
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ selected: [], custom: '' })));
  const [busy, setBusy] = useState(false);
  const answerable = questionAnswerable(question);
  const status = questionStatusLabel(question);
  const label = tr('{agent} pregunta', { agent: AGENT_NAME[question.agent] });

  if (!answerable) {
    const stored = question.response?.answers ?? [];
    return (
      <section className="ia-card ia-summary" data-kind="question" data-status={question.status} aria-label={label}>
        <header className="ia-head">
          <MessageCircleQuestion size={15} aria-hidden className="ia-icon" />
          <span className="ia-title">{label}</span>
          {status && <span className="ia-status" data-status={question.status}>{status}</span>}
        </header>
        <dl className="ia-answers">
          {questions.map((q, i) => (
            <div key={q.id} className="ia-answer-row">
              <dt>{q.question}</dt>
              <dd>{stored[i] ? answerText(stored[i]) : <span className="faint">—</span>}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  const q = questions[index];
  const complete = questions.every((qq, i) => answerComplete(qq, answers[i]));
  const update = (next: Answer) => setAnswers((list) => list.map((a, i) => (i === index ? next : a)));
  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await answer(question, answers.map((a) => ({ selected: a.selected, custom: a.custom?.trim() || null })));
    } finally {
      setBusy(false);
    }
  };
  const last = index === questions.length - 1;

  return (
    <motion.section className="ia-card" data-kind="question" data-status="pending" aria-label={label}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING.enter}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
      }}>
      <header className="ia-head">
        <MessageCircleQuestion size={15} aria-hidden className="ia-icon" />
        <span className="ia-title">{label}</span>
        {questions.length > 1 && (
          <nav className="ia-steps" aria-label={tr('Preguntas')}>
            {questions.map((qq, i) => (
              <button key={qq.id} type="button" className="ia-step" aria-current={i === index ? 'step' : undefined}
                data-done={answerComplete(qq, answers[i]) || undefined} aria-label={tr('Pregunta {n} de {total}', { n: i + 1, total: questions.length })}
                onClick={() => setIndex(i)} />
            ))}
          </nav>
        )}
      </header>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={q.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={SPRING.enter}>
          <QuestionBody q={q} value={answers[index]} onChange={update} />
        </motion.div>
      </AnimatePresence>
      <div className="ia-actions">
        {questions.length > 1 && index > 0 && (
          <button type="button" className="btn" onClick={() => setIndex(index - 1)}><ChevronLeft size={14} aria-hidden /> {tr('Anterior')}</button>
        )}
        {!last ? (
          <button type="button" className="btn approval-primary" disabled={!answerComplete(q, answers[index])} onClick={() => setIndex(index + 1)}>
            {tr('Siguiente')} <ChevronRight size={14} aria-hidden />
          </button>
        ) : (
          <button type="button" className="btn approval-primary" disabled={!complete || busy} onClick={() => void submit()} aria-keyshortcuts="Control+Enter">
            <Check size={14} aria-hidden /> {tr('Responder')}
          </button>
        )}
        <button type="button" className="ia-link" disabled={busy} onClick={() => { setBusy(true); void dismiss(question).finally(() => setBusy(false)); }}>
          {tr('No responder')}
        </button>
      </div>
    </motion.section>
  );
}

function QuestionBody({ q, value, onChange }: { q: Question; value: Answer; onChange: (a: Answer) => void }) {
  const name = useId();
  const customId = useId();
  const custom = value.custom ?? '';
  const toggle = (label: string) => {
    if (q.multiSelect) {
      const selected = value.selected.includes(label) ? value.selected.filter((s) => s !== label) : [...value.selected, label];
      onChange({ ...value, selected });
    } else {
      onChange({ selected: [label], custom: '' });
    }
  };
  return (
    <fieldset className="ia-question">
      <legend className="ia-question-text">
        {q.header && <span className="ia-chip">{q.header}</span>}
        {q.question}
      </legend>
      {q.options.length > 0 && (
        <div className="ia-options" role="presentation">
          {q.options.map((o) => {
            const checked = value.selected.includes(o.label);
            return (
              <label key={o.label} className="ia-option" data-checked={checked || undefined}>
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name={name} checked={checked} onChange={() => toggle(o.label)} />
                <span className="ia-option-mark" aria-hidden data-multi={q.multiSelect || undefined} />
                <span className="ia-option-text">
                  <span className="ia-option-label">{o.label}</span>
                  {o.description && <span className="ia-option-desc">{o.description}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {q.custom && (
        <div className="ia-custom">
          <label htmlFor={customId} className="sr-only">{q.options.length ? tr('Otra respuesta') : tr('Tu respuesta')}</label>
          <input id={customId} className="ia-custom-input" type={q.secret ? 'password' : 'text'} autoComplete="off" maxLength={4000}
            value={custom} placeholder={q.options.length ? tr('Otra respuesta…') : tr('Escribe tu respuesta…')}
            onChange={(event) => {
              const text = event.target.value;
              onChange({ selected: q.multiSelect || !text.trim() ? value.selected : [], custom: text });
            }} />
          {q.secret && <span className="ia-hint">{tr('No se guarda en el historial.')}</span>}
        </div>
      )}
      {q.multiSelect && <span className="ia-hint">{tr('Puedes elegir varias opciones.')}</span>}
    </fieldset>
  );
}

/** Aviso compacto sobre el compositor mientras se escriben los cambios de un plan. */
export function PlanReplyChip({ conversationId }: { conversationId: string }) {
  useTr();
  const reply = useStore((s) => (s.planReply?.conversationId === conversationId ? s.planReply : null));
  const setPlanReply = useStore((s) => s.setPlanReply);
  return (
    <AnimatePresence initial={false}>
      {reply && (
        <motion.div className="ia-reply" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING.enter}>
          <PenLine size={12} aria-hidden />
          <span>{tr('Cambios para el plan v{version}', { version: reply.version })}</span>
          <button type="button" className="attach-remove" aria-label={tr('Cancelar la petición de cambios')} onClick={() => setPlanReply(null)}>
            <X size={11} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

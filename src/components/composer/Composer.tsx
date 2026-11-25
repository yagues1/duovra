import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, ChevronDown, CircleSlash, FileText, Folder, Gauge, Image as ImageIcon, Info, Paperclip, Square, TriangleAlert, X, Zap } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { canDispatch, catalogModels, draftOf, useStore } from '../../state/store';
import type { AgentId, Conversation, ModelCatalog } from '../../lib/types';
import { AGENT_NAME, effortLabel } from '../../lib/format';
import { api } from '../../lib/ipc';
import { classifyAttachment, summarize, type AttachmentMeta, type Classified } from '../../lib/attachments';
import { MenuItem, MenuLabel, Popover } from '../ui/Popover';
import { Mascot } from '../mascot/Mascot';
import { AgentActivity } from '../chat/AgentActivity';
import type { ActivityView } from '../../hooks/useActivity';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { localEntry, useComposerSuggestions } from './ComposerSuggestions';
import { changeAgent } from '../../lib/actions';
import { ModelPicker } from './ModelPicker';
import { EffortMenu } from './EffortMenu';
import { QueueTray } from './QueueTray';
import { PermissionMenu, shieldFor } from './PermissionMenu';
import { permissionsFor, permissionSummary, samePermissions } from '../../lib/permissions';
import { CANCEL_ARM_MS, primaryAction } from './primaryAction';
import { tr, useTr } from '../../i18n';

export const Composer = memo(function Composer({ conv, attachments, setAttachments, activity, inputRef: ta }: {
  conv: Conversation;
  attachments: string[];
  activity: ActivityView;
  setAttachments: (f: (a: string[]) => string[]) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  useTr();
  const prefs = useStore((s) => s.prefs[conv.id]);
  const busy = useStore((s) => !!s.runs[conv.id]);
  const historyLoaded = useStore((s) => !!s.messages[conv.id]);
  const stopping = useStore((s) => !!s.runs[conv.id]?.stopping);
  const send = useStore((s) => s.send);
  const steer = useStore((s) => s.steer);
  const steerRun = useStore((s) => {
    const run = s.runs[conv.id];
    return run?.steerable && !run.stopping && !run.approvals.length ? run.runId : null;
  });
  const queue = useStore((s) => s.queues[conv.id]);
  // Con una cola pendiente o pausada, Enviar también añade el mensaje a la cola (lo decide el backend).
  const queuePending = !!queue?.entries.length;
  const fastOn = useStore((s) => s.settings['composer.fast'] === true);
  const setSetting = useStore((s) => s.setSetting);
  const cancel = useStore((s) => s.cancel);
  const saveDraft = useStore((s) => s.saveDraft);
  const enterSends = useStore((s) => s.settings['composer.enterToSend'] !== false);
  const setPrefs = useStore((s) => s.setPrefs);
  const [text, setText] = useState(() => draftOf(conv));
  const agentBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const effortBtn = useRef<HTMLButtonElement>(null);
  const agentMenuId = useId();
  const modelMenuId = useId();
  const effortMenuId = useId();
  const permBtn = useRef<HTMLButtonElement>(null);
  const fastBtn = useRef<HTMLButtonElement>(null);
  const permMenuId = useId();
  const fastMenuId = useId();
  const [picker, setPicker] = useState<'agent' | 'model' | 'effort' | 'perm' | 'fast' | null>(null);
  const settings = useStore((s) => s.settings);
  const setPermissions = useStore((s) => s.setPermissions);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  /** Momento del último envío o encolado desde este compositor (guarda contra doble clic). */
  const lastSubmit = useRef(0);
  const updateText = (value: string) => { setText(value); saveDraft(conv.id, value); };
  const suggestions = useComposerSuggestions({ text, projectId: conv.projectId, field: ta, update: updateText, suspended: picker !== null });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      // La navegación desde Estadísticas ya ha entregado el foco al historial.
      if (document.activeElement?.id !== 'conversation-title') ta.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el || CSS.supports('field-sizing', 'content')) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const agent = prefs?.agent ?? conv.lastAgent ?? 'codex';
  const catalog = useAgentCatalog(agent);
  // Permisos propios de esta conversación y agente; si no hay, los ajustes globales.
  const permissions = useMemo(() => permissionsFor(conv, agent, settings), [conv, agent, settings]);
  const shield = shieldFor(agent, permissions);
  const models = catalogModels(catalog);
  const model = models.find((m) => m.id === prefs?.model);
  const modelLabel = catalog === 'loading' ? tr('Cargando modelos…') : catalog && 'error' in catalog
    ? tr('Modelos no disponibles') : (model?.label ?? prefs?.model) || tr('Elige un modelo');
  const efforts = model?.efforts ?? [];
  const effort = prefs?.effort ?? null;
  const invalidEffort = !!model && effort !== null && !efforts.includes(effort);
  const replacement = invalidEffort ? model : !model && prefs?.model ? models.find((m) => m.isDefault) ?? models[0] : undefined;
  const replacementEffort = effort && replacement?.efforts.includes(effort) ? effort : replacement?.defaultEffort ?? null;
  const catalogPending = !catalog || catalog === 'loading' || 'error' in catalog;
  const showEffort = efforts.length > 0 || picker === 'effort' || (catalogPending && effort !== null);
  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const canSend = historyLoaded && !!queue && !sending && !!prefs && canDispatch(prefs, catalog) && !localEntry(text) && (text.trim().length > 0 || attachments.length > 0);
  const claudeLoggedOut =
    agent === 'claude' && catalog && catalog !== 'loading' && 'models' in catalog &&
    ((catalog as ModelCatalog).account as { tokenSource?: string } | undefined)?.tokenSource === 'none';

  // Metadatos reales de los adjuntos (existencia, tamaño, carpeta) para explicar su tratamiento.
  const [meta, setMeta] = useState<Record<string, AttachmentMeta>>({});
  useEffect(() => {
    const missing = attachments.filter((p) => !meta[p]);
    if (!missing.length) return;
    let alive = true;
    api.inspectAttachments(missing).then(
      (list) => alive && setMeta((m) => ({ ...m, ...Object.fromEntries(list.map((x) => [x.path, x])) })),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [attachments, meta]);
  const classified = useMemo(() => attachments.map((p) => classifyAttachment(meta[p], p, agent, model)), [attachments, meta, agent, model]);

  const canSteer = !!steerRun && !sending && !localEntry(text) && (text.trim().length > 0 || attachments.length > 0);
  // Modo rápido: solo si el proveedor lo publica para el modelo elegido. Se aplica al próximo
  // mensaje; los encargos ya enviados conservan el modo con el que se capturaron.
  const fastInfo = model?.fast ?? null;
  const agentHasFast = models.some((entry) => entry.fast);
  const fastActive = fastOn && !!fastInfo;
  const submit = async (action: 'send' | 'steer' = 'send') => {
    if ((action === 'steer' ? !canSteer : !canSend) || submitting.current) return;
    submitting.current = true;
    lastSubmit.current = Date.now();
    setSending(true);
    try {
      const ok = action === 'steer' && steerRun
        ? await steer(steerRun, text, attachments)
        : await send(conv.id, text, attachments);
      if (!ok) return;
      const current = useStore.getState().conversations.find((c) => c.id === conv.id);
      if (current && draftOf(current) === text) updateText('');
      if (attachments.length) setAttachments((paths) => paths.filter((path) => !attachments.includes(path)));
      if (document.activeElement === document.body) ta.current?.focus({ preventScroll: true });
    } finally {
      submitting.current = false;
      lastSubmit.current = Date.now();
      setSending(false);
    }
  };

  useEffect(() => {
    if (!conv.draft && !draftOf(conv)) setText('');
  }, [conv.id, conv.draft]);

  // Botón único: enviar, encolar o cancelar según la ejecución real y el borrador.
  const primary = primaryAction({ running: busy, queuePending, hasDraft, canSend, stopping });
  const primaryLabel = primary.action === 'cancel'
    ? stopping ? tr('Cancelando…') : tr('Cancelar ejecución')
    : primary.action === 'queue' ? tr('Añadir a la cola') : tr('Enviar mensaje');
  const cancelling = useRef(false);
  const onPrimary = () => {
    if (primary.action !== 'cancel') return void submit();
    // Un doble clic sobre Enviar no cancela la ejecución que acaba de iniciar; una cancelación en curso no se repite.
    if (primary.disabled || cancelling.current || Date.now() - lastSubmit.current < CANCEL_ARM_MS) return;
    cancelling.current = true;
    void cancel(conv.id).finally(() => { cancelling.current = false; });
  };

  const switchAgent = (a: AgentId) => {
    if (a !== agent) changeAgent(a, conv.id);
    setPicker(null);
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, title: tr('Adjuntar archivos') });
    if (!picked || useStore.getState().activeConversationId !== conv.id) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setAttachments((a) => [...new Set([...a, ...list])]);
  };

  return (
    <div className="composer-wrap">
      <AnimatePresence>
        {claudeLoggedOut && (
          <Notice key="logout" tone="warn">
            <TriangleAlert size={13} />
            {tr('Claude Code no tiene sesión iniciada en esta cuenta.')}
            <button className="notice-link" onClick={() => useStore.getState().setView('settings', 'accounts')}>
              {tr('Iniciar sesión')}
            </button>
          </Notice>
        )}
        {replacement && (
          <Notice key="replaced" tone="warn">
            <TriangleAlert size={13} className="shrink-0" />
            <span className="min-w-0">
              {invalidEffort && effort
                ? tr('El esfuerzo «{effort}» ya no está disponible en {model}.', { effort: effortLabel(effort), model: replacement.label })
                : tr('«{model}» ya no está disponible en {agent}.', { model: prefs?.model, agent: AGENT_NAME[agent] })}
            </span>
            <button className="notice-link" onClick={() => {
              modelBtn.current?.focus({ preventScroll: true });
              setPrefs(conv.id, { model: replacement.id, effort: replacementEffort }, prefs);
            }}>
              {tr('Usar {option}', { option: invalidEffort ? replacementEffort ? effortLabel(replacementEffort) : tr('Predeterminado') : replacement.label })}
            </button>
            <button className="notice-link" onClick={() => setPicker('model')}>
              {tr('Elegir otro')}
            </button>
          </Notice>
        )}
      </AnimatePresence>

      <AgentActivity view={activity} idleAgent={agent} />
      <QueueTray conversationId={conv.id} queue={queue} active={busy} focusComposer={() => ta.current?.focus({ preventScroll: true })} />

      <div className="composer" data-agent={agent} data-busy={busy || undefined} data-waiting={activity.activity === 'waiting' || undefined}>
        <AnimatePresence initial={false}>
          {attachments.length > 0 && (
            <motion.div
              className="composer-attachments"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
            >
              <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                <AnimatePresence initial={false}>
                  {classified.map((c) => (
                    <AttachmentChip key={c.path} c={c} onRemove={() => setAttachments((a) => a.filter((x) => x !== c.path))} />
                  ))}
                </AnimatePresence>
              </div>
              <div className="attach-summary">
                <Info size={12} className="shrink-0" />
                <span className="min-w-0">{summarize(classified)}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {suggestions.popup}
        <textarea
          ref={ta}
          className="composer-input selectable"
          rows={1}
          value={text}
          placeholder={tr('Describe un cambio o pregunta sobre el código…')}
          onChange={(e) => {
            updateText(e.target.value);
            suggestions.onTextChange(e.currentTarget);
          }}
          onFocus={suggestions.onFocus}
          onBlur={suggestions.onBlur}
          onSelect={(event) => suggestions.selectCaret(event.currentTarget)}
          aria-controls={suggestions.controls}
          aria-activedescendant={suggestions.activeDescendant}
          onKeyDown={(e) => {
            if (suggestions.onKey(e)) return;
            // Ajustes → Conversaciones: «Enter envía» (predeterminado) o «Ctrl+Enter envía».
            // Con un turno de Codex que admite intervención, Alt+Enter interviene en lugar de encolar.
            if (e.key === 'Enter' && e.altKey && !e.shiftKey && !e.nativeEvent.isComposing && steerRun) {
              e.preventDefault();
              void submit('steer');
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (enterSends || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label="Mensaje"
        />

        <div className="composer-bar">
          <div className="composer-group">
            <button className="btn-icon composer-attach" aria-label={tr('Adjuntar archivos')} data-tip={tr('Adjuntar archivos (o arrástralos aquí)')} onClick={() => void attach()}>
              <Paperclip size={16} strokeWidth={1.7} />
            </button>

            <button
              ref={agentBtn}
              className="agent-btn composer-picker"
              onClick={() => setPicker(picker === 'agent' ? null : 'agent')}
              aria-label={tr('Agente para el próximo mensaje: {agent}', { agent: AGENT_NAME[agent] })}
              data-tip={tr('Agente para el próximo mensaje: {agent}', { agent: AGENT_NAME[agent] })}
              aria-haspopup="menu"
              aria-expanded={picker === 'agent'}
              aria-controls={picker === 'agent' ? agentMenuId : undefined}
            >
              <Mascot agent={agent} state="idle" size={22} animated={false} />
              <span className="agent-label">{AGENT_NAME[agent]}</span>
              <ChevronDown size={11} aria-hidden className="picker-chevron" />
            </button>
            <Popover open={picker === 'agent'} onClose={() => setPicker(null)} anchor={agentBtn.current}
              placement="top-start" width={160} menuId={agentMenuId} ariaLabel={tr('Agente para el próximo mensaje')} className="composer-popup">
              <MenuLabel>{tr('Agente')}</MenuLabel>
              {(['claude', 'codex'] as AgentId[]).map((a) => (
                <MenuItem
                  key={a}
                  selected={agent === a}
                  icon={<Mascot agent={a} state="idle" size={22} animated={false} />}
                  label={AGENT_NAME[a]}
                  onSelect={() => switchAgent(a)}
                />
              ))}
            </Popover>

            <button
              ref={modelBtn}
              className="model-btn composer-picker"
              onClick={() => setPicker(picker === 'model' ? null : 'model')}
              aria-label={tr('Modelo: {model}', { model: modelLabel })}
              aria-haspopup="dialog"
              aria-expanded={picker === 'model'}
              aria-controls={picker === 'model' ? modelMenuId : undefined}
            >
              <span className="truncate" data-tip={modelLabel} data-tip-truncated>{modelLabel}</span>
              <ChevronDown size={11} aria-hidden className="picker-chevron" />
            </button>
            <Popover open={picker === 'model'} onClose={() => setPicker(null)} anchor={modelBtn.current}
              placement="top-start" width={300} menuId={modelMenuId} role="dialog" ariaLabel={tr('Modelo')} className="composer-popup">
              <ModelPicker key={picker === 'model' ? 'open' : 'closed'} conv={conv} onDone={() => {
                modelBtn.current?.focus();
                setPicker(null);
              }} />
            </Popover>

            {showEffort && (
              <>
                <button
                  ref={effortBtn}
                  className="effort-btn composer-picker"
                  onClick={() => setPicker(picker === 'effort' ? null : 'effort')}
                  aria-label={tr('Esfuerzo: {effort}', { effort: effort ? effortLabel(effort) : tr('Predeterminado') })}
                  data-tip={tr('Esfuerzo: {effort}', { effort: effort ? effortLabel(effort) : tr('Predeterminado') })}
                  aria-haspopup="menu"
                  aria-expanded={picker === 'effort'}
                  aria-controls={picker === 'effort' ? effortMenuId : undefined}
                >
                  <Gauge size={13} aria-hidden />
                  <span className="effort-label">{effort ? effortLabel(effort) : tr('Esfuerzo')}</span>
                  <ChevronDown size={11} aria-hidden className="picker-chevron" />
                </button>
                <Popover open={picker === 'effort'} onClose={() => setPicker(null)} anchor={effortBtn.current}
                  placement="top-start" width={212}
                  menuId={effortMenuId} role="menu" ariaLabel={tr('Esfuerzo')} className="composer-popup">
                  {efforts.length > 0 ? (
                    <EffortMenu efforts={efforts} value={effort} defaultEffort={model?.defaultEffort} onSelect={(level) => {
                      setPrefs(conv.id, { effort: level }, prefs);
                      setPicker(null);
                      effortBtn.current?.focus({ preventScroll: true });
                    }} />
                  ) : (
                    <div className="p-3 text-[13px] muted" role="status">
                      {!catalog || catalog === 'loading' ? tr('Consultando modelos…') : tr('Este modelo no ofrece niveles de esfuerzo.')}
                    </div>
                  )}
                </Popover>
              </>
            )}

            <button
              ref={permBtn}
              type="button"
              className="perm-btn composer-picker"
              data-risk={shield.risk}
              data-restricted={shield.restricted || undefined}
              onClick={() => setPicker(picker === 'perm' ? null : 'perm')}
              aria-label={tr('Permisos: {summary}', { summary: permissionSummary(agent, permissions) })}
              data-tip={tr('Permisos: {summary}', { summary: permissionSummary(agent, permissions) })}
              aria-haspopup="menu"
              aria-expanded={picker === 'perm'}
              aria-controls={picker === 'perm' ? permMenuId : undefined}
            >
              <shield.Icon size={15} strokeWidth={1.7} aria-hidden />
              <ChevronDown size={11} aria-hidden className="picker-chevron" />
            </button>
            <Popover open={picker === 'perm'} onClose={() => setPicker(null)} anchor={permBtn.current}
              placement="top-start" width={318} menuId={permMenuId} role="menu" ariaLabel={tr('Permisos')} className="composer-popup">
              <PermissionMenu key={agent} open={picker === 'perm'} agent={agent} value={permissions} busy={busy} onChange={(next) => {
                if (!samePermissions(next, permissions)) setPermissions(conv.id, agent, next);
                setPicker(null);
                permBtn.current?.focus({ preventScroll: true });
              }} />
            </Popover>
          </div>

          <div className="composer-send-actions">
            {agentHasFast && (
              <>
                <button
                  ref={fastBtn}
                  type="button"
                  className="fast-btn composer-picker"
                  data-active={fastActive || undefined}
                  disabled={!fastInfo}
                  onClick={() => setPicker(picker === 'fast' ? null : 'fast')}
                  aria-haspopup="menu"
                  aria-expanded={picker === 'fast'}
                  aria-controls={picker === 'fast' ? fastMenuId : undefined}
                  aria-label={fastInfo ? (fastActive ? tr('Velocidad para el próximo mensaje: rápida') : tr('Velocidad para el próximo mensaje: estándar')) : tr('Modo rápido no disponible para este modelo')}
                  data-tip={!fastInfo ? tr('{model} no admite el modo rápido', { model: model?.label ?? tr('Este modelo') })
                    : `${fastActive ? tr('Velocidad rápida para el próximo mensaje') : tr('Velocidad estándar para el próximo mensaje')}${fastInfo.description ? ` · ${fastInfo.description}` : ''}`}
                >
                  <Zap size={15} strokeWidth={1.8} aria-hidden fill={fastActive ? 'currentColor' : 'none'} />
                </button>
                <Popover open={picker === 'fast'} onClose={() => setPicker(null)} anchor={fastBtn.current}
                  placement="top-end" width={236} menuId={fastMenuId} ariaLabel={tr('Velocidad')} className="composer-popup">
                  <MenuLabel>{tr('Velocidad del próximo mensaje')}</MenuLabel>
                  <MenuItem selected={!fastActive} icon={<Zap size={14} strokeWidth={1.7} />} label={tr('Estándar')}
                    onSelect={() => { void setSetting('composer.fast', false); setPicker(null); }} />
                  <MenuItem selected={fastActive} icon={<Zap size={14} strokeWidth={1.7} fill="currentColor" />} label={tr('Rápido')}
                    hint={fastInfo?.description || undefined}
                    onSelect={() => { void setSetting('composer.fast', true); setPicker(null); }} />
                </Popover>
              </>
            )}
            <motion.button
              type="button"
              className="send-btn"
              data-action={primary.action}
              disabled={primary.disabled}
              onClick={onPrimary}
              aria-label={primaryLabel}
              aria-keyshortcuts={steerRun ? 'Alt+Enter' : undefined}
              data-tip={steerRun && primary.action === 'queue' ? `${primaryLabel} · ${tr('Alt+Enter interviene en el turno activo de Codex')}` : primaryLabel}
              whileTap={{ scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 650, damping: 36 }}
            >
              <ArrowUp size={17} strokeWidth={2.2} aria-hidden className="send-btn-ic" data-icon="send" />
              <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden className="send-btn-ic" data-icon="cancel" />
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
});

function Notice({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return (
    <motion.div
      className="composer-notice surface-popup"
      data-tone={tone}
      role="status"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.36 }}
    >
      {children}
    </motion.div>
  );
}

const TREATMENT_ICON = { inline: ImageIcon, reference: FileText, binary: FileText, unsupported: CircleSlash };

function AttachmentChip({ c, onRemove }: { c: Classified; onRemove: () => void }) {
  const Icon = c.short.startsWith('Carpeta') ? Folder : TREATMENT_ICON[c.treatment];
  return (
    <motion.span
      layout
      className="attach-chip"
      data-treatment={c.treatment}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ type: 'spring', bounce: 0.2, duration: 0.32 }}
    >
      <span className="flex min-w-0 items-center gap-1.5" tabIndex={0} data-tip={`${c.path}\n${c.detail}`} aria-label={`${c.name}: ${c.short}`}>
        <Icon size={12} className="shrink-0" />
        <span className="max-w-[160px] truncate">{c.name}</span>
        <span className="attach-kind">{c.short}</span>
      </span>
      <button className="attach-remove" aria-label={tr('Quitar {name}', { name: c.name })} onClick={onRemove}>
        <X size={11} />
      </button>
    </motion.span>
  );
}

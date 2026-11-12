import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, Check, ChevronDown, CircleSlash, FileText, Folder, Image as ImageIcon, Info, Paperclip, Square, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Vaso } from 'vaso';
import { catalogModels, resolvePrefs, useStore } from '../../state/store';
import type { AgentId, Conversation, ModelCatalog } from '../../lib/types';
import { AGENT_NAME, effortLabel } from '../../lib/format';
import { api } from '../../lib/ipc';
import { classifyAttachment, summarize, type AttachmentMeta, type Classified } from '../../lib/attachments';
import { usePointerGlow } from '../../hooks/usePointerGlow';
import { Popover, MenuItem, MenuLabel, MenuSeparator } from '../ui/Popover';
import { AgentGlyph } from '../ui/AgentGlyph';
import { SPRING } from '../../lib/motion';

export function Composer({ conv, attachments, setAttachments, refract }: {
  conv: Conversation;
  attachments: string[];
  setAttachments: (f: (a: string[]) => string[]) => void;
  /** Lente óptica del cristal: desactivada, sobria o con dispersión espectral leve. */
  refract: false | 'balanced' | 'full';
}) {
  const prefs = useStore((s) => s.prefs[conv.id]);
  const catalogs = useStore((s) => s.catalogs);
  const run = useStore((s) => s.runs[conv.id]);
  const send = useStore((s) => s.send);
  const cancel = useStore((s) => s.cancel);
  const saveDraft = useStore((s) => s.saveDraft);
  const enterSends = useStore((s) => s.settings['composer.enterToSend'] !== false);
  const setPrefs = useStore((s) => s.setPrefs);
  const [text, setText] = useState(conv.draft);
  const ta = useRef<HTMLTextAreaElement>(null);
  const glow = usePointerGlow<HTMLDivElement>();
  const modelBtn = useRef<HTMLButtonElement>(null);
  const modelMenuId = useId();
  const [modelOpen, setModelOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Borrador propio de cada conversación.
  useEffect(() => {
    setText(conv.draft);
    requestAnimationFrame(() => ta.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Preferencias iniciales: las de la conversación (por agente) o los valores por defecto.
  useEffect(() => {
    const s = useStore.getState();
    const catalog = s.catalogs[conv.lastAgent ?? (s.settings['defaults.agent'] as AgentId) ?? 'codex'];
    if (!prefs && catalog && catalog !== 'loading') {
      useStore.setState((st) => ({ prefs: { ...st.prefs, [conv.id]: resolvePrefs(conv, st) } }));
    }
  }, [conv, prefs, catalogs]);

  // Cuando llega el catálogo, se valida el modelo elegido. Si ya no existe se anuncia (AUD-004).
  useEffect(() => {
    if (!prefs || prefs.replaced) return;
    const models = catalogModels(catalogs[prefs.agent]);
    if (!models.length) return;
    if (!prefs.model || !models.some((m) => m.id === prefs.model)) setPrefs(conv.id, resolvePrefs(conv, useStore.getState(), prefs.agent));
  }, [catalogs, prefs, conv, setPrefs]);

  // La altura real del compositor se publica en --composer-h: el chat ajusta su margen inferior y
  // su desvanecimiento para que ningún texto quede pegado al borde del cristal (AUD-003).
  useEffect(() => {
    const el = glow.ref.current;
    const host = el?.closest('section');
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--composer-h', `${Math.round(el.offsetHeight)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [glow.ref]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const agent = prefs?.agent ?? conv.lastAgent ?? 'codex';
  const catalog = catalogs[agent];
  const models = catalogModels(catalog);
  const model = models.find((m) => m.id === prefs?.model);
  const busy = !!run;
  const replaced = prefs?.replaced ?? null;
  const canSend = !busy && !sending && !!prefs?.model && !replaced && (text.trim().length > 0 || attachments.length > 0);
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

  const doSend = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await send(conv.id, text, attachments);
    setSending(false);
    if (ok) {
      setText('');
      setAttachments(() => []);
    }
  };

  const switchAgent = (a: AgentId) => {
    if (a === agent) return;
    setPrefs(conv.id, resolvePrefs(conv, useStore.getState(), a));
  };

  const attach = async () => {
    const picked = await openDialog({ multiple: true, title: 'Adjuntar archivos' });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    setAttachments((a) => [...new Set([...a, ...list])]);
  };

  return (
    <div className="composer-wrap">
      <AnimatePresence>
        {claudeLoggedOut && (
          <Notice key="logout" tone="warn">
            <TriangleAlert size={13} />
            Claude Code no tiene sesión iniciada en esta cuenta.
            <button className="notice-link" onClick={() => useStore.getState().setView('settings', 'accounts')}>
              Iniciar sesión
            </button>
          </Notice>
        )}
        {replaced && (
          <Notice key="replaced" tone="warn">
            <TriangleAlert size={13} className="shrink-0" />
            <span className="min-w-0">
              «{replaced.from}» ya no está disponible en {AGENT_NAME[agent]}. Se propone {model?.label ?? prefs?.model}.
            </span>
            <button className="notice-link" onClick={() => setPrefs(conv.id, { replaced: null })}>
              Usar {model?.label ?? 'este'}
            </button>
            <button className="notice-link" onClick={() => setModelOpen(true)}>
              Elegir otro
            </button>
          </Notice>
        )}
      </AnimatePresence>

      <motion.div
        ref={glow.ref}
        onPointerMove={glow.onPointerMove}
        onPointerLeave={glow.onPointerLeave}
        className="composer mat-primary"
        data-env=""
        data-optical={refract ? '' : undefined}
        data-agent={agent}
        data-busy={busy || undefined}
        layout
        transition={{ type: 'spring', stiffness: 480, damping: 37 }}
      >
        {refract && (
          <Vaso component="span" className="composer-lens" depth={refract === 'full' ? 3.2 : 2.7} blur={1.4}
            dispersion={refract === 'full' ? 0.3 : false} specular={0.5} style={{ position: 'absolute' }} aria-hidden />
        )}
        <span className="glass-bevel" aria-hidden />
        <span className="glow-layer" aria-hidden />

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

        <motion.textarea
          layout="position"
          ref={ta}
          className="composer-input selectable"
          rows={1}
          value={text}
          placeholder={busy ? `${AGENT_NAME[run.agent]} está trabajando… puedes seguir escribiendo` : `Escribe a ${AGENT_NAME[agent]}`}
          onChange={(e) => {
            setText(e.target.value);
            saveDraft(conv.id, e.target.value);
          }}
          onKeyDown={(e) => {
            // Ajustes → Conversaciones: «Enter envía» (predeterminado) o «Ctrl+Enter envía».
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (enterSends || e.ctrlKey)) {
              e.preventDefault();
              void doSend();
            }
          }}
          aria-label="Mensaje"
        />

        <motion.div className="composer-bar" layout="position">
          <button className="btn-icon composer-attach" aria-label="Adjuntar archivos" data-tip="Adjuntar archivos (o arrástralos aquí)" onClick={() => void attach()}>
            <Paperclip size={16} strokeWidth={1.7} />
          </button>

          <div className="agent-switch" role="radiogroup" aria-label="Agente">
            {(['claude', 'codex'] as AgentId[]).map((a) => (
              <button
                key={a}
                role="radio"
                aria-checked={agent === a}
                aria-label={AGENT_NAME[a]}
                className="agent-option"
                data-on={agent === a || undefined}
                disabled={busy}
                tabIndex={agent === a ? 0 : -1}
                onClick={() => switchAgent(a)}
                onKeyDown={(e) => {
                  // Patrón ARIA de radiogroup: una sola parada de Tab y flechas para cambiar.
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                  e.preventDefault();
                  const next: AgentId = a === 'claude' ? 'codex' : 'claude';
                  const group = e.currentTarget.parentElement;
                  switchAgent(next);
                  requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[aria-label="${AGENT_NAME[next]}"]`)?.focus());
                }}
                data-tip={busy ? 'Espera a que termine la ejecución para cambiar de agente' : `Responder con ${AGENT_NAME[a]}`}
              >
                {agent === a && (
                  <motion.span aria-hidden layoutId={`agent-pill-${conv.id}`} className="agent-pill"
                    style={{ borderRadius: 'var(--p-radius-pill)' }}
                    transition={SPRING.pill} />
                )}
                <span className="relative flex items-center gap-1.5">
                  <AgentGlyph agent={a} size={18} />
                  <span className="agent-label">{AGENT_NAME[a]}</span>
                </span>
              </button>
            ))}
          </div>

          <button
            ref={modelBtn}
            className="model-btn"
            onClick={() => setModelOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            aria-controls={modelOpen ? modelMenuId : undefined}
            disabled={busy}
            data-tip={model ? `${model.label}${model.resolved && model.resolved !== model.id ? ` → ${model.resolved}` : ''}${prefs?.effort ? ` · razonamiento ${effortLabel(prefs.effort).toLowerCase()}` : ''}` : undefined}
          >
            <span className="model-btn-fill" aria-hidden />
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${agent}:${prefs?.model}`}
                className="min-w-0 truncate"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.13 }}
              >
                {catalog === 'loading' ? 'Cargando modelos…' : catalog && 'error' in catalog ? 'Modelos no disponibles' : (model?.label ?? prefs?.model) || 'Elige un modelo'}
              </motion.span>
            </AnimatePresence>
            {prefs?.effort && <span className="effort-tag">{effortLabel(prefs.effort)}</span>}
            <ChevronDown size={13} className="model-chevron shrink-0 faint" aria-hidden />
          </button>
          <Popover open={modelOpen} onClose={() => setModelOpen(false)} anchor={modelBtn.current} placement="top-start" width={330} menuId={modelMenuId}>
            <ModelMenu conv={conv} onDone={() => {
              modelBtn.current?.focus();
              setModelOpen(false);
            }} />
          </Popover>

          <div className="min-w-0 flex-1" />

          <motion.button
            className="send-btn"
            data-mode={busy ? 'stop' : 'send'}
            data-ready={canSend || undefined}
            disabled={busy ? !!run?.stopping : !canSend}
            onClick={() => (busy ? void cancel(conv.id) : void doSend())}
            aria-label={busy ? 'Detener la ejecución' : 'Enviar mensaje'}
            data-tip={busy ? (run?.stopping ? 'Deteniendo…' : 'Detener la ejecución') : replaced ? 'Confirma o elige el modelo antes de enviar' : undefined}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 650, damping: 36 }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {busy ? (
                <motion.span key="stop" initial={{ scale: 0.4, opacity: 0, rotate: -45 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} exit={{ scale: 0.4, opacity: 0 }} className="grid place-items-center">
                  <Square size={12} fill="currentColor" strokeWidth={0} />
                </motion.span>
              ) : (
                <motion.span key="send" initial={{ scale: 0.4, opacity: 0, y: 6 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.4, opacity: 0, y: -6 }} className="grid place-items-center">
                  <ArrowUp size={17} strokeWidth={2.2} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        </motion.div>
      </motion.div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return (
    <motion.div
      className="composer-notice mat-float"
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
      <button className="attach-remove" aria-label={`Quitar ${c.name}`} onClick={onRemove}>
        <X size={11} />
      </button>
    </motion.span>
  );
}

function ModelMenu({ conv, onDone }: { conv: Conversation; onDone: () => void }) {
  const prefs = useStore((s) => s.prefs[conv.id]);
  const catalog = useStore((s) => (prefs ? s.catalogs[prefs.agent] : undefined));
  const setPrefs = useStore((s) => s.setPrefs);
  const refresh = useStore((s) => s.refreshCatalog);
  if (!prefs) return null;
  if (catalog === 'loading' || !catalog) return <div className="p-3 text-[13px] muted">Consultando modelos…</div>;
  if ('error' in catalog)
    return (
      <div className="p-3 text-[13px]">
        <div className="muted">No se pudieron obtener los modelos de {AGENT_NAME[prefs.agent]}.</div>
        <div className="selectable mt-1 text-[12px] faint">{catalog.error}</div>
        <button className="btn mt-3" onClick={() => void refresh(prefs.agent, true)}>
          Reintentar
        </button>
      </div>
    );
  const models = catalogModels(catalog);
  const current = models.find((m) => m.id === prefs.model);
  return (
    <div className="max-h-[min(60vh,520px)] overflow-y-auto">
      <MenuLabel>Modelos de {AGENT_NAME[prefs.agent]}</MenuLabel>
      {models.length === 0 && <div className="px-2.5 pb-2 text-[12.5px] muted">El agente no informa modelos para esta cuenta.</div>}
      {models.map((m) => (
        <MenuItem
          key={m.id}
          selected={m.id === prefs.model}
          icon={m.id === prefs.model ? <Check size={14} /> : <span />}
          label={
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{m.label}</span>
              {m.description && <span className="truncate text-[11.5px] faint">{m.description}</span>}
            </span>
          }
          hint={m.resolved && m.resolved !== m.id ? m.resolved : undefined}
          onSelect={() => {
            const effort = prefs.effort && m.efforts.includes(prefs.effort) ? prefs.effort : (m.defaultEffort ?? null);
            setPrefs(conv.id, { model: m.id, effort, replaced: null });
          }}
        />
      ))}
      {current && current.efforts.length > 0 && (
        <>
          <MenuSeparator />
          <MenuLabel>Nivel de razonamiento</MenuLabel>
          <div className="flex flex-wrap gap-1 px-1.5 pb-1.5" role="radiogroup" aria-label="Nivel de razonamiento">
            {current.efforts.map((e) => (
              <button
                key={e}
                role="radio"
                aria-checked={prefs.effort === e}
                className="effort-chip"
                data-on={prefs.effort === e || undefined}
                onClick={() => {
                  setPrefs(conv.id, { effort: e, replaced: null });
                  onDone();
                }}
              >
                {effortLabel(e)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="px-2.5 pb-1.5 pt-1 text-[11px] faint">Fuente: {catalog.source}</div>
    </div>
  );
}

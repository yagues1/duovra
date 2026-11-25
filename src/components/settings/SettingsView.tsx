import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  BellRing,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  KeyRound,
  MessagesSquare,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { catalogModels, useStore, type SettingsSection } from '../../state/store';
import { api, errorText } from '../../lib/ipc';
import type { AgentId, Intensity } from '../../lib/types';
import { DEFAULT_BACKGROUND } from '../../lib/background';
import { saveBackgroundPreferences } from '../../state/backgroundPreferences';
import { AGENT_NAME, effortLabel } from '../../lib/format';
import { Badge, Card, Field, Segmented, Select, Switch } from '../ui/Controls';
import { Mascot } from '../mascot/Mascot';
import { perfState } from '../../hooks/useAppearance';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { maxZoom } from '../../hooks/usePreferences';
import { promptDialog, confirmDialog } from '../ui/Dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { normalizeCatalog } from '../../lib/catalog';
import { DEFAULT_HUE, HUE_IDS, HUES, hueLabel, type HueId } from '../../lib/hues';
import { asLanguagePref, fmt, LANGUAGE_KEY, tr, type LanguagePref } from '../../i18n';
import { UpdateSettings, useDistribution } from '../distribution/Distribution';
import { SPRING } from '../../lib/motion';
import { UsageDashboard } from './UsageDashboard';
import { readingOptions, type MascotMotion, type ReadingSize } from '../../lib/appearance';
import { BackgroundSettings } from './BackgroundSettings';
import { restoreConfirmBody } from '../../lib/backups';

const REPO = 'https://github.com/yagues1/duovra';

// Getters: las etiquetas se traducen al leerlas, así cambian de idioma sin reiniciar.
const SECTIONS: { id: SettingsSection; label: string; group: string; icon: (size: number) => ReactNode }[] = [
  { id: 'appearance', get label() { return tr('Apariencia'); }, get group() { return tr('Experiencia'); }, icon: (n) => <Palette size={n} /> },
  { id: 'conversations', get label() { return tr('Conversaciones'); }, get group() { return tr('Experiencia'); }, icon: (n) => <MessagesSquare size={n} /> },
  { id: 'agents', get label() { return tr('Agentes y modelos'); }, get group() { return tr('Agentes'); }, icon: (n) => <Bot size={n} /> },
  { id: 'accounts', get label() { return tr('Cuentas y uso'); }, get group() { return tr('Agentes'); }, icon: (n) => <KeyRound size={n} /> },
  { id: 'statistics', get label() { return tr('Estadísticas'); }, get group() { return tr('Agentes'); }, icon: (n) => <Activity size={n} /> },
  { id: 'updates', get label() { return tr('Actualizaciones y avisos'); }, get group() { return tr('Sistema'); }, icon: (n) => <BellRing size={n} /> },
  { id: 'data', get label() { return tr('Datos y diagnóstico'); }, get group() { return tr('Sistema'); }, icon: (n) => <Database size={n} /> },
];

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/** Duración de la salida del diálogo (settings.css: settings-dialog-out). */
const CLOSE_MS = 180;

/**
 * Ajustes como diálogo sobre la pantalla actual: la conversación sigue montada
 * detrás (desplazamiento, compositor y ejecuciones intactos) y el fondo se oscurece apenas. Un
 * `<dialog>` modal nativo vuelve inerte lo de detrás, atrapa el foco, atiende Escape y devuelve el
 * foco al control que lo abrió. Los agentes siguen trabajando mientras está abierto.
 */
export function SettingsDialog({ intensity }: { intensity: Intensity }) {
  const open = useStore((s) => s.settingsOpen);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const t = window.setTimeout(() => setMounted(false), CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, mounted]);
  if (!mounted) return null;
  return <SettingsFrame open={open} intensity={intensity} />;
}

function SettingsFrame({ open, intensity }: { open: boolean; intensity: Intensity }) {
  const section = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const closeSettings = useStore((s) => s.closeSettings);
  const pulse = useStore((s) => s.savedPulse);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const navRefs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const peek = useStore((s) => s.settingsPeek);
  const setPeek = useStore((s) => s.setSettingsPeek);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const previewExit = useRef<HTMLButtonElement>(null);
  const uid = useId();

  useLayoutEffect(() => {
    const el = dialog.current!;
    const trigger = document.activeElement;
    // Lo que queda detrás no debe gastar: las mascotas pausan su animación (mascot.css).
    document.documentElement.dataset.settingsOpen = '';
    el.showModal();
    navRefs.current[useStore.getState().settingsSection]?.focus({ preventScroll: true });
    return () => {
      delete document.documentElement.dataset.settingsOpen;
      if (el.open) el.close();
      // Se cerró para abrir una conversación con foco en su título (p. ej. desde Estadísticas): mientras
      // el diálogo seguía montado, ese foco no podía llegar; se aplica ahora.
      const state = useStore.getState();
      const title = state.focusConversationId && state.focusConversationId === state.activeConversationId
        ? document.getElementById('conversation-title') : null;
      if (title) {
        title.focus({ preventScroll: true });
        useStore.setState({ focusConversationId: null });
        return;
      }
      // El foco vuelve a quien abrió Ajustes; si ya no existe, al compositor.
      const target = trigger instanceof HTMLElement && trigger.isConnected && trigger !== document.body
        ? trigger : document.querySelector<HTMLElement>('.composer-input');
      target?.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (peek) previewExit.current?.focus({ preventScroll: true });
    else if (previewTrigger.current) {
      previewTrigger.current.focus({ preventScroll: true });
      previewTrigger.current = null;
    }
  }, [peek]);

  const showPreview = () => {
    previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPeek(true);
  };

  // Cerrado pero aún animando la salida: ya no atrapa el foco ni los clics.
  useEffect(() => {
    if (!open) dialog.current?.setAttribute('inert', '');
  }, [open]);

  // Si el control enfocado desaparece (la sección anterior termina su salida), el foco no cae al body:
  // vuelve al panel o a la pestaña activa.
  useEffect(() => {
    const el = dialog.current;
    if (!el || !open) return;
    let frame = 0;
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!el.open || el.contains(document.activeElement)) return;
        (body.current ?? navRefs.current[useStore.getState().settingsSection])?.focus({ preventScroll: true });
      });
    };
    el.addEventListener('focusout', onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [open]);

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [section]);

  const go = (id: SettingsSection, focus = false) => {
    setView('settings', id);
    if (focus) navRefs.current[id]?.focus();
  };
  const onNavKey = (event: ReactKeyboardEvent) => {
    const i = SECTIONS.findIndex((s) => s.id === section);
    const next = event.key === 'ArrowDown' ? (i + 1) % SECTIONS.length
      : event.key === 'ArrowUp' ? (i - 1 + SECTIONS.length) % SECTIONS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    go(SECTIONS[next].id, true);
  };

  // El <dialog> modal deja salir el foco tras el último control (en WebView2 acaba en el body), y una
  // sección que se está sustituyendo puede quedarse sin controles un instante: el diálogo recorre su
  // propia lista en orden del documento y nunca deja Tab al navegador.
  const trapTab = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => !el.matches('[tabindex="-1"]') && !el.closest('[inert], [hidden], [aria-hidden="true"]') && el.getClientRects().length > 0);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (event.shiftKey ? items.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  };

  let lastGroup = '';
  return (
    <dialog
      ref={dialog}
      onKeyDown={(event) => {
        if (peek && event.key === 'Escape') {
          event.preventDefault();
          setPeek(false);
        } else trapTab(event);
      }}
      className="settings-dialog"
      data-state={open ? 'open' : 'closed'}
      data-section={section}
      data-peek={peek || undefined}
      aria-labelledby={peek ? undefined : `${uid}-title`}
      aria-label={peek ? tr('Vista previa del fondo') : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (peek) setPeek(false);
        else void closeSettings();
      }}
      onMouseDown={(event) => {
        // Un clic fuera de la ventana (sobre el velo) cierra el diálogo.
        if (event.target !== event.currentTarget) return;
        if (peek) setPeek(false);
        else void closeSettings();
      }}
    >
      {peek && <button ref={previewExit} className="btn settings-preview-exit" type="button" onClick={() => setPeek(false)}>
        {tr('Volver a Ajustes')}
      </button>}
      <div className="settings-frame" hidden={peek}>
        <nav className="settings-nav-col" aria-label={tr('Secciones de ajustes')}>
          <h1 id={`${uid}-title`} className="settings-nav-title">{tr('Ajustes')}</h1>
          <div className="settings-nav-list" role="tablist" aria-orientation="vertical" onKeyDown={onNavKey}>
            {SECTIONS.map((s) => {
              const group = s.group !== lastGroup ? s.group : null;
              lastGroup = s.group;
              const active = section === s.id;
              return (
                <div key={s.id} className="contents">
                  {group && <p className="settings-nav-group" aria-hidden>{group}</p>}
                  <button
                    ref={(el) => { navRefs.current[s.id] = el; }}
                    type="button"
                    role="tab"
                    id={`${uid}-tab-${s.id}`}
                    aria-selected={active}
                    aria-controls={`${uid}-panel`}
                    tabIndex={active ? 0 : -1}
                    className="settings-nav"
                    data-on={active || undefined}
                    onClick={() => go(s.id)}
                  >
                    {active && <motion.span layoutId={`${uid}-pill`} className="settings-nav-pill" transition={SPRING.pill} />}
                    <span className="relative flex min-w-0 items-center gap-2.5">
                      <span className="settings-nav-icon">{s.icon(15)}</span>
                      <span className="truncate">{s.label}</span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex-1" />
          <SavedIndicator pulse={pulse} />
        </nav>
        <div className="settings-main">
          <button type="button" className="btn-icon settings-close" aria-label={tr('Cerrar Ajustes')} data-tip={tr('Cerrar (Esc)')} onClick={() => void closeSettings()}>
            <X size={16} strokeWidth={1.8} />
          </button>
          <ActiveWork />
          <div ref={body} className="settings-scroll" id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${section}`} tabIndex={-1}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={section}
                className="settings-content"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
              >
                <ErrorBoundary area={SECTIONS.find((x) => x.id === section)?.label ?? tr('esta sección')} resetKey={section} compact>
                  {section === 'appearance' && <Appearance effectiveIntensity={intensity} onPeek={showPreview} />}
                  {section === 'conversations' && <Conversations />}
                  {section === 'agents' && <Agents />}
                  {section === 'accounts' && (
                    <>
                      <Accounts />
                      <Usage />
                    </>
                  )}
                  {section === 'statistics' && <UsageDashboard />}
                  {section === 'updates' && <Updates />}
                  {section === 'data' && <DataSection />}
                </ErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * Ejecuciones activas mientras Ajustes está abierto: siguen su curso detrás. Si alguna espera una
 * autorización se avisa aquí con un acceso directo, porque los controles de permiso de la
 * conversación quedan inertes bajo el diálogo.
 */
function ActiveWork() {
  const waiting = useStore(useShallow((s) => Object.values(s.runs).filter((run) => run.approvals.length > 0).map((run) => run.conversationId)));
  const running = useStore((s) => Object.keys(s.runs).length);
  const title = useStore((s) => s.conversations.find((c) => c.id === waiting[0])?.title);
  const closeSettings = useStore((s) => s.closeSettings);
  if (!running) return null;
  const review = async () => {
    const id = waiting[0];
    if (id && await closeSettings()) void useStore.getState().selectConversation(id);
  };
  return (
    <div className="settings-activity" role="status" data-waiting={waiting.length > 0 || undefined}>
      <span className="settings-activity-dot" aria-hidden />
      {waiting.length > 0 ? (
        <>
          <span className="min-w-0 truncate">{waiting.length > 1 ? tr('{n} conversaciones esperan tu autorización', { n: waiting.length }) : tr('«{title}» espera tu autorización', { title: title ?? tr('Una conversación') })}</span>
          <button type="button" className="notice-link" onClick={() => void review()}>{tr('Revisar')}</button>
        </>
      ) : (
        <span className="min-w-0 truncate">{running > 1 ? tr('{n} agentes trabajando. Sigue en curso detrás.', { n: running }) : tr('Un agente está trabajando. Sigue en curso detrás.')}</span>
      )}
    </div>
  );
}

/** Microanimación de guardado automático. */
function SavedIndicator({ pulse }: { pulse: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!pulse) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1600);
    return () => clearTimeout(t);
  }, [pulse]);
  return (
    <div className="h-8 px-2.5" aria-live="polite">
      <AnimatePresence>
        {visible && (
          <motion.div
            key={pulse}
            className="flex items-center gap-1.5 text-[12.5px]"
            style={{ color: 'var(--success)' }}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ type: 'spring', stiffness: 520, damping: 30 }}
          >
            <motion.span initial={{ scale: 0 }} animate={{ scale: [0, 1.25, 1] }} transition={{ duration: 0.35 }} className="grid place-items-center">
              <Check size={13} strokeWidth={2.4} />
            </motion.span>
            Guardado
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const v = useStore((s) => s.settings[key] as T | undefined);
  const set = useStore((s) => s.setSetting);
  return [v ?? fallback, (x: T) => void set(key, x)];
}

/** Vista previa sin escribir en disco: actualiza el estado en memoria mientras se arrastra. */

function Header({ title, text }: { title: string; text?: string }) {
  const icon = SECTIONS.find((s) => s.label === title)?.icon(20);
  return (
    <div className="settings-section-head">
      {icon && <span className="settings-section-icon" aria-hidden>{icon}</span>}
      <div className="min-w-0">
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
    </div>
  );
}

// ---------- General ----------

const shortcuts = (): [string, string][] => [
  [tr('Nueva conversación'), 'Ctrl+N'],
  [tr('Abrir Ajustes'), 'Ctrl+,'],
  [tr('Mostrar u ocultar la barra lateral'), 'Ctrl+B'],
  [tr('Cerrar panel o capa'), 'Esc'],
];

/** Bloque plegable con aspecto de tarjeta: ajustes avanzados que no hace falta ver siempre. */
function Fold({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="settings-card settings-fold">
      <summary>
        <ChevronRight size={14} className="settings-fold-chev" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="settings-fold-title">{title}</span>
          {hint && <span className="settings-fold-hint">{hint}</span>}
        </span>
      </summary>
      <div className="px-4 pb-2">{children}</div>
    </details>
  );
}

function DefaultModel({ agent }: { agent: AgentId }) {
  const catalog = useAgentCatalog(agent);
  // El catálogo puede venir corrupto (AUD-001): se normaliza antes de leerlo.
  const models = useMemo(() => catalogModels(catalog && catalog !== 'loading' ? normalizeCatalog(catalog) : catalog), [catalog]);
  const [model, setModel] = useSetting<string>(`defaults.model.${agent}`, '');
  const [effort, setEffort] = useSetting<string>(`defaults.effort.${agent}`, '');
  const current = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0];
  return (
    <Field label={<span className="flex items-center gap-2"><Mascot agent={agent} state="idle" size={20} animated={false} />{AGENT_NAME[agent]}</span>} hint={models.length ? tr('Modelo y nivel de razonamiento para las conversaciones nuevas.') : tr('Sin catálogo de modelos disponible todavía.')}>
      <Select
        label={tr('Modelo de {agent}', { agent: AGENT_NAME[agent] })}
        value={model}
        onChange={setModel}
        options={[{ value: '', label: tr('El recomendado por el agente') }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
      />
      {current && (current.efforts?.length ?? 0) > 0 && (
        <Select
          label={tr('Razonamiento')}
          value={effort}
          onChange={setEffort}
          options={[{ value: '', label: tr('Predeterminado') }, ...current.efforts.map((e) => ({ value: e, label: effortLabel(e) }))]}
        />
      )}
    </Field>
  );
}

// ---------- Agentes ----------

function Agents() {
  const detection = useStore((s) => s.detection);
  const refresh = useStore((s) => s.refreshDetection);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useSetting('codex.approvalPolicy', 'on-request');
  const [sandbox, setSandbox] = useSetting('codex.sandbox', 'workspace-write');
  const [perm, setPerm] = useSetting('claude.permissionMode', 'manual');
  const [summaries, setSummaries] = useSetting('claude.thinkingSummaries', true);
  const [agent, setAgent] = useSetting<AgentId>('defaults.agent', 'codex');
  return (
    <>
      <Header title={tr('Agentes y modelos')} text={tr('Duovra usa las CLIs oficiales instaladas en este equipo, con su propia configuración. No guarda ni reutiliza credenciales. Cada conversación recuerda su propio agente, modelo y razonamiento.')} />
      <Card title={tr('Conversaciones nuevas')}>
        <Field label={tr('Agente predeterminado')} hint={tr('Siempre puedes cambiarlo en el cuadro de escritura, mensaje a mensaje.')}>
          <Segmented id="def-agent" value={agent} onChange={setAgent} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
        </Field>
        <DefaultModel agent="claude" />
        <DefaultModel agent="codex" />
      </Card>
      <Card
        title={tr('Instalaciones detectadas')}
        actions={
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await refresh(); setBusy(false); }}>
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Volver a detectar
          </button>
        }
      >
        {(['claude', 'codex'] as AgentId[]).map((a) => {
          const d = detection?.find((x) => x.agent === a);
          return (
            <AgentPath key={a} agent={a} detected={d?.path ?? null} version={d?.version ?? null} installed={d?.installed} />
          );
        })}
      </Card>
      <Card title="Codex">
        <Field label={tr('Aprobaciones')} hint={tr('Cuándo pide Codex permiso antes de ejecutar comandos o salir del sandbox.')}>
          <Select label={tr('Política de aprobación')} value={approval} onChange={setApproval} options={[
            { value: 'untrusted', label: tr('Pedir para todo lo no confiable') },
            { value: 'on-request', label: tr('Cuando el modelo lo pida') },
            { value: 'never', label: tr('Nunca preguntar') },
          ]} />
        </Field>
        <Field label="Sandbox" hint={tr('Acceso de Codex al sistema de archivos durante los turnos.')}>
          <Select label="Sandbox" value={sandbox} onChange={setSandbox} options={[
            { value: 'read-only', label: tr('Solo lectura') },
            { value: 'workspace-write', label: tr('Escritura en el proyecto') },
            { value: 'danger-full-access', label: tr('Acceso completo (peligroso)') },
          ]} />
        </Field>
      </Card>
      <Card title="Claude Code">
        <Field label={tr('Modo de permisos')} hint={tr('Con «Manual», cada herramienta que lo requiera se aprueba desde la conversación.')}>
          <Select label={tr('Modo de permisos')} value={perm} onChange={setPerm} options={[
            { value: 'manual', label: tr('Manual (preguntar)') },
            { value: 'acceptEdits', label: tr('Aceptar ediciones') },
            { value: 'plan', label: tr('Solo planificar') },
            { value: 'auto', label: tr('Automático de Claude Code') },
            { value: 'dontAsk', label: tr('No preguntar (denegar lo no permitido)') },
            { value: 'bypassPermissions', label: tr('Omitir permisos (peligroso)') },
          ]} />
        </Field>
        <Field label={tr('Resúmenes de razonamiento')} hint={tr('Pide a Claude Code los resúmenes de pensamiento oficiales (showThinkingSummaries) solo en las sesiones que abre Duovra. Algunos modelos no los entregan; si no llegan, no se muestra nada.')}>
          <Switch label={tr('Resúmenes de razonamiento')} checked={summaries} onChange={setSummaries} />
        </Field>
      </Card>
      <Fold title={tr('Avanzado · Catálogo de modelos')} hint={tr('Todos los modelos que informa cada agente para la cuenta activa.')}>
        <p className="mb-1 mt-1 text-[12.5px] faint">{tr('Que un modelo aparezca aquí no garantiza que tu plan pueda usarlo: si el proveedor lo rechaza, verás el error en la conversación.')}</p>
        {(['claude', 'codex'] as AgentId[]).map((a) => (
          <ErrorBoundary key={a} area={tr('los modelos de {agent}', { agent: AGENT_NAME[a] })} compact>
            <AgentModels agent={a} />
          </ErrorBoundary>
        ))}
      </Fold>
    </>
  );
}

function AgentPath({ agent, detected, version, installed }: { agent: AgentId; detected: string | null; version: string | null; installed?: boolean }) {
  const [custom, setCustom] = useSetting<string>(`agents.${agent}.path`, '');
  const [draft, setDraft] = useState(custom);
  return (
    <div className="setting-row items-start">
      <Mascot agent={agent} state="idle" size={34} animated={false} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px]">
          {AGENT_NAME[agent]}
          {installed === undefined ? <Badge tone="neutral">{tr('Comprobando')}</Badge> : installed && version ? <Badge tone="ok">{version}</Badge> : installed ? <Badge tone="warn">{tr('No responde')}</Badge> : <Badge tone="error">{tr('No encontrado')}</Badge>}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11.5px] faint" data-tip={detected ?? ''} data-tip-truncated>
          {detected ?? tr('No está en el PATH ni en las rutas habituales.')}
        </div>
        <div className="mt-2 flex gap-2">
          <input className="input" placeholder={tr('Ruta personalizada del ejecutable (opcional)')} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" disabled={draft === custom} onClick={() => { setCustom(draft.trim()); void useStore.getState().refreshDetection(); void useStore.getState().refreshCatalog(agent, true); }}>
            {tr('Aplicar')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Modelos ----------

function AgentModels({ agent }: { agent: AgentId }) {
  const raw = useStore((s) => s.catalogs[agent]);
  const refresh = useStore((s) => s.refreshCatalog);
  // Defensa adicional: aunque el almacén ya normaliza, la vista no confía en la forma de los datos.
  const c = useMemo(() => (raw && raw !== 'loading' ? normalizeCatalog(raw) : raw), [raw]);
  const loading = c === 'loading' || !c;
  return (
    <Card
      title={<span className="flex items-center gap-2"><Mascot agent={agent} state="idle" size={24} animated={false} />{AGENT_NAME[agent]}</span>}
      actions={
        <button className="btn" disabled={loading} onClick={() => void refresh(agent, true)}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {tr('Actualizar')}
        </button>
      }
    >
      {loading ? (
        <p className="py-2 text-[13px] muted">{tr('Consultando a {agent}…', { agent: AGENT_NAME[agent] })}</p>
      ) : 'error' in c ? (
        <div className="py-2">
          <p className="m-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>{tr('No se pudo obtener el catálogo de {agent}.', { agent: AGENT_NAME[agent] })}</p>
          <p className="selectable mb-0 mt-1 text-[12.5px]" style={{ color: 'var(--danger)' }}>{c.error}</p>
        </div>
      ) : c.models.length === 0 ? (
        <p className="py-2 text-[13px] muted">{tr('{agent} no ha informado ningún modelo para esta cuenta. Pulsa «Actualizar» para volver a consultarlo.', { agent: AGENT_NAME[agent] })}</p>
      ) : (
        <>
          {c.models.map((m) => (
            <div key={m.id} className="setting-row model-row">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px]" style={{ color: 'var(--text-primary)' }}>
                  {m.label}
                  {m.isDefault && <Badge tone="ok">{tr('Predeterminado')}</Badge>}
                </div>
                <div className="selectable break-all font-mono text-[11.5px] faint">{m.id}{m.resolved && m.resolved !== m.id ? ` → ${m.resolved}` : ''}</div>
                {m.description && <div className="mt-0.5 text-[12.5px] faint">{m.description}</div>}
              </div>
              <div className="model-efforts">
                {m.efforts.length ? (
                  m.efforts.map((e) => (
                    <span key={e} className="chip" data-default={e === m.defaultEffort || undefined}>{effortLabel(e)}</span>
                  ))
                ) : (
                  <span className="text-[12px] faint">{tr('Sin niveles de razonamiento informados')}</span>
                )}
              </div>
            </div>
          ))}
          <p className="mb-2 mt-2 text-[12px] faint">
            {tr('Fuente:')} {c.source}{c.version ? ' ' + tr('(versión {version})', { version: c.version }) : ''}
            {c.skipped ? ' · ' + tr('{n} entradas sin identificador válido o duplicadas omitidas', { n: c.skipped }) : ''}
          </p>
        </>
      )}
    </Card>
  );
}

// ---------- Cuentas ----------

function Accounts() {
  return (
    <>
      <Header title={tr('Cuentas')} text={tr('Cada cuenta es un directorio de configuración de la CLI (CODEX_HOME para Codex, CLAUDE_CONFIG_DIR para Claude Code). El inicio de sesión lo hace siempre la CLI oficial; la aplicación no ve ni almacena tokens.')} />
      <AccountCard agent="claude" />
      <AccountCard agent="codex" />
    </>
  );
}

function AccountCard({ agent }: { agent: AgentId }) {
  const allAccounts = useStore((s) => s.accounts);
  const accounts = useMemo(() => allAccounts.filter((a) => a.agent === agent), [allAccounts, agent]);
  const setAccounts = useStore((s) => s.setAccounts);
  const [active, setActive] = useSetting<string | null>(`accounts.active.${agent}`, null);
  const [status, setStatus] = useState<Record<string, unknown> | { error: string } | null>(null);
  const toast = useStore((s) => s.toast);

  const load = async () => {
    setStatus(null);
    try {
      setStatus(await api.agentAccount(agent));
      if (agent === 'claude') void useStore.getState().refreshCatalog('claude', true);
    } catch (e) {
      setStatus({ error: errorText(e) });
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const choose = (id: string | null) => {
    setActive(id);
    void useStore.getState().refreshCatalog(agent, true);
  };

  const add = async () => {
    const label = await promptDialog({ title: tr('Nueva cuenta de {agent}', { agent: AGENT_NAME[agent] }), body: tr('Ponle un nombre y elige después una carpeta vacía donde la CLI guardará su configuración.'), confirmLabel: tr('Elegir carpeta'), placeholder: tr('Trabajo, personal…') });
    if (!label) return;
    const dir = await openDialog({ directory: true, title: tr('Carpeta de configuración de la cuenta') });
    if (!dir || Array.isArray(dir)) return;
    try {
      const r = await api.addAccount(agent, label, dir);
      setAccounts(r.accounts);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const remove = async (id: string, label: string) => {
    if (!(await confirmDialog({ title: tr('¿Quitar «{label}»?', { label }), body: tr('Solo se quita de la aplicación. La carpeta y su configuración no se borran.'), confirmLabel: tr('Quitar cuenta'), danger: true }))) return;
    const r = await api.removeAccount(id);
    setAccounts(r.accounts);
    if (active === id) choose(null);
  };

  const login = async () => {
    try {
      const r = await api.startLogin(agent);
      if (typeof r.authUrl === 'string') {
        await openUrl(r.authUrl);
        toast(tr('Completa el inicio de sesión de Codex en el navegador y pulsa «Comprobar».'));
      } else toast(tr('Se abrió una consola con «claude auth login». Complétalo allí y pulsa «Comprobar».'));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><Mascot agent={agent} state="idle" size={24} animated={false} />{AGENT_NAME[agent]}</span>}
      actions={
        <>
          <button className="btn" onClick={() => void load()}><RefreshCw size={13} /> {tr('Comprobar')}</button>
          <button className="btn" onClick={() => void login()}><ExternalLink size={13} /> {tr('Iniciar sesión')}</button>
        </>
      }
    >
      <AccountStatus agent={agent} status={status} />
      <div className="mt-1 flex flex-col gap-1 pb-2">
        <AccountOption label={tr('Configuración predeterminada del usuario')} sub={agent === 'codex' ? '%USERPROFILE%\\.codex' : '%USERPROFILE%\\.claude'} on={!active} onSelect={() => choose(null)} />
        {accounts.map((a) => (
          <AccountOption key={a.id} label={a.label} sub={a.configDir ?? ''} on={active === a.id} onSelect={() => choose(a.id)} onRemove={() => void remove(a.id, a.label)} />
        ))}
        <button className="btn mt-1 self-start" onClick={() => void add()}><Plus size={13} /> {tr('Añadir cuenta')}</button>
      </div>
    </Card>
  );
}

function AccountOption({ label, sub, on, onSelect, onRemove }: { label: string; sub: string; on: boolean; onSelect: () => void; onRemove?: () => void }) {
  return (
    <div className="account-option" data-on={on || undefined}>
      <button role="radio" aria-checked={on} className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onSelect}>
        <span className="radio" data-on={on || undefined} aria-hidden />
        <span className="min-w-0">
          <span className="block text-[13px]">{label}</span>
          <span className="block truncate font-mono text-[11px] faint">{sub}</span>
        </span>
      </button>
      {onRemove && (
        <button className="btn-icon" aria-label={tr('Quitar {name}', { name: label })} onClick={onRemove}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function AccountStatus({ agent, status }: { agent: AgentId; status: Record<string, unknown> | { error: string } | null }) {
  if (!status) return <p className="text-[13px] muted">{tr('Comprobando…')}</p>;
  if ('error' in status && typeof status.error === 'string') return <p className="selectable text-[13px]" style={{ color: 'var(--danger)' }}>{status.error}</p>;
  if (agent === 'codex') {
    const acc = (status as Record<string, unknown>).account as { type?: string; email?: string; planType?: string } | null;
    return (
      <Field label={acc ? (acc.type === 'chatgpt' ? `ChatGPT ${acc.email ?? ''}` : tr('Clave de API de OpenAI')) : tr('Sin sesión iniciada')} hint={acc?.planType ? tr('Plan informado por Codex: {plan}', { plan: acc.planType }) : 'Codex App Server · account/read'}>
        <Badge tone={acc ? 'ok' : 'warn'}>{acc ? tr('Conectada') : tr('Desconectada')}</Badge>
      </Field>
    );
  }
  const st = (status as Record<string, unknown>).status as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; subscriptionType?: string } | undefined;
  const method = st?.authMethod;
  const label = !st?.loggedIn ? tr('Sin sesión iniciada') : method === 'claude.ai' || method === 'oauth' ? tr('Suscripción de Claude (inicio de sesión de Claude Code)') : method?.toLowerCase().includes('api') ? tr('Clave de API de Anthropic (facturación por uso)') : tr('Método: {method}', { method });
  return (
    <Field label={label} hint={[st?.email, st?.subscriptionType, st?.apiProvider && st.apiProvider !== 'firstParty' ? tr('Proveedor {provider}', { provider: st.apiProvider }) : null].filter(Boolean).join('  ') || 'claude auth status'}>
      <Badge tone={st?.loggedIn ? 'ok' : 'warn'}>{st?.loggedIn ? tr('Conectada') : tr('Desconectada')}</Badge>
    </Field>
  );
}

// ---------- Uso y cuotas ----------

interface QuotaWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function windowLabel(mins: number | null) {
  if (!mins) return tr('Ventana');
  if (mins % 1440 === 0) return tr('Ventana de {n} días', { n: mins / 1440 });
  if (mins % 60 === 0) return tr('Ventana de {n} h', { n: mins / 60 });
  return tr('Ventana de {n} min', { n: mins });
}

const fmtPct = (n: number) => `${fmt.number(n, { maximumFractionDigits: 1 })} %`;

function QuotaBar({ w, label }: { w: QuotaWindow; label?: string }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const tone = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span>{label ?? windowLabel(w.windowDurationMins)}</span>
        <span className="tabular-nums" style={{ color: 'var(--text-strong)' }}>{tr('{pct} usado', { pct: fmtPct(pct) })} <span className="faint">· {tr('{pct} restante', { pct: fmtPct(100 - pct) })}</span></span>
      </div>
      <div className="quota-track mt-1.5">
        <motion.div className="quota-fill" style={{ background: tone }} initial={{ scaleX: 0 }} animate={{ scaleX: pct / 100 }} transition={{ type: 'spring', stiffness: 120, damping: 22 }} />
      </div>
      {w.resetsAt && <div className="mt-1 text-[12px] faint">{tr('Se renueva {date}', { date: fmt.dateTime(w.resetsAt * 1000, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</div>}
    </div>
  );
}

function Usage() {
  const [limits, setLimits] = useState<Record<string, unknown> | { error: string } | null>(null);
  useEffect(() => {
    api.codexRateLimits().then(setLimits, (e) => setLimits({ error: errorText(e) }));
  }, []);
  const snap = limits && !('error' in limits) ? (limits.rateLimits as { primary: QuotaWindow | null; secondary: QuotaWindow | null; planType?: string; credits?: { hasCredits: boolean; balance?: string } }) : null;
  return (
    <>
      <Card title={tr('Cuota de Codex')} actions={<Badge tone="ok">{tr('Dato oficial')}</Badge>}>
        <div className="py-1.5">
          {!limits && <p className="text-[13px] muted">{tr('Consultando a Codex App Server…')}</p>}
          {limits && 'error' in limits && <p className="selectable text-[13px]" style={{ color: 'var(--danger)' }}>{String(limits.error)}</p>}
          {snap && (
            <>
              {snap.primary && <QuotaBar w={snap.primary} />}
              {snap.secondary && <QuotaBar w={snap.secondary} />}
              {!snap.primary && !snap.secondary && <p className="text-[13px] muted">{tr('Codex no informa ventanas de uso para esta cuenta.')}</p>}
              <p className="mb-1 mt-1 text-[12px] faint">
                {tr('Fuente:')} account/rateLimits/read{snap.planType ? ', ' + tr('plan {plan}', { plan: snap.planType }) : ''}{snap.credits ? ', ' + tr('créditos {value}', { value: snap.credits.hasCredits ? (snap.credits.balance ?? tr('sí')) : tr('no') }) : ''}
              </p>
            </>
          )}
        </div>
      </Card>
      <ClaudeQuota />
    </>
  );
}

interface ClaudeWindow { usedPercent: number; resetsAt: number | null; status?: string | null }
interface ClaudeSnapshot { accountId: string | null; accountLabel: string | null; receivedAt: number; status?: string | null; windows: Record<string, ClaudeWindow> }
const CLAUDE_WINDOW: Record<string, { label: string; mins: number | null }> = {
  five_hour: { get label() { return tr('Ventana de 5 h'); }, mins: 300 },
  seven_day: { get label() { return tr('Ventana de 7 días'); }, mins: 10080 },
  seven_day_opus: { get label() { return tr('Ventana de 7 días · Opus'); }, mins: 10080 },
  seven_day_sonnet: { get label() { return tr('Ventana de 7 días · Sonnet'); }, mins: 10080 },
};

/**
 * Cuota de Claude Code a partir del evento oficial `rate_limit_event` de stream-json. Duovra no hace
 * consultas propias ni lee credenciales: muestra la última instantánea que entregó la CLI al
 * terminar un turno, para la cuenta en la que se ejecutó, y avisa si la ventana ya se renovó.
 */
function ClaudeQuota() {
  const stored = useStore((s) => s.settings['quota.claude']) as Record<string, ClaudeSnapshot> | undefined;
  const activeId = useStore((s) => s.settings['accounts.active.claude']) as string | null | undefined;
  const snapshot = stored?.[activeId ?? 'default'];
  const others = Object.entries(stored ?? {}).filter(([key]) => key !== (activeId ?? 'default')).map(([, value]) => value);
  const now = Date.now();
  const windows = snapshot ? Object.entries(snapshot.windows ?? {}) : [];
  const stale = windows.some(([, w]) => w.resetsAt != null && w.resetsAt * 1000 < now);
  return (
    <Card title={tr('Cuota de Claude Code')} actions={snapshot ? <Badge tone={stale ? 'warn' : 'ok'}>{stale ? tr('Desactualizado') : tr('Dato oficial')}</Badge> : <Badge tone="neutral">{tr('Sin datos todavía')}</Badge>}>
      <div className="py-1.5">
        {!snapshot ? (
          <p className="text-[13px] leading-relaxed muted">
            {tr('Claude Code comunica el uso de la suscripción al terminar cada respuesta. Aparecerá aquí después del primer turno con esta cuenta. Con una API key o un proveedor en la nube puede no comunicarse.')}
          </p>
        ) : <>
          {windows.map(([key, w]) => <QuotaBar key={key} w={{ usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowDurationMins: CLAUDE_WINDOW[key]?.mins ?? null }} label={CLAUDE_WINDOW[key]?.label} />)}
          {!windows.length && <p className="text-[13px] muted">{tr('El último evento no incluía porcentajes de uso (estado: {status}).', { status: snapshot.status ?? tr('desconocido') })}</p>}
          <p className="mb-1 mt-1 text-[12px] faint">
            {snapshot.accountLabel ?? tr('Configuración predeterminada de Claude Code')} · {tr('recibido {date}', { date: fmt.dateTime(snapshot.receivedAt, { dateStyle: 'short', timeStyle: 'short' }) })}
            {stale && ' · ' + tr('la ventana se renovó desde entonces; se actualizará con el próximo turno')}
          </p>
          <p className="mb-1 text-[12px] faint">{tr('Fuente:')} rate_limit_event (Claude Code, stream-json).</p>
        </>}
        {others.length > 0 && <p className="mb-1 text-[12px] faint">{others.length === 1 ? tr('También hay datos de otra cuenta; se muestran al activarla.') : tr('También hay datos de {n} otras cuentas; se muestran al activarlas.', { n: others.length })}</p>}
        <p className="mb-1 mt-2 text-[12px] leading-relaxed faint">{tr('El coste por mensaje del historial es la estimación que calcula la CLI a precios de API: con suscripción no corresponde a un cargo real.')}</p>
      </div>
    </Card>
  );
}

// ---------- Apariencia ----------

/** Claves de Apariencia: «Restablecer» las devuelve a sus valores predeterminados. */
export const APPEARANCE_KEYS = [
  'appearance.intensity', 'appearance.animations', 'appearance.background', 'appearance.backdrop', 'ui.contrast',
  'appearance.hue', 'ui.density', 'ui.textScale', 'ui.readingSize',
  'appearance.fieldIntensity', 'appearance.ambient', 'appearance.mascots',
];

const rgb255 = ([r, g, b]: readonly number[]) => `rgb(${r} ${g} ${b})`;
/** Muestra de cada matiz: sus tres tonos en un disco, como en la selección anterior. */
const hueSwatch = (id: HueId) => {
  const [strong, hue, deep] = [HUES[id].strong, HUES[id].hue, HUES[id].deep].map(rgb255);
  return `conic-gradient(from 210deg, ${strong}, ${hue}, ${deep}, ${strong})`;
};
const hueOptions = () => HUE_IDS.map((id) => ({ value: id, label: hueLabel(id), swatch: hueSwatch(id) }));

/**
 * Apariencia en cuatro grupos (Interfaz, Fondo, Mascotas y Movimiento) más el acento. Cada control
 * modifica algo real: variables CSS, el zoom del WebView, la configuración del campo de luz o las
 * animaciones de las mascotas. Se guardan en los ajustes de Duovra (SQLite), nunca en las
 * configuraciones de Claude Code o Codex.
 */
function Appearance({ effectiveIntensity, onPeek }: { effectiveIntensity: Intensity; onPeek: () => void }) {
  const [backgroundReset, setBackgroundReset] = useState(0);
  const [intensity, setIntensity] = useSetting<'auto' | 'reduced' | 'balanced' | 'full'>('appearance.intensity', 'auto');
  const [animations, setAnimations] = useSetting('appearance.animations', true);
  const legacyContrast = useStore((st) => !Object.hasOwn(st.settings, 'ui.contrast') && st.settings['glass.contrast'] === 'high' ? 'high' : 'normal');
  const [contrast, setContrast] = useSetting<'normal' | 'high'>('ui.contrast', legacyContrast);
  const [hue, setHue] = useSetting<HueId>('appearance.hue', DEFAULT_HUE);
  const [density, setDensity] = useSetting<'compact' | 'normal' | 'spacious'>('ui.density', 'normal');
  const [textScale, setTextScale] = useSetting('ui.textScale', 1);
  const [reading, setReading] = useSetting<ReadingSize>('ui.readingSize', 'normal');
  const [mascots, setMascots] = useSetting<MascotMotion>('appearance.mascots', 'full');
  const [language, setLanguage] = useSetting<LanguagePref>(LANGUAGE_KEY, 'system');
  const setSetting = useStore((s) => s.setSetting);
  const [zoomCap, setZoomCap] = useState(maxZoom);
  useEffect(() => {
    const r = () => setZoomCap(maxZoom());
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reset = async () => {
    if (!(await confirmDialog({ title: tr('¿Restablecer la apariencia?'), body: tr('Se recuperan los valores predeterminados de interfaz, fondo, mascotas, movimiento y acento. Se descartan los cambios pendientes del fondo y se conservan los presets personales.'), confirmLabel: 'Restablecer' }))) return;
    try {
      await saveBackgroundPreferences((current) => ({ ...current, active: DEFAULT_BACKGROUND }));
    } catch (error) {
      useStore.getState().toast(tr('No se pudo restablecer el fondo. {error}', { error: errorText(error) }), 'error');
      return;
    }
    for (const k of APPEARANCE_KEYS) await setSetting(k, null);
    setBackgroundReset((count) => count + 1);
  };
  return (
    <>
      <Header title={tr('Apariencia')} text={tr('Personaliza el fondo, la interfaz y el movimiento de Duovra.')} />
      <Card title={tr('Idioma')}>
        <Field label={tr('Idioma de la interfaz')} hint={tr('Se aplica al instante. Las respuestas de los agentes, el código y las rutas no se traducen.')}>
          <Segmented id="language" value={asLanguagePref(language)} onChange={(v) => setLanguage(v as LanguagePref)} options={[
            { value: 'system', label: tr('Idioma de Windows') },
            { value: 'es', label: 'Español' },
            { value: 'en', label: 'English' },
          ]} />
        </Field>
      </Card>

      <BackgroundSettings key={backgroundReset} intensity={effectiveIntensity} onPeek={onPeek} />

      <Card title={tr('Interfaz')}>
        <Field label={tr('Densidad')} hint={tr('Espacio entre mensajes, actividad, filas y listas.')}>
          <Segmented id="density" value={density} onChange={setDensity} options={[
            { value: 'compact', label: tr('Compacta') },
            { value: 'normal', label: tr('Normal') },
            { value: 'spacious', label: tr('Amplia') },
          ]} />
        </Field>
        <Field label={tr('Texto de la conversación')} hint={tr('Tamaño de lectura de los mensajes, las respuestas y el compositor.')}>
          <Segmented id="reading-size" value={reading} onChange={setReading} options={readingOptions()} />
        </Field>
        <Field label={tr('Escala de la interfaz')} hint={textScale > zoomCap + 0.001 ? tr('Limitada al {pct} % mientras la ventana sea tan pequeña.', { pct: Math.round(zoomCap * 100) }) : tr('Escala toda la ventana por igual.')}>
          <Segmented id="text-scale" value={String(textScale)} onChange={(v) => setTextScale(Number(v))} options={[
            { value: '0.9', label: '90 %' },
            { value: '1', label: '100 %' },
            { value: '1.1', label: '110 %' },
            { value: '1.2', label: '120 %' },
          ]} />
        </Field>
        <Field label={tr('Contraste alto')} hint={tr('Refuerza bordes y aclara los textos secundarios.')}>
          <Switch label={tr('Contraste alto')} checked={contrast === 'high'} onChange={(on) => setContrast(on ? 'high' : 'normal')} />
        </Field>
      </Card>

      <Card title={tr('Acento')}>
        <Field label={tr('Color de acento')} hint={tr('Iconos, selección, foco, compositor y luz de los fondos integrados. Las imágenes conservan sus colores.')}>
          <Select label={tr('Color de acento')} className="hue-select" value={hue} onChange={(v) => setHue(v as HueId)} options={hueOptions()} />
        </Field>
      </Card>

      <Card title={tr('Mascotas')}>
        <Field label={tr('Animaciones de las mascotas')} hint={tr('Claude Code y Codex reaccionan a lo que hace cada agente. Discretas mantiene los gestos y suprime el movimiento continuo.')}>
          <Segmented id="mascots" value={mascots} onChange={setMascots} options={[
            { value: 'full', label: tr('Completas') },
            { value: 'subtle', label: tr('Discretas') },
            { value: 'off', label: tr('Desactivadas') },
          ]} />
        </Field>
      </Card>

      <Card title={tr('Movimiento')}>
        <Field label={tr('Animaciones')} hint={reduced ? tr('Windows pide reducir el movimiento: Duovra lo respeta siempre y usa transiciones mínimas.') : tr('Desactivadas, Duovra usa transiciones mínimas, fondo quieto y mascotas en pose fija.')}>
          <Switch label={tr('Animaciones')} checked={animations} onChange={setAnimations} />
        </Field>
        <Field label={tr('Nivel de efectos')} hint={tr('Automático baja un nivel si el rendimiento medido cae de forma sostenida. Reducido equivale a la preferencia de movimiento reducido.')}>
          <Segmented id="intensity" value={intensity} onChange={setIntensity} options={[
            { value: 'auto', label: tr('Automático') },
            { value: 'reduced', label: tr('Reducido') },
            { value: 'balanced', label: tr('Equilibrado') },
            { value: 'full', label: tr('Completo') },
          ]} />
        </Field>
      </Card>
      <div className="settings-reset">
        <button className="btn" onClick={() => void reset()}><RotateCcw size={13} aria-hidden /> {tr('Restablecer valores predeterminados')}</button>
      </div>
    </>
  );
}

function Conversations() {
  const [enterSends, setEnterSends] = useSetting('composer.enterToSend', true);
  const [chatWidth, setChatWidth] = useSetting<'narrow' | 'normal' | 'wide'>('ui.chatWidth', 'normal');
  const [codeScale, setCodeScale] = useSetting('ui.codeScale', 1);
  const [startView, setStartView] = useSetting<'last' | 'projects'>('startup.view', 'last');
  const [restore, setRestore] = useSetting('startup.restoreConversation', true);
  const [worktreeDir, setWorktreeDir] = useSetting<string>('worktrees.location', '');
  return (
    <>
      <Header title={tr('Conversaciones')} text={tr('Cómo se abre Duovra, cómo escribes y cómo se presentan los mensajes. Los borradores se guardan solos en cada conversación.')} />
      <Card title={tr('Al abrir Duovra')}>
        <Field label={tr('Pantalla inicial')} hint={tr('Se aplica en el próximo inicio.')}>
          <Select label={tr('Pantalla inicial')} value={startView} onChange={(v) => setStartView(v as 'last' | 'projects')} options={[
            { value: 'last', label: tr('Última conversación') },
            { value: 'projects', label: tr('Proyectos y conversaciones') },
          ]} />
        </Field>
        <Field label={tr('Restaurar la última conversación')} hint={tr('Vuelve al proyecto y a la conversación que tenías abiertos. Desactivado, se abre el último proyecto sin seleccionar conversación.')}>
          <Switch label={tr('Restaurar la última conversación')} checked={restore} onChange={setRestore} />
        </Field>
      </Card>
      <Card title={tr('Escritura y lectura')}>
        <Field label={tr('Enviar mensajes con')} hint={enterSends ? tr('Enter envía y Mayús+Enter añade una línea.') : tr('Ctrl+Enter envía y Enter añade una línea.')}>
          <Segmented id="enter-send" value={enterSends ? 'enter' : 'ctrl'} onChange={(v) => setEnterSends(v === 'enter')} options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrl', label: 'Ctrl+Enter' },
          ]} />
        </Field>
        <Field label={tr('Anchura de la conversación')} hint={tr('Anchura máxima de la columna de mensajes y del compositor.')}>
          <Segmented id="chat-width" value={chatWidth} onChange={setChatWidth} options={[
            { value: 'narrow', label: tr('Estrecha') },
            { value: 'normal', label: tr('Normal') },
            { value: 'wide', label: tr('Amplia') },
          ]} />
        </Field>
        <Field label={tr('Tamaño del código')} hint={tr('Bloques de código y fragmentos dentro de las respuestas.')}>
          <Segmented id="code-scale" value={String(codeScale)} onChange={(v) => setCodeScale(Number(v))} options={[
            { value: '0.9', label: '90 %' },
            { value: '1', label: '100 %' },
            { value: '1.12', label: '112 %' },
            { value: '1.25', label: '125 %' },
          ]} />
        </Field>
      </Card>
      <Card title="Worktrees">
        <Field label={tr('Ubicación de los worktrees')} hint={worktreeDir
          ? tr('Los nuevos worktrees se crean en {dir} › <repositorio> › <nombre>. Siempre puedes cambiarla al crear uno.', { dir: worktreeDir })
          : tr('Junto a cada repositorio, en «<repositorio>.worktrees», fuera de su árbol de archivos. Siempre puedes cambiarla al crear uno.')}>
          <div className="flex flex-wrap gap-2">
            <button className="btn" onClick={async () => {
              const picked = await openDialog({ directory: true, multiple: false, title: tr('Carpeta para los worktrees') });
              if (picked && !Array.isArray(picked)) setWorktreeDir(picked);
            }}>{tr('Elegir carpeta…')}</button>
            {worktreeDir && <button className="btn" onClick={() => setWorktreeDir('')}>{tr('Junto al repositorio')}</button>}
          </div>
        </Field>
      </Card>
      <Fold title={tr('Atajos de teclado')}>
        <div className="kbd-list">
          {[...shortcuts(), [tr('Enviar mensaje'), enterSends ? 'Enter' : 'Ctrl+Enter'], [tr('Nueva línea'), enterSends ? tr('Mayús+Enter') : 'Enter']].map(([label, keys]) => (
            <div key={label}><span>{label}</span><span className="kbd">{keys}</span></div>
          ))}
        </div>
      </Fold>
    </>
  );
}

// ---------- Notificaciones y actualizaciones ----------

function Updates() {
  const [toast, setToast] = useSetting('notify.taskToast', true);
  const [attention, setAttention] = useSetting('notify.taskAttention', true);
  const [native, setNative] = useSetting('notify.native', true);
  return (
    <>
      <Header title={tr('Actualizaciones y avisos')} text={tr('Duovra se actualiza desde su canal firmado y te avisa cuando un agente termina mientras miras otra cosa.')} />
      <UpdateSettings />
      <Card title={tr('Avisos de tareas')}>
        <Field label={tr('Aviso al terminar una tarea')} hint={tr('Mensaje dentro de Duovra cuando un agente termina en una conversación que no estás viendo.')}>
          <Switch label={tr('Aviso al terminar una tarea')} checked={toast} onChange={setToast} />
        </Field>
        <Field label={tr('Resaltar en la barra de tareas')} hint={tr('Si Duovra está en segundo plano, su icono parpadea en la barra de tareas de Windows al terminar una tarea.')}>
          <Switch label={tr('Resaltar en la barra de tareas')} checked={attention} onChange={setAttention} />
        </Field>
        <Field label={tr('Notificaciones de Windows')} hint={tr('Aviso del sistema cuando un agente termina, falla o necesita tu autorización mientras miras otra conversación. Pulsarlo abre esa conversación. No incluye prompts ni respuestas, y Windows puede silenciarlas desde su configuración.')}>
          <Switch label={tr('Notificaciones de Windows')} checked={native} onChange={setNative} />
        </Field>
      </Card>
    </>
  );
}

// ---------- Datos y diagnóstico ----------

function DataSection() {
  const { info } = useDistribution();
  const detection = useStore((s) => s.detection);
  const toast = useStore((s) => s.toast);
  const [dataDir, setDataDir] = useState<string>();
  useEffect(() => {
    void import('@tauri-apps/api/path')
      .then(({ appDataDir }) => appDataDir())
      .then(setDataDir, () => setDataDir(undefined));
  }, []);
  const webview = /Edg\/([\d.]+)/.exec(navigator.userAgent)?.[1];
  const agents = (['claude', 'codex'] as AgentId[]).map((a) => {
    const d = detection?.find((x) => x.agent === a);
    return { agent: a, state: !detection ? tr('Comprobando') : d?.installed && d.version ? d.version : d?.installed ? tr('No responde') : tr('No encontrado'), ok: !!(d?.installed && d.version) };
  });
  const diagnostic = [
    `Duovra ${info?.version ?? '?'}`,
    `Sistema: ${info?.platform ?? '?'}`,
    `WebView2: ${webview ?? 'desconocido'}`,
    `Canal de actualización: ${info?.updaterEnabled ? 'configurado' : 'no configurado'}`,
    `Servicio de reportes: ${info?.reportingEnabled ? 'configurado' : 'no configurado'}`,
    ...agents.map((a) => `${AGENT_NAME[a.agent]}: ${a.state}`),
  ].join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic);
      toast(tr('Diagnóstico copiado. No incluye rutas, conversaciones ni credenciales.'));
    } catch {
      toast(tr('No se pudo copiar el diagnóstico.'), 'error');
    }
  };
  return (
    <>
      <Header title={tr('Datos y diagnóstico')} text={tr('Dónde guarda Duovra tus datos y la información técnica útil para resolver problemas. Nada de esto se envía automáticamente.')} />
      <Card title={tr('Datos')}>
        <Field label={tr('Ubicación de los datos')} hint={tr('Proyectos, conversaciones, borradores y ajustes (studio.sqlite3). Se conservan al actualizar o desinstalar, salvo que lo elijas en el desinstalador.')}>
          <span className="mono-path selectable" data-tip={dataDir} data-tip-truncated>{dataDir ?? '…'}</span>
          <button className="btn-icon" aria-label={tr('Mostrar en el Explorador')} data-tip={tr('Mostrar en el Explorador')} disabled={!dataDir} onClick={() => dataDir && void revealItemInDir(dataDir).catch((e) => toast(errorText(e), 'error'))}>
            <FolderOpen size={14} />
          </button>
        </Field>
      </Card>
      <BackupCard />
      <Card title={tr('Diagnóstico')} actions={<button className="btn" onClick={() => void copy()}><Copy size={13} /> {tr('Copiar diagnóstico')}</button>}>
        <Field label={tr('Versión instalada')}><span className="tabular-nums text-[13.5px]" style={{ color: 'var(--text-strong)' }}>{info?.version ?? '…'}</span></Field>
        <Field label={tr('Sistema')}><span className="text-[13px] muted">{info?.platform ?? '…'}</span></Field>
        <Field label="WebView2"><span className="tabular-nums text-[13px] muted">{webview ?? tr('Desconocido')}</span></Field>
        <Field label={tr('Servicio de reportes')} hint={info?.reportingEnabled ? undefined : tr('Esta compilación no incluye la dirección del servicio de envío.')}>
          <Badge tone={info?.reportingEnabled ? 'ok' : 'neutral'}>{info?.reportingEnabled ? tr('Configurado') : tr('No configurado')}</Badge>
        </Field>
        {agents.map((a) => (
          <Field key={a.agent} label={<span className="flex items-center gap-2"><Mascot agent={a.agent} state="idle" size={20} animated={false} />{AGENT_NAME[a.agent]}</span>}>
            <Badge tone={a.ok ? 'ok' : detection ? 'warn' : 'neutral'}>{a.state}</Badge>
          </Field>
        ))}
      </Card>
      <PerformanceCard />
      <Card title={tr('Documentación y licencia')}>
        <p className="settings-card-sub mt-2 text-[12.5px] faint">{tr('Duovra es software libre con licencia MIT. Claude Code y Codex son productos de sus respectivos proveedores y tienen sus propias condiciones.')}</p>
        <div className="link-row">
          <button className="btn" onClick={() => void openUrl(`${REPO}#readme`)}><ExternalLink size={13} /> {tr('Documentación')}</button>
          <button className="btn" onClick={() => void openUrl(`${REPO}/blob/main/CHANGELOG.md`)}><ExternalLink size={13} /> {tr('Historial de cambios')}</button>
          <button className="btn" onClick={() => void openUrl(`${REPO}/blob/main/LICENSE`)}><ExternalLink size={13} /> {tr('Licencia MIT')}</button>
          <button className="btn" onClick={() => void openUrl(REPO)}><ExternalLink size={13} /> {tr('Código fuente')}</button>
        </div>
      </Card>
    </>
  );
}


/**
 * Copias de seguridad de los datos personales. La restauración se valida antes de cambiar nada,
 * requiere confirmación y se aplica al reiniciar Duovra (con una copia previa del estado actual).
 */
function BackupCard() {
  const toast = useStore((s) => s.toast);
  const flushDrafts = useStore((s) => s.flushDrafts);
  const [busy, setBusy] = useState<'create' | 'restore' | null>(null);
  const create = async () => {
    setBusy('create');
    try {
      await flushDrafts();
      const path = await api.backupCreate();
      if (path) toast(tr('Copia de seguridad guardada como «{file}».', { file: path.split(/[\/]/).pop() }));
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };
  const restore = async () => {
    setBusy('restore');
    try {
      await flushDrafts();
      const summary = await api.backupPickRestore();
      if (!summary) return;
      const confirmed = await confirmDialog({
        title: tr('¿Restaurar esta copia de seguridad?'),
        body: restoreConfirmBody(summary),
        confirmLabel: tr('Restaurar y reiniciar'),
        danger: true,
      });
      if (confirmed) await api.backupConfirmRestore();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={tr('Copias de seguridad')}>
      <Field label={tr('Crear copia')} hint={tr('Guarda en un archivo .duovra tus proyectos, conversaciones, mensajes, borradores, preferencias y fondos personalizados. No incluye las carpetas de código ni las credenciales de Claude Code y Codex.')}>
        <button className="btn" disabled={busy !== null} onClick={() => void create()}><Download size={13} /> {tr('Crear copia de seguridad…')}</button>
      </Field>
      <Field label={tr('Restaurar copia')} hint={tr('Valida el archivo y muestra su contenido antes de cambiar nada. Duovra guarda antes el estado actual y se reinicia para aplicar la copia.')}>
        <button className="btn" disabled={busy !== null} onClick={() => void restore()}><RotateCcw size={13} /> {tr('Restaurar copia…')}</button>
      </Field>
    </Card>
  );
}

function PerformanceCard() {
  const [fps, setFps] = useState(perfState.lastFps);
  useEffect(() => {
    const t = setInterval(() => setFps(perfState.lastFps), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card title={tr('Rendimiento medido')}>
      <Field label={tr('Fotogramas por segundo')} hint={tr('Muestra de 2 s tomada periódicamente en esta ventana (WebView2).')}>
        <span className="tabular-nums text-[14px]" style={{ color: 'var(--text-strong)' }}>{fps ? `${fps} fps` : 'Midiendo…'}</span>
      </Field>
      <Field label={tr('Nivel automático actual')} hint={tr('Se usa con la intensidad visual en «Automática».')}>
        <span className="text-[13px] muted">{{ reduced: 'Reducida', balanced: 'Equilibrada', full: 'Completa' }[perfState.autoLevel]}</span>
      </Field>
    </Card>
  );
}

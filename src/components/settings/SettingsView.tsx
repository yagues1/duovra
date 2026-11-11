import { AnimatePresence, motion } from 'motion/react';
import { Bot, Boxes, Check, Gauge, KeyRound, Palette, RefreshCw, SlidersHorizontal, Trash2, Plus, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { catalogModels, useStore, type SettingsSection } from '../../state/store';
import { api, errorText } from '../../lib/ipc';
import type { AgentId, UsageRow } from '../../lib/types';
import { AGENT_NAME, effortLabel, fmtTokens } from '../../lib/format';
import { Badge, Card, Field, Segmented, Select, Switch } from '../ui/Controls';
import { AgentGlyph } from '../ui/AgentGlyph';
import { perfState } from '../../hooks/useAppearance';
import { promptDialog, confirmDialog } from '../ui/Dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { normalizeCatalog } from '../../lib/catalog';
import { UpdateSettings } from '../distribution/Distribution';

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={15} /> },
  { id: 'agents', label: 'Agentes', icon: <Bot size={15} /> },
  { id: 'models', label: 'Modelos', icon: <Boxes size={15} /> },
  { id: 'accounts', label: 'Cuentas', icon: <KeyRound size={15} /> },
  { id: 'usage', label: 'Uso y cuotas', icon: <Gauge size={15} /> },
  { id: 'appearance', label: 'Apariencia', icon: <Palette size={15} /> },
];

export function SettingsView() {
  const section = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const pulse = useStore((s) => s.savedPulse);
  return (
    <section className="settings-view" aria-label="Ajustes">
      <div className="settings-layout">
      <nav className="settings-nav-col mat-primary" aria-label="Secciones de ajustes">
        <h1 className="m-0 px-2.5 pb-3 text-[18px] font-semibold" style={{ color: 'var(--text-strong)' }}>
          Ajustes
        </h1>
        {SECTIONS.map((s) => (
          <button key={s.id} className="settings-nav" data-on={section === s.id || undefined} onClick={() => setView('settings', s.id)}>
            {section === s.id && <motion.span layoutId="settings-nav-pill" className="settings-nav-pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className="relative flex items-center gap-2.5">
              {s.icon}
              {s.label}
            </span>
          </button>
        ))}
        <div className="flex-1" />
        <SavedIndicator pulse={pulse} />
      </nav>
      {/* El cristal (::before/::after) vive en el contenedor fijo; el desplazamiento, en un hijo:
          así el borde y el reflejo no se mueven con el contenido ni este asoma bajo el panel. */}
      <div className="settings-body mat-primary">
        <div className="settings-scroll">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            className="settings-content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
          >
            <ErrorBoundary area={SECTIONS.find((x) => x.id === section)?.label ?? 'esta sección'} resetKey={section} compact>
              {section === 'general' && <General />}
              {section === 'agents' && <Agents />}
              {section === 'models' && <Models />}
              {section === 'accounts' && <Accounts />}
              {section === 'usage' && <Usage />}
              {section === 'appearance' && <Appearance />}
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
        </div>
      </div>
      </div>
    </section>
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
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
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

// ---------- General ----------

function General() {
  const [agent, setAgent] = useSetting<AgentId>('defaults.agent', 'codex');
  return (
    <>
      <Header title="General" text="Preferencias para las conversaciones nuevas. Cada conversación recuerda después su propio agente, modelo y nivel de razonamiento." />
      <Card>
        <Field label="Agente para conversaciones nuevas" hint="Siempre puedes cambiarlo en el cuadro de escritura, mensaje a mensaje.">
          <Segmented id="def-agent" value={agent} onChange={setAgent} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
        </Field>
        <DefaultModel agent="claude" />
        <DefaultModel agent="codex" />
      </Card>
      <Card title="Al abrir la aplicación">
        <Field label="Restaurar el último proyecto y conversación" hint="También se restauran los borradores de cada conversación. Siempre activo.">
          <Badge tone="ok">Activo</Badge>
        </Field>
      </Card>
      <UpdateSettings />
    </>
  );
}

function DefaultModel({ agent }: { agent: AgentId }) {
  const catalog = useStore((s) => s.catalogs[agent]);
  const models = catalogModels(catalog);
  const [model, setModel] = useSetting<string>(`defaults.model.${agent}`, '');
  const [effort, setEffort] = useSetting<string>(`defaults.effort.${agent}`, '');
  const current = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0];
  return (
    <Field label={`Modelo predeterminado de ${AGENT_NAME[agent]}`} hint={models.length ? undefined : 'Sin catálogo de modelos disponible todavía.'}>
      <Select
        label={`Modelo de ${AGENT_NAME[agent]}`}
        value={model}
        onChange={setModel}
        options={[{ value: '', label: 'El recomendado por el agente' }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
      />
      {current && (current.efforts?.length ?? 0) > 0 && (
        <Select
          label="Razonamiento"
          value={effort}
          onChange={setEffort}
          options={[{ value: '', label: 'Predeterminado' }, ...current.efforts.map((e) => ({ value: e, label: effortLabel(e) }))]}
        />
      )}
    </Field>
  );
}

function Header({ title, text }: { title: string; text?: string }) {
  return (
    <div className="pb-1">
      <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-strong)' }}>
        {title}
      </h2>
      {text && <p className="mb-0 mt-1.5 max-w-[620px] text-[13.5px] leading-relaxed muted">{text}</p>}
    </div>
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
  return (
    <>
      <Header title="Agentes" text="Duovra usa las CLIs oficiales instaladas en este equipo, con su propia configuración. No guarda ni reutiliza credenciales." />
      <Card
        title="Instalaciones detectadas"
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
        <Field label="Aprobaciones" hint="Cuándo pide Codex permiso antes de ejecutar comandos o salir del sandbox.">
          <Select label="Política de aprobación" value={approval} onChange={setApproval} options={[
            { value: 'untrusted', label: 'Pedir para todo lo no confiable' },
            { value: 'on-request', label: 'Cuando el modelo lo pida' },
            { value: 'never', label: 'Nunca preguntar' },
          ]} />
        </Field>
        <Field label="Sandbox" hint="Acceso de Codex al sistema de archivos durante los turnos.">
          <Select label="Sandbox" value={sandbox} onChange={setSandbox} options={[
            { value: 'read-only', label: 'Solo lectura' },
            { value: 'workspace-write', label: 'Escritura en el proyecto' },
            { value: 'danger-full-access', label: 'Acceso completo (peligroso)' },
          ]} />
        </Field>
      </Card>
      <Card title="Claude Code">
        <Field label="Modo de permisos" hint="Con «Manual», cada herramienta que lo requiera se aprueba desde la conversación.">
          <Select label="Modo de permisos" value={perm} onChange={setPerm} options={[
            { value: 'manual', label: 'Manual (preguntar)' },
            { value: 'acceptEdits', label: 'Aceptar ediciones' },
            { value: 'plan', label: 'Solo planificar' },
            { value: 'auto', label: 'Automático de Claude Code' },
            { value: 'dontAsk', label: 'No preguntar (denegar lo no permitido)' },
            { value: 'bypassPermissions', label: 'Omitir permisos (peligroso)' },
          ]} />
        </Field>
      </Card>
    </>
  );
}

function AgentPath({ agent, detected, version, installed }: { agent: AgentId; detected: string | null; version: string | null; installed?: boolean }) {
  const [custom, setCustom] = useSetting<string>(`agents.${agent}.path`, '');
  const [draft, setDraft] = useState(custom);
  return (
    <div className="setting-row items-start">
      <AgentGlyph agent={agent} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px]">
          {AGENT_NAME[agent]}
          {installed === undefined ? <Badge tone="neutral">Comprobando</Badge> : installed && version ? <Badge tone="ok">{version}</Badge> : installed ? <Badge tone="warn">No responde</Badge> : <Badge tone="error">No encontrado</Badge>}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11.5px] faint" data-tip={detected ?? ''} data-tip-truncated>
          {detected ?? 'No está en el PATH ni en las rutas habituales.'}
        </div>
        <div className="mt-2 flex gap-2">
          <input className="input" placeholder="Ruta personalizada del ejecutable (opcional)" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" disabled={draft === custom} onClick={() => { setCustom(draft.trim()); void useStore.getState().refreshDetection(); void useStore.getState().refreshCatalog(agent, true); }}>
            Aplicar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Modelos ----------

function Models() {
  return (
    <>
      <Header title="Modelos" text="Modelos que cada agente informa para la cuenta activa. Que un modelo aparezca aquí no garantiza que tu plan pueda usarlo: si el proveedor lo rechaza, verás el error en la conversación." />
      {(['claude', 'codex'] as AgentId[]).map((a) => (
        <ErrorBoundary key={a} area={`los modelos de ${AGENT_NAME[a]}`} compact>
          <AgentModels agent={a} />
        </ErrorBoundary>
      ))}
    </>
  );
}

function AgentModels({ agent }: { agent: AgentId }) {
  const raw = useStore((s) => s.catalogs[agent]);
  const refresh = useStore((s) => s.refreshCatalog);
  // Defensa adicional: aunque el almacén ya normaliza, la vista no confía en la forma de los datos.
  const c = useMemo(() => (raw && raw !== 'loading' ? normalizeCatalog(raw) : raw), [raw]);
  const loading = c === 'loading' || !c;
  return (
    <Card
      title={<span className="flex items-center gap-2"><AgentGlyph agent={agent} size={22} />{AGENT_NAME[agent]}</span>}
      actions={
        <button className="btn" disabled={loading} onClick={() => void refresh(agent, true)}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Actualizar
        </button>
      }
    >
      {loading ? (
        <p className="py-2 text-[13px] muted">Consultando a {AGENT_NAME[agent]}…</p>
      ) : 'error' in c ? (
        <div className="py-2">
          <p className="m-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>No se pudo obtener el catálogo de {AGENT_NAME[agent]}.</p>
          <p className="selectable mb-0 mt-1 text-[12.5px]" style={{ color: 'var(--danger)' }}>{c.error}</p>
        </div>
      ) : c.models.length === 0 ? (
        <p className="py-2 text-[13px] muted">{AGENT_NAME[agent]} no ha informado ningún modelo para esta cuenta. Pulsa «Actualizar» para volver a consultarlo.</p>
      ) : (
        <>
          {c.models.map((m) => (
            <div key={m.id} className="setting-row model-row">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px]" style={{ color: 'var(--text-primary)' }}>
                  {m.label}
                  {m.isDefault && <Badge tone="ok">Predeterminado</Badge>}
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
                  <span className="text-[12px] faint">Sin niveles de razonamiento informados</span>
                )}
              </div>
            </div>
          ))}
          <p className="mb-2 mt-2 text-[12px] faint">
            Fuente: {c.source}{c.version ? ` (versión ${c.version})` : ''}
            {c.skipped ? ` · ${c.skipped} entradas sin identificador válido o duplicadas omitidas` : ''}
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
      <Header title="Cuentas" text="Cada cuenta es un directorio de configuración de la CLI (CODEX_HOME para Codex, CLAUDE_CONFIG_DIR para Claude Code). El inicio de sesión lo hace siempre la CLI oficial; la aplicación no ve ni almacena tokens." />
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
    const label = await promptDialog({ title: `Nueva cuenta de ${AGENT_NAME[agent]}`, body: 'Ponle un nombre y elige después una carpeta vacía donde la CLI guardará su configuración.', confirmLabel: 'Elegir carpeta', placeholder: 'Trabajo, personal…' });
    if (!label) return;
    const dir = await openDialog({ directory: true, title: 'Carpeta de configuración de la cuenta' });
    if (!dir || Array.isArray(dir)) return;
    try {
      const r = await api.addAccount(agent, label, dir);
      setAccounts(r.accounts);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const remove = async (id: string, label: string) => {
    if (!(await confirmDialog({ title: `¿Quitar «${label}»?`, body: 'Solo se quita de la aplicación. La carpeta y su configuración no se borran.', confirmLabel: 'Quitar cuenta', danger: true }))) return;
    const r = await api.removeAccount(id);
    setAccounts(r.accounts);
    if (active === id) choose(null);
  };

  const login = async () => {
    try {
      const r = await api.startLogin(agent);
      if (typeof r.authUrl === 'string') {
        await openUrl(r.authUrl);
        toast('Completa el inicio de sesión de Codex en el navegador y pulsa «Comprobar».');
      } else toast('Se abrió una consola con «claude auth login». Complétalo allí y pulsa «Comprobar».');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><AgentGlyph agent={agent} size={22} />{AGENT_NAME[agent]}</span>}
      actions={
        <>
          <button className="btn" onClick={() => void load()}><RefreshCw size={13} /> Comprobar</button>
          <button className="btn" onClick={() => void login()}><ExternalLink size={13} /> Iniciar sesión</button>
        </>
      }
    >
      <AccountStatus agent={agent} status={status} />
      <div className="mt-1 flex flex-col gap-1 pb-2">
        <AccountOption label="Configuración predeterminada del usuario" sub={agent === 'codex' ? '%USERPROFILE%\\.codex' : '%USERPROFILE%\\.claude'} on={!active} onSelect={() => choose(null)} />
        {accounts.map((a) => (
          <AccountOption key={a.id} label={a.label} sub={a.configDir ?? ''} on={active === a.id} onSelect={() => choose(a.id)} onRemove={() => void remove(a.id, a.label)} />
        ))}
        <button className="btn mt-1 self-start" onClick={() => void add()}><Plus size={13} /> Añadir cuenta</button>
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
        <button className="btn-icon" aria-label={`Quitar ${label}`} onClick={onRemove}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function AccountStatus({ agent, status }: { agent: AgentId; status: Record<string, unknown> | { error: string } | null }) {
  if (!status) return <p className="text-[13px] muted">Comprobando…</p>;
  if ('error' in status && typeof status.error === 'string') return <p className="selectable text-[13px]" style={{ color: 'var(--danger)' }}>{status.error}</p>;
  if (agent === 'codex') {
    const acc = (status as Record<string, unknown>).account as { type?: string; email?: string; planType?: string } | null;
    return (
      <Field label={acc ? (acc.type === 'chatgpt' ? `ChatGPT ${acc.email ?? ''}` : 'Clave de API de OpenAI') : 'Sin sesión iniciada'} hint={acc?.planType ? `Plan informado por Codex: ${acc.planType}` : 'Codex App Server · account/read'}>
        <Badge tone={acc ? 'ok' : 'warn'}>{acc ? 'Conectada' : 'Desconectada'}</Badge>
      </Field>
    );
  }
  const st = (status as Record<string, unknown>).status as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; subscriptionType?: string } | undefined;
  const method = st?.authMethod;
  const label = !st?.loggedIn ? 'Sin sesión iniciada' : method === 'claude.ai' || method === 'oauth' ? 'Suscripción de Claude (inicio de sesión de Claude Code)' : method?.toLowerCase().includes('api') ? 'Clave de API de Anthropic (facturación por uso)' : `Método: ${method}`;
  return (
    <Field label={label} hint={[st?.email, st?.subscriptionType, st?.apiProvider && st.apiProvider !== 'firstParty' ? `Proveedor ${st.apiProvider}` : null].filter(Boolean).join('  ') || 'claude auth status'}>
      <Badge tone={st?.loggedIn ? 'ok' : 'warn'}>{st?.loggedIn ? 'Conectada' : 'Desconectada'}</Badge>
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
  if (!mins) return 'Ventana';
  if (mins % 10080 === 0) return `Ventana de ${mins / 10080 === 1 ? '7 días' : `${(mins / 10080) * 7} días`}`;
  if (mins % 1440 === 0) return `Ventana de ${mins / 1440} días`;
  if (mins % 60 === 0) return `Ventana de ${mins / 60} h`;
  return `Ventana de ${mins} min`;
}

function QuotaBar({ w }: { w: QuotaWindow }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const tone = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--accent)';
  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span>{windowLabel(w.windowDurationMins)}</span>
        <span className="tabular-nums" style={{ color: 'var(--text-strong)' }}>{pct}% usado</span>
      </div>
      <div className="quota-track mt-1.5">
        <motion.div className="quota-fill" style={{ background: tone }} initial={{ scaleX: 0 }} animate={{ scaleX: pct / 100 }} transition={{ type: 'spring', stiffness: 120, damping: 22 }} />
      </div>
      {w.resetsAt && <div className="mt-1 text-[12px] faint">Se renueva {new Date(w.resetsAt * 1000).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
    </div>
  );
}

function Usage() {
  const [limits, setLimits] = useState<Record<string, unknown> | { error: string } | null>(null);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  useEffect(() => {
    api.codexRateLimits().then(setLimits, (e) => setLimits({ error: errorText(e) }));
  }, []);
  useEffect(() => {
    api.usageSummary(Number(days)).then((r) => setRows(r.rows), () => setRows([]));
  }, [days]);
  const snap = limits && !('error' in limits) ? (limits.rateLimits as { primary: QuotaWindow | null; secondary: QuotaWindow | null; planType?: string; credits?: { hasCredits: boolean; balance?: string } }) : null;
  return (
    <>
      <Header title="Uso y cuotas" text="Se distinguen tres tipos de dato: oficiales (informados por el proveedor), estimaciones (calculadas por la CLI) y no disponibles." />
      <Card title="Codex" actions={<Badge tone="ok">Dato oficial</Badge>}>
        {!limits && <p className="text-[13px] muted">Consultando a Codex App Server…</p>}
        {limits && 'error' in limits && <p className="selectable text-[13px]" style={{ color: 'var(--danger)' }}>{String(limits.error)}</p>}
        {snap && (
          <>
            {snap.primary && <QuotaBar w={snap.primary} />}
            {snap.secondary && <QuotaBar w={snap.secondary} />}
            {!snap.primary && !snap.secondary && <p className="text-[13px] muted">Codex no informa ventanas de uso para esta cuenta.</p>}
            <p className="mb-2 mt-1 text-[12px] faint">
              Fuente: account/rateLimits/read{snap.planType ? `, plan ${snap.planType}` : ''}{snap.credits ? `, créditos ${snap.credits.hasCredits ? (snap.credits.balance ?? 'sí') : 'no'}` : ''}
            </p>
          </>
        )}
      </Card>
      <Card title="Claude Code" actions={<Badge tone="neutral">No disponible</Badge>}>
        <p className="text-[13px] leading-relaxed muted">
          El modo no interactivo de Claude Code no expone los límites ni el porcentaje consumido de la suscripción, así que no se muestran. El coste por mensaje que aparece en el historial es la estimación que calcula la propia CLI a precios de API: con suscripción no corresponde a un cargo real.
        </p>
      </Card>
      <Card title="Registro local" actions={<Segmented id="usage-days" value={days} onChange={setDays} options={[{ value: '7', label: '7 días' }, { value: '30', label: '30 días' }, { value: '90', label: '90 días' }]} />}>
        <p className="mb-2 mt-1 text-[12.5px] faint">Tokens informados por cada agente al terminar cada mensaje enviado desde esta aplicación.</p>
        {rows && rows.length === 0 && <p className="text-[13px] muted">Todavía no hay mensajes en este periodo.</p>}
        {rows && rows.length > 0 && (
          <div className="table-scroll"><table className="usage-table">
            <thead>
              <tr><th>Agente y modelo</th><th>Mensajes</th><th>Entrada</th><th>En caché</th><th>Salida</th><th>Coste</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agent + r.model}>
                  <td><span className="flex items-center gap-2"><AgentGlyph agent={r.agent} size={18} /><span className="sr-only">{AGENT_NAME[r.agent]}</span>{r.model}</span></td>
                  <td>{r.runs}</td>
                  <td>{fmtTokens(r.inputTokens)}</td>
                  <td>{fmtTokens(r.cachedInputTokens)}</td>
                  <td>{fmtTokens(r.outputTokens)}</td>
                  <td>{r.costUsd != null ? `≈ ${r.costUsd.toFixed(2)} USD` : '—'}{r.costUsd != null && <span className="faint"> est.</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

// ---------- Apariencia ----------

function Appearance() {
  const [intensity, setIntensity] = useSetting<'auto' | 'reduced' | 'balanced' | 'full'>('appearance.intensity', 'auto');
  const [animations, setAnimations] = useSetting('appearance.animations', true);
  const [background, setBackground] = useSetting('appearance.background', true);
  const [glow, setGlow] = useSetting('appearance.cursorGlow', true);
  const [fps, setFps] = useState(perfState.lastFps);
  useEffect(() => {
    const t = setInterval(() => setFps(perfState.lastFps), 2000);
    return () => clearInterval(t);
  }, []);
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <>
      <Header title="Apariencia" text="Regula la intensidad del cristal y del movimiento. La preferencia de Windows de reducir animaciones siempre se respeta." />
      <Card>
        <Field label="Intensidad visual" hint="Automática parte de «Equilibrada» y baja un nivel si el rendimiento medido cae de forma sostenida.">
          <Segmented id="intensity" value={intensity} onChange={setIntensity} options={[
            { value: 'auto', label: 'Automática' },
            { value: 'reduced', label: 'Reducida' },
            { value: 'balanced', label: 'Equilibrada' },
            { value: 'full', label: 'Completa' },
          ]} />
        </Field>
        <Field label="Animaciones" hint={reduced ? 'Windows tiene activada la reducción de animaciones: se usan transiciones de opacidad.' : 'Transiciones elásticas, morphing y estados animados.'}>
          <Switch label="Animaciones" checked={animations} onChange={setAnimations} />
        </Field>
        <Field label="Fondo animado" hint="Aurora en movimiento lento detrás del cristal. Desactivado, se muestra estática. Se detiene con la ventana oculta.">
          <Switch label="Fondo animado" checked={background} onChange={setBackground} />
        </Field>
        <Field label="Reflejo que sigue al cursor" hint="Brillo suave sobre el cuadro de escritura.">
          <Switch label="Reflejo que sigue al cursor" checked={glow} onChange={setGlow} />
        </Field>
      </Card>
      <Card title="Rendimiento medido">
        <Field label="Fotogramas por segundo" hint="Muestra de 2 s tomada periódicamente en esta ventana (WebView2).">
          <span className="tabular-nums text-[14px]" style={{ color: 'var(--text-strong)' }}>{fps ? `${fps} fps` : 'Midiendo…'}</span>
        </Field>
        <Field label="Nivel automático actual">
          <span className="text-[13px] muted">{{ reduced: 'Reducida', balanced: 'Equilibrada', full: 'Completa' }[perfState.autoLevel]}</span>
        </Field>
      </Card>
    </>
  );
}

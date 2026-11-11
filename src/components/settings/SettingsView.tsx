import { AnimatePresence, motion } from 'motion/react';
import {
  BellRing,
  Bot,
  Boxes,
  Check,
  Copy,
  Database,
  ExternalLink,
  FolderOpen,
  Gauge,
  KeyRound,
  MessagesSquare,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { catalogModels, useStore, type SettingsSection } from '../../state/store';
import { api, errorText } from '../../lib/ipc';
import type { AgentId, UsageRow } from '../../lib/types';
import { AGENT_NAME, effortLabel, fmtTokens } from '../../lib/format';
import { Badge, Card, Field, Segmented, Select, Slider, Swatches, Switch } from '../ui/Controls';
import { AgentGlyph } from '../ui/AgentGlyph';
import { perfState } from '../../hooks/useAppearance';
import { maxZoom } from '../../hooks/usePreferences';
import { promptDialog, confirmDialog } from '../ui/Dialog';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { normalizeCatalog } from '../../lib/catalog';
import { AURORA_PALETTES, type AuroraPalette } from '../../lib/aurora';
import { UpdateSettings, useDistribution } from '../distribution/Distribution';

const REPO = 'https://github.com/yagues1/duovra';

const SECTIONS: { id: SettingsSection; label: string; group: string; icon: (size: number) => ReactNode }[] = [
  { id: 'general', label: 'General', group: 'Duovra', icon: (n) => <SlidersHorizontal size={n} /> },
  { id: 'appearance', label: 'Apariencia', group: 'Duovra', icon: (n) => <Palette size={n} /> },
  { id: 'conversations', label: 'Conversaciones', group: 'Duovra', icon: (n) => <MessagesSquare size={n} /> },
  { id: 'agents', label: 'Agentes', group: 'Agentes y modelos', icon: (n) => <Bot size={n} /> },
  { id: 'models', label: 'Modelos', group: 'Agentes y modelos', icon: (n) => <Boxes size={n} /> },
  { id: 'accounts', label: 'Cuentas', group: 'Agentes y modelos', icon: (n) => <KeyRound size={n} /> },
  { id: 'usage', label: 'Uso y cuotas', group: 'Agentes y modelos', icon: (n) => <Gauge size={n} /> },
  { id: 'updates', label: 'Avisos y actualizaciones', group: 'Sistema', icon: (n) => <BellRing size={n} /> },
  { id: 'data', label: 'Datos y diagnóstico', group: 'Sistema', icon: (n) => <Database size={n} /> },
];

/**
 * Ajustes en tres zonas: la barra principal de Duovra se reduce a un riel de iconos (useLayout),
 * esta columna de categorías y el contenido con desplazamiento propio. En ventanas estrechas la
 * columna pasa a ser una cinta horizontal desplazable (components.css, @container).
 */
export function SettingsView() {
  const section = useStore((s) => s.settingsSection);
  const setView = useStore((s) => s.setView);
  const pulse = useStore((s) => s.savedPulse);
  let lastGroup = '';
  return (
    <section className="settings-view" aria-label="Ajustes">
      <div className="settings-layout">
        <nav className="settings-nav-col mat-primary" aria-label="Secciones de ajustes">
          <h1 className="settings-nav-title">Ajustes</h1>
          {SECTIONS.map((s) => {
            const group = s.group !== lastGroup ? s.group : null;
            lastGroup = s.group;
            return (
              <div key={s.id} className="contents">
                {group && <p className="settings-nav-group" aria-hidden>{group}</p>}
                <button className="settings-nav" data-on={section === s.id || undefined} aria-current={section === s.id ? 'page' : undefined} onClick={() => setView('settings', s.id)}>
                  {section === s.id && <motion.span layoutId="settings-nav-pill" className="settings-nav-pill" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
                  <span className="relative flex min-w-0 items-center gap-2.5">
                    <span className="settings-nav-icon">{s.icon(15)}</span>
                    <span className="truncate">{s.label}</span>
                  </span>
                </button>
              </div>
            );
          })}
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
                  {section === 'appearance' && <Appearance />}
                  {section === 'conversations' && <Conversations />}
                  {section === 'agents' && <Agents />}
                  {section === 'models' && <Models />}
                  {section === 'accounts' && <Accounts />}
                  {section === 'usage' && <Usage />}
                  {section === 'updates' && <Updates />}
                  {section === 'data' && <DataSection />}
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

/** Vista previa sin escribir en disco: actualiza el estado en memoria mientras se arrastra. */
function previewSetting(key: string) {
  return (value: unknown) => useStore.setState((s) => ({ settings: { ...s.settings, [key]: value } }));
}

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

const SHORTCUTS: [string, string][] = [
  ['Nueva conversación', 'Ctrl+N'],
  ['Abrir Ajustes', 'Ctrl+,'],
  ['Mostrar u ocultar la barra lateral', 'Ctrl+B'],
  ['Cerrar panel o capa', 'Esc'],
];

function General() {
  const [agent, setAgent] = useSetting<AgentId>('defaults.agent', 'codex');
  const [startView, setStartView] = useSetting<'last' | 'projects'>('startup.view', 'last');
  const [restore, setRestore] = useSetting('startup.restoreConversation', true);
  const setView = useStore((s) => s.setView);
  return (
    <>
      <Header title="General" text="Cómo se abre Duovra y con qué agente empiezan las conversaciones nuevas. Cada conversación recuerda después su propio agente, modelo y razonamiento." />
      <Card title="Al abrir Duovra">
        <Field label="Pantalla inicial" hint="Se aplica en el próximo inicio.">
          <Select label="Pantalla inicial" value={startView} onChange={(v) => setStartView(v as 'last' | 'projects')} options={[
            { value: 'last', label: 'Última conversación' },
            { value: 'projects', label: 'Proyectos y conversaciones' },
          ]} />
        </Field>
        <Field label="Restaurar la última conversación" hint="Vuelve al proyecto y a la conversación que tenías abiertos. Desactivado, se abre el último proyecto sin seleccionar conversación.">
          <Switch label="Restaurar la última conversación" checked={restore} onChange={setRestore} />
        </Field>
      </Card>
      <Card title="Agente predeterminado">
        <Field label="Agente para conversaciones nuevas" hint="Siempre puedes cambiarlo en el cuadro de escritura, mensaje a mensaje.">
          <Segmented id="def-agent" value={agent} onChange={setAgent} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
        </Field>
        <Field label="Modelos y razonamiento predeterminados" hint="Se eligen por proveedor en la sección Modelos.">
          <button className="btn" onClick={() => setView('settings', 'models')}>Abrir Modelos</button>
        </Field>
      </Card>
      <Card title="Accesos rápidos">
        <div className="kbd-list">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label}><span>{label}</span><span className="kbd">{keys}</span></div>
          ))}
        </div>
        <div className="link-row">
          <button className="btn" onClick={() => setView('projects')}><FolderOpen size={13} /> Proyectos y conversaciones</button>
          <button className="btn" onClick={() => setView('settings', 'appearance')}><Palette size={13} /> Apariencia</button>
          <button className="btn" onClick={() => setView('settings', 'updates')}><RefreshCw size={13} /> Buscar actualizaciones</button>
        </div>
      </Card>
    </>
  );
}

function DefaultModel({ agent }: { agent: AgentId }) {
  const catalog = useStore((s) => s.catalogs[agent]);
  // El catálogo puede venir corrupto (AUD-001): se normaliza antes de leerlo.
  const models = useMemo(() => catalogModels(catalog && catalog !== 'loading' ? normalizeCatalog(catalog) : catalog), [catalog]);
  const [model, setModel] = useSetting<string>(`defaults.model.${agent}`, '');
  const [effort, setEffort] = useSetting<string>(`defaults.effort.${agent}`, '');
  const current = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0];
  return (
    <Field label={<span className="flex items-center gap-2"><AgentGlyph agent={agent} size={18} />{AGENT_NAME[agent]}</span>} hint={models.length ? 'Modelo y nivel de razonamiento para las conversaciones nuevas.' : 'Sin catálogo de modelos disponible todavía.'}>
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
      <Card title="Predeterminados por proveedor">
        <DefaultModel agent="claude" />
        <DefaultModel agent="codex" />
      </Card>
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

const APPEARANCE_KEYS = [
  'appearance.intensity', 'appearance.animations', 'appearance.background', 'appearance.cursorGlow',
  'glass.opacity', 'glass.reflections', 'glass.refraction', 'glass.contrast',
  'aurora.enabled', 'aurora.speed', 'aurora.intensity', 'aurora.palette',
  'ui.density', 'ui.textScale',
];

const PALETTES: { value: AuroraPalette; label: string }[] = [
  { value: 'duovra', label: 'Duovra' },
  { value: 'glaciar', label: 'Glaciar' },
  { value: 'nebulosa', label: 'Nebulosa' },
  { value: 'abisal', label: 'Abisal' },
];
const rgb = ([r, g, b]: readonly number[]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
const pct = (v: number) => `${Math.round(v * 100)} %`;

function Appearance() {
  const [intensity, setIntensity] = useSetting<'auto' | 'reduced' | 'balanced' | 'full'>('appearance.intensity', 'auto');
  const [animations, setAnimations] = useSetting('appearance.animations', true);
  const [motionOn, setMotionOn] = useSetting('appearance.background', true);
  const [glow, setGlow] = useSetting('appearance.cursorGlow', true);
  const [opacity, setOpacity] = useSetting('glass.opacity', 0.5);
  const [reflections, setReflections] = useSetting('glass.reflections', 1);
  const [refraction, setRefraction] = useSetting('glass.refraction', true);
  const [contrast, setContrast] = useSetting<'normal' | 'high'>('glass.contrast', 'normal');
  const [aurora, setAurora] = useSetting('aurora.enabled', true);
  const [speed, setSpeed] = useSetting('aurora.speed', 1);
  const [gain, setGain] = useSetting('aurora.intensity', 1);
  const [palette, setPalette] = useSetting<AuroraPalette>('aurora.palette', 'duovra');
  const [density, setDensity] = useSetting<'compact' | 'normal' | 'spacious'>('ui.density', 'normal');
  const [textScale, setTextScale] = useSetting('ui.textScale', 1);
  const setSetting = useStore((s) => s.setSetting);
  const [fps, setFps] = useState(perfState.lastFps);
  const [zoomCap, setZoomCap] = useState(maxZoom);
  useEffect(() => {
    const t = setInterval(() => setFps(perfState.lastFps), 2000);
    const r = () => setZoomCap(maxZoom());
    window.addEventListener('resize', r);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', r);
    };
  }, []);
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const glassOff = intensity === 'reduced' || !animations;
  const reset = async () => {
    if (!(await confirmDialog({ title: '¿Restablecer la apariencia?', body: 'Se recuperan los valores originales de cristal, aurora e interfaz. No afecta a proyectos, conversaciones ni otros ajustes.', confirmLabel: 'Restablecer' }))) return;
    for (const k of APPEARANCE_KEYS) await setSetting(k, null);
  };
  return (
    <>
      <Header title="Apariencia" text="Ajusta el material Liquid Glass, la aurora del fondo y la interfaz. Los cambios se aplican al instante; la preferencia de Windows de reducir animaciones siempre se respeta." />
      <Card title="Liquid Glass">
        <Field label="Intensidad visual" hint="Automática parte de «Equilibrada» y baja un nivel si el rendimiento medido cae de forma sostenida. «Reducida» usa superficies opacas sin desenfoque.">
          <Segmented id="intensity" value={intensity} onChange={setIntensity} options={[
            { value: 'auto', label: 'Automática' },
            { value: 'reduced', label: 'Reducida' },
            { value: 'balanced', label: 'Equilibrada' },
            { value: 'full', label: 'Completa' },
          ]} />
        </Field>
        <Field label="Opacidad del cristal" hint={glassOff ? 'Sin efecto en intensidad reducida: las superficies ya son opacas.' : 'Más transparente deja ver más aurora; nunca baja de un mínimo legible.'}>
          <Slider label="Opacidad del cristal" min={0} max={1} step={0.05} value={opacity} onChange={setOpacity} onPreview={previewSetting('glass.opacity')} format={(v) => (v < 0.35 ? 'Ligera' : v > 0.65 ? 'Densa' : 'Media')} />
        </Field>
        <Field label="Reflejos" hint="Brillo especular del borde y reflejo superior de cada superficie.">
          <Slider label="Reflejos" min={0} max={1.5} step={0.1} value={reflections} onChange={setReflections} onPreview={previewSetting('glass.reflections')} format={pct} />
        </Field>
        <Field label="Refracción del compositor" hint="Lente que curva el fondo en el borde del cuadro de escritura. Disponible en intensidad equilibrada y completa.">
          <Switch label="Refracción del compositor" checked={refraction} onChange={setRefraction} />
        </Field>
        <Field label="Contraste del material" hint="«Alto» oscurece el cristal, refuerza bordes y aclara los textos secundarios.">
          <Segmented id="contrast" value={contrast} onChange={setContrast} options={[{ value: 'normal', label: 'Estándar' }, { value: 'high', label: 'Alto' }]} />
        </Field>
        <Field label="Reflejo que sigue al cursor" hint="Brillo suave sobre el cuadro de escritura.">
          <Switch label="Reflejo que sigue al cursor" checked={glow} onChange={setGlow} />
        </Field>
      </Card>

      <Card title="Fondo aurora">
        <Field label="Aurora" hint="Al desactivarla, el fondo queda como luz ambiental estática y no usa la GPU.">
          <Switch label="Aurora" checked={aurora} onChange={setAurora} />
        </Field>
        {aurora && (
          <>
            <Field label="Paleta" hint="Variantes dentro de la gama azul, cian y violeta de Duovra.">
              <Swatches label="Paleta de la aurora" value={palette} onChange={setPalette} options={PALETTES.map((p) => ({ ...p, colors: AURORA_PALETTES[p.value].map(rgb) }))} />
            </Field>
            <Field label="Intensidad luminosa">
              <Slider label="Intensidad luminosa" min={0.4} max={1.3} step={0.05} value={gain} onChange={setGain} onPreview={previewSetting('aurora.intensity')} format={pct} />
            </Field>
            <Field label="Movimiento" hint={reduced ? 'Windows tiene activada la reducción de animaciones: la aurora queda estática.' : 'Se detiene con la ventana oculta y va más lento sin foco.'}>
              <Switch label="Movimiento de la aurora" checked={motionOn} onChange={setMotionOn} />
            </Field>
            {motionOn && (
              <Field label="Velocidad del movimiento">
                <Slider label="Velocidad del movimiento" min={0.25} max={2} step={0.05} value={speed} onChange={setSpeed} onPreview={previewSetting('aurora.speed')} format={(v) => `${v.toFixed(2).replace(/\.?0+$/, '')}×`} />
              </Field>
            )}
          </>
        )}
      </Card>

      <Card title="Interfaz">
        <Field label="Densidad" hint="Espaciado de mensajes, listas y filas de ajustes.">
          <Segmented id="density" value={density} onChange={setDensity} options={[
            { value: 'compact', label: 'Compacta' },
            { value: 'normal', label: 'Normal' },
            { value: 'spacious', label: 'Espaciosa' },
          ]} />
        </Field>
        <Field label="Tamaño del texto" hint={textScale > zoomCap + 0.001 ? `Limitado al ${Math.round(zoomCap * 100)} % mientras la ventana sea tan pequeña, para que todo siga cabiendo.` : 'Escala toda la interfaz por igual.'}>
          <Segmented id="text-scale" value={String(textScale)} onChange={(v) => setTextScale(Number(v))} options={[
            { value: '0.9', label: '90 %' },
            { value: '1', label: '100 %' },
            { value: '1.1', label: '110 %' },
            { value: '1.2', label: '120 %' },
          ]} />
        </Field>
        <Field label="Animaciones" hint={reduced ? 'Windows tiene activada la reducción de animaciones: se usan transiciones de opacidad.' : 'Desactivadas, Duovra usa transiciones mínimas y superficies sin desenfoque.'}>
          <Switch label="Animaciones" checked={animations} onChange={setAnimations} />
        </Field>
      </Card>

      <Card title="Rendimiento medido" actions={<button className="btn" onClick={() => void reset()}><RotateCcw size={13} /> Restablecer apariencia</button>}>
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

// ---------- Conversaciones ----------

function Conversations() {
  const [enterSends, setEnterSends] = useSetting('composer.enterToSend', true);
  const [chatWidth, setChatWidth] = useSetting<'narrow' | 'normal' | 'wide'>('ui.chatWidth', 'normal');
  const [codeScale, setCodeScale] = useSetting('ui.codeScale', 1);
  const [density, setDensity] = useSetting<'compact' | 'normal' | 'spacious'>('ui.density', 'normal');
  return (
    <>
      <Header title="Conversaciones" text="Cómo escribes y cómo se presentan los mensajes. Los borradores se guardan solos en cada conversación." />
      <Card title="Compositor">
        <Field label="Enviar mensajes con" hint={enterSends ? 'Enter envía y Mayús+Enter añade una línea.' : 'Ctrl+Enter envía y Enter añade una línea.'}>
          <Segmented id="enter-send" value={enterSends ? 'enter' : 'ctrl'} onChange={(v) => setEnterSends(v === 'enter')} options={[
            { value: 'enter', label: 'Enter' },
            { value: 'ctrl', label: 'Ctrl+Enter' },
          ]} />
        </Field>
        <Field label="Restaurar borradores" hint="Lo que escribes se guarda en cada conversación y vuelve al reabrirla, también tras reiniciar o actualizar Duovra.">
          <Badge tone="ok">Siempre activo</Badge>
        </Field>
      </Card>
      <Card title="Mensajes">
        <Field label="Anchura de la conversación" hint="Anchura máxima de la columna de mensajes y del compositor.">
          <Segmented id="chat-width" value={chatWidth} onChange={setChatWidth} options={[
            { value: 'narrow', label: 'Estrecha' },
            { value: 'normal', label: 'Normal' },
            { value: 'wide', label: 'Amplia' },
          ]} />
        </Field>
        <Field label="Densidad de mensajes" hint="Separación entre mensajes. Se comparte con Apariencia → Interfaz.">
          <Segmented id="msg-density" value={density} onChange={setDensity} options={[
            { value: 'compact', label: 'Compacta' },
            { value: 'normal', label: 'Normal' },
            { value: 'spacious', label: 'Espaciosa' },
          ]} />
        </Field>
        <Field label="Tamaño del código" hint="Bloques de código y fragmentos dentro de las respuestas.">
          <Segmented id="code-scale" value={String(codeScale)} onChange={(v) => setCodeScale(Number(v))} options={[
            { value: '0.9', label: '90 %' },
            { value: '1', label: '100 %' },
            { value: '1.12', label: '112 %' },
            { value: '1.25', label: '125 %' },
          ]} />
        </Field>
      </Card>
      <Card title="Atajos de teclado">
        <div className="kbd-list">
          {[...SHORTCUTS, [enterSends ? 'Enviar mensaje' : 'Enviar mensaje', enterSends ? 'Enter' : 'Ctrl+Enter'], ['Nueva línea', enterSends ? 'Mayús+Enter' : 'Enter']].map(([label, keys]) => (
            <div key={label}><span>{label}</span><span className="kbd">{keys}</span></div>
          ))}
        </div>
      </Card>
    </>
  );
}

// ---------- Notificaciones y actualizaciones ----------

function Updates() {
  const [toast, setToast] = useSetting('notify.taskToast', true);
  const [attention, setAttention] = useSetting('notify.taskAttention', true);
  return (
    <>
      <Header title="Avisos y actualizaciones" text="Duovra se actualiza desde su canal firmado y te avisa cuando un agente termina mientras miras otra cosa." />
      <UpdateSettings />
      <Card title="Avisos de tareas">
        <Field label="Aviso al terminar una tarea" hint="Mensaje dentro de Duovra cuando un agente termina en una conversación que no estás viendo.">
          <Switch label="Aviso al terminar una tarea" checked={toast} onChange={setToast} />
        </Field>
        <Field label="Resaltar en la barra de tareas" hint="Si Duovra está en segundo plano, su icono parpadea en la barra de tareas de Windows al terminar una tarea.">
          <Switch label="Resaltar en la barra de tareas" checked={attention} onChange={setAttention} />
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
    return { agent: a, state: !detection ? 'Comprobando' : d?.installed && d.version ? d.version : d?.installed ? 'No responde' : 'No encontrado', ok: !!(d?.installed && d.version) };
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
      toast('Diagnóstico copiado. No incluye rutas, conversaciones ni credenciales.');
    } catch {
      toast('No se pudo copiar el diagnóstico.', 'error');
    }
  };
  return (
    <>
      <Header title="Datos y diagnóstico" text="Dónde guarda Duovra tus datos y la información técnica útil para resolver problemas. Nada de esto se envía automáticamente." />
      <Card title="Datos">
        <Field label="Ubicación de los datos" hint="Proyectos, conversaciones, borradores y ajustes (studio.sqlite3). Se conservan al actualizar o desinstalar, salvo que lo elijas en el desinstalador.">
          <span className="mono-path selectable" data-tip={dataDir} data-tip-truncated>{dataDir ?? '…'}</span>
          <button className="btn-icon" aria-label="Mostrar en el Explorador" data-tip="Mostrar en el Explorador" disabled={!dataDir} onClick={() => dataDir && void revealItemInDir(dataDir).catch((e) => toast(errorText(e), 'error'))}>
            <FolderOpen size={14} />
          </button>
        </Field>
      </Card>
      <Card title="Diagnóstico" actions={<button className="btn" onClick={() => void copy()}><Copy size={13} /> Copiar diagnóstico</button>}>
        <Field label="Versión instalada"><span className="tabular-nums text-[13.5px]" style={{ color: 'var(--text-strong)' }}>{info?.version ?? '…'}</span></Field>
        <Field label="Sistema"><span className="text-[13px] muted">{info?.platform ?? '…'}</span></Field>
        <Field label="WebView2"><span className="tabular-nums text-[13px] muted">{webview ?? 'Desconocido'}</span></Field>
        <Field label="Servicio de reportes" hint={info?.reportingEnabled ? undefined : 'Esta compilación no incluye la dirección del servicio de envío.'}>
          <Badge tone={info?.reportingEnabled ? 'ok' : 'neutral'}>{info?.reportingEnabled ? 'Configurado' : 'No configurado'}</Badge>
        </Field>
        {agents.map((a) => (
          <Field key={a.agent} label={<span className="flex items-center gap-2"><AgentGlyph agent={a.agent} size={18} />{AGENT_NAME[a.agent]}</span>}>
            <Badge tone={a.ok ? 'ok' : detection ? 'warn' : 'neutral'}>{a.state}</Badge>
          </Field>
        ))}
      </Card>
      <Card title="Documentación y licencia">
        <p className="settings-card-sub mt-2 text-[12.5px] faint">Duovra es software libre con licencia MIT. Claude Code y Codex son productos de sus respectivos proveedores y tienen sus propias condiciones.</p>
        <div className="link-row">
          <button className="btn" onClick={() => void openUrl(`${REPO}#readme`)}><ExternalLink size={13} /> Documentación</button>
          <button className="btn" onClick={() => void openUrl(`${REPO}/blob/main/CHANGELOG.md`)}><ExternalLink size={13} /> Historial de cambios</button>
          <button className="btn" onClick={() => void openUrl(`${REPO}/blob/main/LICENSE`)}><ExternalLink size={13} /> Licencia MIT</button>
          <button className="btn" onClick={() => void openUrl(REPO)}><ExternalLink size={13} /> Código fuente</button>
        </div>
      </Card>
    </>
  );
}

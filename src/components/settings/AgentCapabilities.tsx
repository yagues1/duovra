import { ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../../state/store';
import type { AgentCapabilities as Report, AgentId, Capability, CapabilityId, CapabilityLevel, CapabilityStatus } from '../../lib/types';
import { AGENT_NAME, fmtRelative } from '../../lib/format';
import { Badge, Segmented } from '../ui/Controls';
import { tr } from '../../i18n';

const LABEL: Record<CapabilityId, () => string> = {
  streaming: () => tr('Respuesta en directo'),
  imageInput: () => tr('Adjuntos de imágenes'),
  resume: () => tr('Reanudar sesiones'),
  fork: () => tr('Bifurcar sesiones'),
  sessionList: () => tr('Listar sesiones'),
  sessionRead: () => tr('Leer sesiones'),
  compact: () => tr('Compactación'),
  planning: () => tr('Planificación'),
  interactiveQuestions: () => tr('Preguntas interactivas'),
  steering: () => tr('Indicaciones durante el turno'),
  interrupt: () => tr('Interrupción'),
  quickCommands: () => tr('Comandos rápidos'),
  tasks: () => tr('Tareas'),
  subagents: () => tr('Subagentes'),
  codeReview: () => tr('Revisión de código'),
  goals: () => tr('Objetivos persistentes'),
  usageInfo: () => tr('Información de consumo'),
  rateLimits: () => tr('Límites de uso'),
};

const STATUS: Record<CapabilityStatus, { tone: 'ok' | 'warn' | 'error' | 'neutral'; label: () => string }> = {
  supported: { tone: 'ok', label: () => tr('Compatible') },
  experimental: { tone: 'warn', label: () => tr('Experimental') },
  unsupported: { tone: 'error', label: () => tr('No compatible') },
  unknown: { tone: 'neutral', label: () => tr('Desconocida') },
};

const LEVEL: Record<CapabilityLevel, () => string> = {
  installation: () => tr('Instalación'),
  account: () => tr('Cuenta'),
  model: () => tr('Modelo'),
  run: () => tr('Ejecución'),
};

const INTEGRATED: Record<Capability['integrated'], () => string> = {
  yes: () => tr('Integrado'),
  partial: () => tr('Parcial'),
  no: () => tr('Aún no'),
};

const LIMITATION: Record<string, () => string> = {
  fastModeDisabled: () => tr('La CLI informa el modo rápido desactivado al abrir la conexión. Motivo comunicado:'),
  helpUnavailable: () => tr('No se pudo leer la ayuda de la CLI: algunas capacidades quedan desconocidas.'),
  schemaUnavailable: () => tr('No se pudo generar el esquema del App Server: las notificaciones quedan desconocidas.'),
  methodsUnavailable: () => tr('El App Server no enumeró sus métodos: las operaciones quedan desconocidas.'),
};

/** Ajustes → Agentes y modelos → Capacidades. Solo consulta al desplegarse. */
export function AgentCapabilities() {
  const [open, setOpen] = useState(false);
  const defaultAgent = useStore((s) => (s.settings['defaults.agent'] as AgentId | undefined) ?? 'codex');
  const [agent, setAgent] = useState<AgentId>(defaultAgent);
  return (
    <details className="settings-card settings-fold" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronRight size={14} className="settings-fold-chev" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="settings-fold-title">{tr('Capacidades de los agentes')}</span>
          <span className="settings-fold-hint">{tr('Lo que comunica cada CLI instalada y lo que Duovra integra hoy.')}</span>
        </span>
      </summary>
      {open && (
        <div className="px-4 pb-3">
          <div className="caps-toolbar">
            <Segmented id="caps-agent" value={agent} onChange={setAgent} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
          </div>
          <AgentReport key={agent} agent={agent} />
        </div>
      )}
    </details>
  );
}

function AgentReport({ agent }: { agent: AgentId }) {
  const state = useStore((s) => s.capabilities[agent]);
  const refresh = useStore((s) => s.refreshCapabilities);
  useEffect(() => {
    if (!state) void refresh(agent);
  }, [agent, state, refresh]);
  const loading = !state || state === 'loading';
  const action = (
    <button className="btn" disabled={loading} onClick={() => void refresh(agent, true)}>
      <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden /> {tr('Actualizar')}
    </button>
  );
  if (loading) return <div className="caps-status" role="status">{tr('Consultando a {agent}…', { agent: AGENT_NAME[agent] })}</div>;
  if ('error' in state && typeof state.error === 'string' && !('capabilities' in state)) {
    return <div className="caps-status" role="status"><span>{state.error}</span>{action}</div>;
  }
  const report = state as Report;
  const inst = report.installation;
  const account = inst.account?.label ?? (inst.account?.source === 'cli' ? tr('Perfil de la CLI') : undefined);
  const connection = report.error && !report.stale ? { tone: 'error' as const, text: tr('Sin conexión') }
    : report.stale ? { tone: 'warn' as const, text: tr('Datos desactualizados') }
    : { tone: 'ok' as const, text: tr('Conectado') };
  const auth = inst.auth?.state === 'signedIn' ? tr('Sesión iniciada') : inst.auth?.state === 'signedOut' ? tr('Sin sesión') : tr('Desconocida');
  const caps = report.capabilities ?? [];
  const groups: { title: string; items: Capability[] }[] = [
    { title: tr('Integrado en Duovra'), items: caps.filter((c) => c.integrated !== 'no') },
    { title: tr('Comunicado por el proveedor, pendiente en Duovra'), items: caps.filter((c) => c.integrated === 'no') },
  ];
  return (
    <div className="caps">
      <div className="caps-summary">
        <dl className="caps-facts">
          <Fact label={tr('Versión')} value={inst.version ?? undefined} mono />
          <Fact label={tr('Protocolo')} value={inst.protocol} />
          <Fact label={tr('Cuenta')} value={account} />
          <Fact label={tr('Autenticación')} value={[auth, inst.auth?.plan].filter(Boolean).join(' · ')} />
          <Fact label={tr('Modelos comunicados')} value={String(report.models?.length ?? 0)} />
          <Fact label={tr('Actualizado')} value={report.checkedAt ? fmtRelative(report.checkedAt) : undefined} />
        </dl>
        <div className="caps-side">
          <Badge tone={connection.tone}>{connection.text}</Badge>
          {action}
        </div>
      </div>
      {report.error && (
        <p className="caps-note" data-tone={report.stale ? 'warn' : 'error'}>
          {report.stale
            ? tr('No se pudo consultar a {agent}. Se muestran los últimos datos válidos.', { agent: AGENT_NAME[agent] })
            : tr('No se pudo consultar a {agent}.', { agent: AGENT_NAME[agent] })}
          <span className="selectable caps-detail">{report.error}</span>
        </p>
      )}
      <p className="caps-legend">{tr('«Proveedor» indica lo que admite la instalación; «Duovra», lo que la aplicación usa hoy. Una capacidad compatible no está disponible en Duovra hasta que se integre.')}</p>
      {groups.map((g) => g.items.length > 0 && (
        <section key={g.title} className="caps-group">
          <h4>{g.title}</h4>
          <ul className="caps-list">
            {g.items.map((c) => (
              <li key={c.id} className="caps-row">
                <span className="caps-name">
                  {LABEL[c.id]?.() ?? c.id}
                  <span className="caps-level">{LEVEL[c.level]?.() ?? c.level}</span>
                </span>
                <span className="caps-source selectable" data-tip={[c.source, c.note].filter(Boolean).join(' · ')}>{c.source}</span>
                <span className="caps-badges">
                  <span className="caps-col-label">{tr('Proveedor')}</span>
                  <Badge tone={STATUS[c.status]?.tone ?? 'neutral'}>{STATUS[c.status]?.label() ?? c.status}</Badge>
                  <span className="caps-col-label">Duovra</span>
                  <span className="caps-integrated" data-state={c.integrated}>{INTEGRATED[c.integrated]?.()}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {(report.limitations?.length ?? 0) > 0 && (
        <section className="caps-group">
          <h4>{tr('Limitaciones conocidas')}</h4>
          <ul className="caps-limits">
            {report.limitations!.map((l) => <li key={l.id}>{LIMITATION[l.id]?.() ?? l.id}{typeof l.detail === 'string' && <span className="caps-detail selectable">{l.detail}</span>}</li>)}
          </ul>
        </section>
      )}
      {inst.experimentalMethods ? (
        <p className="caps-legend">{tr('El App Server reconoce {n} métodos fuera de su esquema estable. Duovra no activa la API experimental.', { n: inst.experimentalMethods })}</p>
      ) : null}
      {report.commands?.length > 0 && (
        <p className="caps-legend">{tr('La CLI comunica {n} comandos. Duovra los registra sin ejecutarlos; el menú de comandos llegará más adelante.', { n: report.commands.length })}</p>
      )}
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="caps-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'font-mono' : undefined}>{value || '—'}</dd>
    </div>
  );
}

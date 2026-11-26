import { memo, useEffect, useId, useRef, useState } from 'react';
import { Shrink } from 'lucide-react';
import type { AgentId, Conversation } from '../../lib/types';
import { Popover } from '../ui/Popover';
import { confirmDialog } from '../ui/Dialog';
import { useStore } from '../../state/store';
import { useContextStore } from '../../state/context';
import { ringArc } from '../../lib/context';
import { AGENT_NAME, fmtTokens } from '../../lib/format';
import { Mascot } from '../mascot/Mascot';
import { tr, useTr } from '../../i18n';

const R = 7;
const BIG = 22;

/**
 * Indicador de contexto del compositor (1.0.11). Solo lo útil: agente, ocupación de la ventana nativa
 * cuando el proveedor la comunica y la acción de compactar. Sin datos del proveedor, estado neutral.
 * Todo lo demás (transferencia, memoria, presupuesto) lo gestiona el motor de forma automática.
 */
/** `openSignal`: cada cambio abre la tarjeta (comandos `/context` y `/compact`, fase 5). La acción de
 * compactar recibe el foco y conserva su confirmación. */
export const ContextIndicator = memo(function ContextIndicator({ conv, agent, busy, openSignal = 0 }: { conv: Conversation; agent: AgentId; busy: boolean; openSignal?: number }) {
  useTr();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const status = useContextStore((s) => s.status[`${conv.id}:${agent}`]);
  const version = useContextStore((s) => s.version[conv.id] ?? 0);
  const compaction = useContextStore((s) => s.compaction[conv.id]);
  const refresh = useContextStore((s) => s.refreshStatus);
  const compacting = isCompacting(compaction?.state);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);

  useEffect(() => {
    if (busy) return;
    void refresh(conv.id, agent);
  }, [conv.id, agent, version, busy, refresh]);

  const percent = status?.native.percent ?? null;
  const arc = ringArc(percent, R);
  const label = compacting
    ? tr('Compactando el contexto…')
    : percent != null
      ? tr('Contexto de {agent}: {percent} % ocupado', { agent: AGENT_NAME[agent], percent: fmtPercent(percent) })
      : tr('Contexto de {agent}', { agent: AGENT_NAME[agent] });

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ctx-btn composer-picker"
        data-tone={arc?.tone}
        data-known={arc ? true : undefined}
        data-busy={compacting || undefined}
        aria-label={label}
        data-tip={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Ring percent={percent} r={R} size={18} spinning={compacting} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn.current} placement="top-end" width={256}
        menuId={menuId} role="dialog" ariaLabel={tr('Contexto')} className="composer-popup ctx-pop">
        {open && <ContextCard conv={conv} agent={agent} busy={busy} close={() => setOpen(false)} />}
      </Popover>
    </>
  );
});

function isCompacting(state: string | undefined) {
  return !!state && !['completed', 'failed', 'unknown'].includes(state);
}

function fmtPercent(n: number) {
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function Ring({ percent, r, size, spinning }: { percent: number | null; r: number; size: number; spinning?: boolean }) {
  const arc = ringArc(percent, r);
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="ctx-ring" data-tone={arc?.tone} data-known={arc ? true : undefined}>
      <circle cx={c} cy={c} r={r} className="ctx-ring-track" />
      {arc && <circle cx={c} cy={c} r={r} className="ctx-ring-fill" strokeDasharray={arc.dash} transform={`rotate(-90 ${c} ${c})`} />}
      {spinning && <circle cx={c} cy={c} r={r} className="ctx-ring-spin" strokeDasharray={`${r * 1.4} ${r * 5}`} style={{ transformOrigin: `${c}px ${c}px` }} />}
    </svg>
  );
}

function ContextCard({ conv, agent, busy, close }: { conv: Conversation; agent: AgentId; busy: boolean; close: () => void }) {
  const status = useContextStore((s) => s.status[`${conv.id}:${agent}`]);
  const refresh = useContextStore((s) => s.refreshStatus);
  const compact = useContextStore((s) => s.compact);
  const compaction = useContextStore((s) => s.compaction[conv.id]);
  const capability = useStore((s) => s.capabilities[agent]);
  const refreshCapabilities = useStore((s) => s.refreshCapabilities);
  const queueBusy = useStore((s) => !!s.queues[conv.id]?.entries.some((e) => e.state === 'running'));

  useEffect(() => {
    void refresh(conv.id, agent);
    if (capability === undefined) void refreshCapabilities(agent);
  }, []);

  const native = status?.native;
  const percent = native?.percent ?? null;
  const compacting = isCompacting(compaction?.state);
  const report = capability && capability !== 'loading' && 'capabilities' in capability ? capability : null;
  const cap = report?.capabilities.find((c) => c.id === 'compact');
  const supported = cap?.status === 'supported' || cap?.status === 'experimental';
  const reason = !report ? tr('Comprobando si {agent} admite la compactación…', { agent: AGENT_NAME[agent] })
    : !supported ? tr('{agent} no admite la compactación en esta instalación.', { agent: AGENT_NAME[agent] })
      : !native?.hasSession ? tr('Todavía no hay contexto que compactar.')
        : busy || queueBusy ? tr('Disponible cuando termine la ejecución.')
          : compacting ? tr('Compactando…') : null;

  const doCompact = async () => {
    close();
    const ok = await confirmDialog({
      title: tr('¿Compactar el contexto de {agent}?', { agent: AGENT_NAME[agent] }),
      body: tr('{agent} resumirá su propia sesión con su mecanismo nativo y consumirá uso de tu cuenta. No afecta al otro agente, al historial de Duovra ni a tus archivos.', { agent: AGENT_NAME[agent] }),
      confirmLabel: tr('Compactar'),
    });
    if (ok) void compact(conv.id, agent);
  };

  return (
    <div className="ctx-card">
      <div className="ctx-card-head">
        <Mascot agent={agent} state="idle" size={20} animated={false} />
        <span className="ctx-card-agent">{AGENT_NAME[agent]}</span>
      </div>
      <div className="ctx-card-body">
        <div className="ctx-card-ring">
          <Ring percent={percent} r={BIG} size={56} spinning={compacting} />
          <span className="ctx-card-pct">{percent != null ? `${fmtPercent(percent)} %` : '—'}</span>
        </div>
        <div className="ctx-card-text">
          {percent != null && native ? (
            <>
              <span className="ctx-card-main">{tr('{percent} % ocupado', { percent: fmtPercent(percent) })}</span>
              <span className="ctx-card-sub">{tr('{used} de {total} tokens', { used: fmtTokens(native.contextTokens), total: fmtTokens(native.contextWindow) })}</span>
            </>
          ) : (
            <span className="ctx-card-sub">
              {!status ? tr('Cargando…') : native?.contextTokens != null
                ? tr('{used} tokens en uso', { used: fmtTokens(native.contextTokens) })
                : tr('{agent} todavía no ha informado de la ocupación.', { agent: AGENT_NAME[agent] })}
            </span>
          )}
          {compacting && <span className="ctx-card-sub" role="status">{tr('Compactando…')}</span>}
          {compaction?.state === 'failed' && <span className="ctx-card-sub" data-tone="warn" role="status">{tr('La última compactación falló.')}</span>}
        </div>
      </div>
      <button type="button" className="btn ctx-card-action" disabled={!!reason} onClick={() => void doCompact()} data-popover-focus>
        <Shrink size={14} aria-hidden />{tr('Compactar contexto')}
      </button>
      {reason && !compacting && <p className="ctx-card-reason">{reason}</p>}
    </div>
  );
}

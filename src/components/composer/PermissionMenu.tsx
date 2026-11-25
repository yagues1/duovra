import { useState } from 'react';
import {
  Check, ClipboardList, Eye, FilePen, FolderPen, Hand, HardDrive, MessageCircleQuestion, Shield, ShieldAlert, ShieldBan,
  ShieldCheck, ShieldOff, Sparkles, TriangleAlert, type LucideIcon,
} from 'lucide-react';
import type { AgentId } from '../../lib/types';
import {
  claudeModes, codexApprovals, codexSandboxes, isRestricted, riskOf, type PermissionOption, type Permissions, type Risk,
} from '../../lib/permissions';
import { tr } from '../../i18n';

const OPTION_ICON: Record<string, LucideIcon> = {
  manual: Hand,
  plan: ClipboardList,
  dontAsk: ShieldBan,
  acceptEdits: FilePen,
  auto: Sparkles,
  bypassPermissions: ShieldOff,
  'read-only': Eye,
  'workspace-write': FolderPen,
  'danger-full-access': HardDrive,
  untrusted: ShieldCheck,
  'on-request': MessageCircleQuestion,
  never: ShieldAlert,
};

/** Escudo del botón cerrado: refleja de un vistazo el estado activo. */
export function shieldFor(agent: AgentId, p: Permissions): { Icon: LucideIcon; risk: Risk; restricted: boolean } {
  const risk = riskOf(agent, p);
  const restricted = risk === 'safe' && isRestricted(agent, p);
  const Icon = risk === 'danger' ? ShieldOff : risk === 'reduced' ? ShieldAlert : restricted ? ShieldCheck : Shield;
  return { Icon, risk, restricted };
}

interface Pending { key: keyof Permissions; option: PermissionOption; base: Permissions }

/**
 * Menú de permisos del compositor (1.0.9). Claude Code: un modo. Codex: sandbox y aprobación por
 * separado, nunca confundidos. Las opciones que desactivan protecciones piden confirmación aquí mismo.
 */
export function PermissionMenu({ agent, value, busy, open, onChange }: {
  agent: AgentId;
  value: Permissions;
  busy: boolean;
  /** El menú está abierto. Al reabrirlo se vuelve a la lista; al cerrarse conserva lo que mostraba. */
  open: boolean;
  onChange: (next: Permissions) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Se reinicia al abrir, no al cerrar: así la confirmación no cambia de contenido (ni de tamaño)
  // mientras el menú se desvanece, y el popover no se recoloca ni reaparece un instante.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && pending) setPending(null);
  }
  const choose = (key: keyof Permissions, option: PermissionOption) => {
    if (value[key] === option.value) return onChange(value);
    if (option.confirm) return setPending({ key, option, base: value });
    onChange({ ...value, [key]: option.value });
  };

  if (pending) {
    const base = pending.base;
    const fullAuto = agent === 'codex' && ((pending.key === 'approval' && base.sandbox === 'danger-full-access')
      || (pending.key === 'sandbox' && base.approval === 'never'));
    return (
      <div className="mp perm-menu perm-confirm" role="group" aria-label={tr('Confirmar permisos')}>
        <div className="perm-confirm-head" data-risk={pending.option.risk}>
          <TriangleAlert size={15} aria-hidden />
          <span>{tr('¿Reducir las protecciones?')}</span>
        </div>
        <p className="perm-confirm-text">
          <strong>{pending.option.label}</strong>: {pending.option.description}
          {' '}{fullAuto
            ? tr('Combinado con la otra opción, Codex actuará sin sandbox y sin pedir aprobación.')
            : tr('Solo afecta a esta conversación con {agent}, desde el próximo mensaje.', { agent: agent === 'claude' ? 'Claude Code' : 'Codex' })}
        </p>
        <div className="perm-confirm-actions">
          <button type="button" role="menuitem" tabIndex={-1} className="btn" onClick={() => setPending(null)}>{tr('Cancelar')}</button>
          <button type="button" role="menuitem" tabIndex={-1} className="btn perm-confirm-go" data-risk={pending.option.risk}
            onClick={() => onChange({ ...value, [pending.key]: pending.option.value })}>
            {tr('Activar')}
          </button>
        </div>
      </div>
    );
  }

  const group = (title: string, key: keyof Permissions, options: PermissionOption[]) => (
    <div className="perm-group" role="group" aria-label={title}>
      <div className="mp-head" role="presentation">{title}</div>
      <div className="mp-list">
        {options.map((option) => {
          const selected = value[key] === option.value;
          const Icon = OPTION_ICON[option.value] ?? Shield;
          return (
            <button key={option.value} type="button" role="menuitemradio" aria-checked={selected} tabIndex={-1}
              className="mp-model perm-row" data-selected={selected || undefined} data-risk={option.risk}
              onClick={() => choose(key, option)}>
              <span className="perm-icon" aria-hidden><Icon size={15} strokeWidth={1.7} /></span>
              <span className="mp-model-text">
                <span className="mp-model-name">
                  {option.label}
                  {option.risk !== 'safe' && (
                    <span className="perm-warn" data-risk={option.risk}>
                      {option.risk === 'danger' ? tr('Sin protecciones') : tr('Menos protección')}
                    </span>
                  )}
                </span>
                <span className="perm-desc">{option.description}</span>
              </span>
              <span className="mp-check" aria-hidden>{selected && <Check size={14} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="mp perm-menu">
      {agent === 'claude'
        ? group(tr('Permisos de Claude Code'), 'mode', claudeModes())
        : (
          <>
            {group(tr('Sandbox · qué puede tocar'), 'sandbox', codexSandboxes())}
            {group(tr('Aprobación · cuándo pregunta'), 'approval', codexApprovals())}
          </>
        )}
      <div className="perm-foot" role="note">
        {busy
          ? tr('La ejecución en curso conserva sus permisos. El cambio se aplica al próximo mensaje.')
          : tr('Solo para esta conversación. Las solicitudes de aprobación aparecen en el chat.')}
      </div>
    </div>
  );
}

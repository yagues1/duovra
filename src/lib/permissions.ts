import type { AgentId, Conversation, Settings } from './types';
import { tr } from '../i18n';

/**
 * Permisos de un turno, elegidos en el compositor (1.0.9). Claude Code usa un único modo
 * (`--permission-mode`); Codex separa el sandbox (qué puede tocar) de la política de aprobación
 * (cuándo pregunta). Nunca se mezclan entre proveedores.
 */
export interface Permissions {
  mode?: string;
  sandbox?: string;
  approval?: string;
}

/** `safe`: mantiene o refuerza las protecciones. `reduced`: aprueba algo sin preguntar. `danger`: las desactiva. */
export type Risk = 'safe' | 'reduced' | 'danger';

export interface PermissionOption {
  value: string;
  label: string;
  description: string;
  risk: Risk;
  /** Elegirla exige confirmación explícita. */
  confirm?: boolean;
}

/** Modos de `claude --permission-mode` en la CLI instalada (2.1.325). */
/** Planificar ya no es un permiso (1.0.11, fase 4): es el modo de trabajo del compositor. Un `plan` guardado vuelve al predeterminado. */
export const CLAUDE_MODES = ['manual', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
/** `SandboxMode` y `AskForApproval` (simple) del protocolo app-server de Codex (0.169). */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export const CODEX_APPROVALS = ['untrusted', 'on-request', 'never'] as const;

export function claudeModes(): PermissionOption[] {
  return [
    { value: 'manual', label: tr('Manual'), description: tr('Pregunta en el chat antes de usar herramientas que lo requieran.'), risk: 'safe' },
    { value: 'dontAsk', label: tr('No preguntar'), description: tr('Deniega sin preguntar lo que no esté permitido de antemano.'), risk: 'safe' },
    { value: 'acceptEdits', label: tr('Aceptar ediciones'), description: tr('Aplica cambios en archivos sin pedir confirmación.'), risk: 'reduced' },
    { value: 'auto', label: tr('Automático'), description: tr('Claude Code decide qué acciones aprueba sin preguntarte.'), risk: 'reduced' },
    { value: 'bypassPermissions', label: tr('Omitir permisos'), description: tr('Ejecuta cualquier herramienta sin comprobaciones.'), risk: 'danger', confirm: true },
  ];
}

export function codexSandboxes(): PermissionOption[] {
  return [
    { value: 'read-only', label: tr('Solo lectura'), description: tr('Lee el proyecto sin escribir archivos.'), risk: 'safe' },
    { value: 'workspace-write', label: tr('Escritura en el proyecto'), description: tr('Escribe dentro del proyecto, sin red.'), risk: 'safe' },
    { value: 'danger-full-access', label: tr('Acceso completo'), description: tr('Sin sandbox: acceso a todo el equipo y a la red.'), risk: 'danger', confirm: true },
  ];
}

export function codexApprovals(): PermissionOption[] {
  return [
    { value: 'untrusted', label: tr('Pedir para lo no confiable'), description: tr('Pregunta antes de cualquier comando no confiable.'), risk: 'safe' },
    { value: 'on-request', label: tr('Cuando lo pida'), description: tr('Pregunta cuando Codex necesita salir del sandbox.'), risk: 'safe' },
    { value: 'never', label: tr('Nunca preguntar'), description: tr('No pide aprobación: lo que el sandbox no permita, falla.'), risk: 'reduced', confirm: true },
  ];
}

const pick = <T extends readonly string[]>(allowed: T, ...values: unknown[]): T[number] | undefined =>
  values.find((v): v is T[number] => typeof v === 'string' && (allowed as readonly string[]).includes(v));

/** Ajustes globales de Duovra como valores iniciales (nunca la configuración de las CLIs). */
export function globalPermissions(agent: AgentId, settings: Settings): Permissions {
  return agent === 'claude'
    ? { mode: pick(CLAUDE_MODES, settings['claude.permissionMode']) ?? 'manual' }
    : {
        sandbox: pick(CODEX_SANDBOXES, settings['codex.sandbox']) ?? 'workspace-write',
        approval: pick(CODEX_APPROVALS, settings['codex.approvalPolicy']) ?? 'on-request',
      };
}

/** Permisos de la conversación para un agente: los suyos guardados o, si no hay, los globales. */
export function permissionsFor(conv: Conversation | undefined, agent: AgentId, settings: Settings): Permissions {
  const base = globalPermissions(agent, settings);
  const saved = conv?.permissionPrefs?.[agent];
  if (!saved) return base;
  return agent === 'claude'
    ? { mode: pick(CLAUDE_MODES, saved.mode) ?? base.mode }
    : { sandbox: pick(CODEX_SANDBOXES, saved.sandbox) ?? base.sandbox, approval: pick(CODEX_APPROVALS, saved.approval) ?? base.approval };
}

const order: Risk[] = ['safe', 'reduced', 'danger'];
const max = (a: Risk, b: Risk): Risk => (order.indexOf(a) >= order.indexOf(b) ? a : b);

export function riskOf(agent: AgentId, p: Permissions): Risk {
  if (agent === 'claude') return claudeModes().find((o) => o.value === p.mode)?.risk ?? 'safe';
  const sandbox = codexSandboxes().find((o) => o.value === p.sandbox)?.risk ?? 'safe';
  const approval = codexApprovals().find((o) => o.value === p.approval)?.risk ?? 'safe';
  return max(sandbox, approval);
}

/** Más restrictivo que el predeterminado (solo lectura, planificar, no preguntar). */
export function isRestricted(agent: AgentId, p: Permissions): boolean {
  return agent === 'claude' ? p.mode === 'plan' || p.mode === 'dontAsk' : p.sandbox === 'read-only' || p.approval === 'untrusted';
}

/** Texto corto del estado activo, para tooltip, lector de pantalla y la cola. */
export function permissionSummary(agent: AgentId, p: Permissions): string {
  if (agent === 'claude') return claudeModes().find((o) => o.value === p.mode)?.label ?? tr('Manual');
  const sandbox = codexSandboxes().find((o) => o.value === p.sandbox)?.label ?? '';
  const approval = codexApprovals().find((o) => o.value === p.approval)?.label ?? '';
  return `${sandbox} · ${approval}`;
}

export function samePermissions(a: Permissions | undefined, b: Permissions | undefined): boolean {
  return (a?.mode ?? null) === (b?.mode ?? null) && (a?.sandbox ?? null) === (b?.sandbox ?? null) && (a?.approval ?? null) === (b?.approval ?? null);
}

/**
 * Errores de los proveedores normalizados (1.0.11, fase 5).
 *
 * El backend guarda una línea comprensible seguida de «Detalle del proveedor: …» con el texto original
 * (sin credenciales). Aquí se clasifica para ofrecer acciones según el caso. Ninguna acción consume
 * cuota por sí sola: «Reintentar» prepara el mensaje en el compositor, no lo envía; no hay reintentos
 * automáticos ni cambios de proveedor.
 */
import type { AgentId } from './types';

export type ErrorKind =
  | 'usageLimit' | 'modelUnavailable' | 'sessionExpired' | 'authRequired' | 'connection' | 'permission'
  | 'toolBlocked' | 'cliIncompatible' | 'interrupted' | 'uncertainDelivery' | 'unknown';

export type ErrorAction = 'retry' | 'model' | 'agent' | 'reauth' | 'resume' | 'permissions' | 'limits';

export interface NormalizedError {
  kind: ErrorKind;
  /** Línea principal (la del backend o la original si no hay otra). */
  summary: string;
  /** Texto original del proveedor, si el backend lo conservó. */
  detail: string | null;
  actions: ErrorAction[];
}

const DETAIL = /\n\s*\n(?:Detalle del proveedor|Provider detail): ([\s\S]*)$/;

const RULES: Array<{ kind: ErrorKind; test: RegExp }> = [
  { kind: 'usageLimit', test: /límite de uso|usage limit|rate.?limit|429|quota|too many requests|limit reached|usageLimit|credits/i },
  { kind: 'sessionExpired', test: /caduc|expired/i },
  { kind: 'authRequired', test: /sesión del proveedor no está disponible|not logged in|unauthori[sz]ed|authentication|invalid api key|\b401\b|login required|iniciar sesión/i },
  { kind: 'modelUnavailable', test: /no admite el modelo|model_not_found|invalid_model|model not found|model is not available|unsupported model|ya no está disponible/i },
  { kind: 'toolBlocked', test: /herramienta quedó bloqueada|tool use was denied|tool is not allowed|denied by policy|sandbox denied|blocked by/i },
  { kind: 'permission', test: /denegó el permiso|permission denied|forbidden|\b403\b|access denied|not permitted/i },
  { kind: 'cliIncompatible', test: /no admite esta operación|unknown option|unexpected argument|unknown variant|method not found|unrecognized|no publica/i },
  { kind: 'uncertainDelivery', test: /no confirmó|sin confirmar|no confirmada|incierta|uncertain/i },
  { kind: 'connection', test: /no pudo conectarse|connection|network|dns|timed out|offline|econn|socket/i },
  { kind: 'interrupted', test: /interrump|interrupted|se detuvo|terminó sin/i },
];

const ACTIONS: Record<ErrorKind, ErrorAction[]> = {
  usageLimit: ['limits', 'model', 'agent'],
  modelUnavailable: ['model', 'agent'],
  sessionExpired: ['reauth', 'resume'],
  authRequired: ['reauth', 'agent'],
  connection: ['retry'],
  permission: ['permissions', 'retry'],
  toolBlocked: ['permissions'],
  cliIncompatible: ['agent'],
  interrupted: ['retry', 'resume'],
  uncertainDelivery: ['resume'],
  unknown: ['retry', 'agent'],
};

export function normalizeError(raw: string | null | undefined, _agent?: AgentId): NormalizedError {
  const text = (raw ?? '').trim();
  const m = DETAIL.exec(text);
  const summary = (m ? text.slice(0, m.index) : text).trim();
  const detail = m ? m[1].trim() : null;
  const kind = RULES.find((r) => r.test.test(summary) || (detail ? r.test.test(detail) : false))?.kind ?? 'unknown';
  return { kind, summary: summary || text, detail, actions: ACTIONS[kind] };
}

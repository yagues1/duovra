import { fmt, tr } from '../i18n';

// Textos de las copias de seguridad. El backend valida el archivo y devuelve este resumen antes de
// cualquier cambio; aquí solo se presenta.

export interface BackupSummary {
  createdAt: number | null;
  appVersion: string | null;
  projects: number;
  conversations: number;
  messages: number;
  backgrounds: number;
}

export interface RestoreNotice {
  status: 'restored' | 'failed';
  at: number;
  summary?: BackupSummary;
  /** Copia del estado anterior a la restauración, si existía. */
  safetyCopy?: string | null;
  error?: string;
}

/** `one` y `many` llevan `{n}`; el número se formatea en el idioma activo. */
function plural(count: number, one: string, many: string): string {
  return (count === 1 ? one : many).replace('{n}', fmt.number(count));
}

/** «3 proyectos, 12 conversaciones, 340 mensajes y 2 fondos». */
export function backupContents(summary: BackupSummary): string {
  const parts = [
    plural(summary.projects, tr('{n} proyecto'), tr('{n} proyectos')),
    plural(summary.conversations, tr('{n} conversación'), tr('{n} conversaciones')),
    plural(summary.messages, tr('{n} mensaje'), tr('{n} mensajes')),
  ];
  if (summary.backgrounds > 0) parts.push(plural(summary.backgrounds, tr('{n} fondo personalizado'), tr('{n} fondos personalizados')));
  return parts.length > 1 ? tr('{items} y {last}', { items: parts.slice(0, -1).join(', '), last: parts[parts.length - 1] }) : parts[0];
}

export function backupDateText(summary: BackupSummary): string {
  if (summary.createdAt === null) return tr('con fecha desconocida');
  return tr('creada el {date}', { date: fmt.dateTime(summary.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) });
}

/** Texto de la confirmación previa a la restauración. Nada cambia hasta confirmarla. */
export function restoreConfirmBody(summary: BackupSummary): string {
  const origin = summary.appVersion ? `Duovra ${summary.appVersion}` : tr('una versión anterior de Duovra');
  return [
    tr('La copia ({origin}, {date}) contiene {contents}.', { origin, date: backupDateText(summary), contents: backupContents(summary) }),
    tr('Al confirmar, Duovra guardará antes una copia del estado actual en su carpeta de datos (backups) y después se reiniciará para aplicar la restauración.'),
    tr('Los cambios que hagas después de confirmar quedan en esa copia previa, no en la restauración.'),
    tr('Tus cuentas de Claude Code y Codex no se modifican.'),
  ].join(' ');
}

export function restoreNoticeText(notice: RestoreNotice): { tone: 'info' | 'error'; text: string } {
  if (notice.status === 'failed') {
    return { tone: 'error', text: notice.error ?? tr('La copia de seguridad no se pudo restaurar. Tus datos anteriores se conservan.') };
  }
  const copy = notice.safetyCopy ? ' ' + tr('El estado anterior quedó en {path}.', { path: notice.safetyCopy }) : '';
  return { tone: 'info', text: tr('Copia restaurada: {contents}.', { contents: notice.summary ? backupContents(notice.summary) : tr('datos recuperados') }) + copy };
}

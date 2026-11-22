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

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('es-ES')} ${count === 1 ? one : many}`;
}

/** «3 proyectos, 12 conversaciones, 340 mensajes y 2 fondos». */
export function backupContents(summary: BackupSummary): string {
  const parts = [
    plural(summary.projects, 'proyecto', 'proyectos'),
    plural(summary.conversations, 'conversación', 'conversaciones'),
    plural(summary.messages, 'mensaje', 'mensajes'),
  ];
  if (summary.backgrounds > 0) parts.push(plural(summary.backgrounds, 'fondo personalizado', 'fondos personalizados'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0];
}

export function backupDateText(summary: BackupSummary): string {
  if (summary.createdAt === null) return 'con fecha desconocida';
  return `creada el ${new Date(summary.createdAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** Texto de la confirmación previa a la restauración. Nada cambia hasta confirmarla. */
export function restoreConfirmBody(summary: BackupSummary): string {
  const origin = summary.appVersion ? `Duovra ${summary.appVersion}` : 'una versión anterior de Duovra';
  return [
    `La copia (${origin}, ${backupDateText(summary)}) contiene ${backupContents(summary)}.`,
    'Al confirmar, Duovra guardará antes una copia del estado actual en su carpeta de datos (backups) y después se reiniciará para aplicar la restauración.',
    'Los cambios que hagas después de confirmar quedan en esa copia previa, no en la restauración.',
    'Tus cuentas de Claude Code y Codex no se modifican.',
  ].join(' ');
}

export function restoreNoticeText(notice: RestoreNotice): { tone: 'info' | 'error'; text: string } {
  if (notice.status === 'failed') {
    return { tone: 'error', text: notice.error ?? 'La copia de seguridad no se pudo restaurar. Tus datos anteriores se conservan.' };
  }
  const copy = notice.safetyCopy ? ` El estado anterior quedó en ${notice.safetyCopy}.` : '';
  return { tone: 'info', text: `Copia restaurada: ${notice.summary ? backupContents(notice.summary) : 'datos recuperados'}.${copy}` };
}

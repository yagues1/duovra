import { describe, expect, it } from 'vitest';
import { backupContents, restoreConfirmBody, restoreNoticeText, type BackupSummary } from './backups';

const summary: BackupSummary = { createdAt: Date.UTC(2026, 10, 20, 12, 0), appVersion: '1.0.1', projects: 1, conversations: 1, messages: 2, backgrounds: 0 };

describe('backupContents', () => {
  it('usa singular y plural y enumera el contenido', () => {
    expect(backupContents(summary)).toBe('1 proyecto, 1 conversación y 2 mensajes');
    expect(backupContents({ ...summary, projects: 3, conversations: 12, messages: 340, backgrounds: 2 })).toBe(
      '3 proyectos, 12 conversaciones, 340 mensajes y 2 fondos personalizados',
    );
    expect(backupContents({ ...summary, backgrounds: 1 })).toContain('1 fondo personalizado');
  });
});

describe('restoreConfirmBody', () => {
  it('explica la copia previa y que nada cambia hasta confirmar', () => {
    const body = restoreConfirmBody(summary);
    expect(body).toContain('Duovra 1.0.1');
    expect(body).toContain('carpeta de datos (backups)');
    expect(body).toContain('no se modifican');
  });

  it('indica una fecha desconocida sin inventarla', () => {
    expect(restoreConfirmBody({ ...summary, createdAt: null, appVersion: null })).toContain('con fecha desconocida');
  });
});

describe('restoreNoticeText', () => {
  it('muestra la restauración con la ubicación del estado anterior', () => {
    const notice = restoreNoticeText({ status: 'restored', at: 0, summary, safetyCopy: 'C:/datos/backups/antes.duovra' });
    expect(notice.tone).toBe('info');
    expect(notice.text).toContain('C:/datos/backups/antes.duovra');
  });

  it('muestra los fallos como error sin ocultar que los datos se conservan', () => {
    const notice = restoreNoticeText({ status: 'failed', at: 0, error: 'La copia no se restauró: dañada. Tus datos actuales se conservan.' });
    expect(notice).toEqual({ tone: 'error', text: 'La copia no se restauró: dañada. Tus datos actuales se conservan.' });
  });
});

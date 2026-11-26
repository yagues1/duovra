import { describe, expect, it } from 'vitest';
import { normalizeError } from './agentErrors';

const withDetail = (friendly: string, detail: string) => `${friendly}\n\nDetalle del proveedor: ${detail}`;

describe('errores normalizados', () => {
  it('conserva el error original aparte y ofrece acciones según el caso', () => {
    const e = normalizeError(withDetail('Se alcanzó un límite de uso del proveedor. Consulta los límites antes de volver a intentarlo.', 'You have hit your usage limit (429)'));
    expect(e.kind).toBe('usageLimit');
    expect(e.detail).toBe('You have hit your usage limit (429)');
    expect(e.summary).not.toContain('429');
    expect(e.actions).toEqual(['limits', 'model', 'agent']);
  });

  it('distingue los casos principales', () => {
    expect(normalizeError('La sesión del proveedor no está disponible. Comprueba la cuenta en Ajustes y vuelve a iniciar sesión.').kind).toBe('authRequired');
    expect(normalizeError('La sesión del proveedor caducó. Vuelve a iniciar sesión en Ajustes.').kind).toBe('sessionExpired');
    expect(normalizeError(withDetail('El proveedor no admite el modelo seleccionado. Actualiza el catálogo y elige un modelo disponible.', 'model_not_found')).kind).toBe('modelUnavailable');
    expect(normalizeError('El proveedor no pudo conectarse. Comprueba la red antes de volver a intentarlo.').kind).toBe('connection');
    expect(normalizeError('Una herramienta quedó bloqueada por los permisos o la política vigente.').kind).toBe('toolBlocked');
    expect(normalizeError('La versión instalada de la CLI no admite esta operación. Actualízala o revisa la compatibilidad.').kind).toBe('cliIncompatible');
    expect(normalizeError('Codex no confirmó la intervención.').kind).toBe('uncertainDelivery');
    expect(normalizeError('Algo raro').kind).toBe('unknown');
    expect(normalizeError(`Algo\n\nProvider detail: x`).detail).toBe('x');
  });

  it('ninguna acción reintenta sola ni cambia de proveedor automáticamente', () => {
    for (const raw of ['429', 'model not found', 'connection reset', 'expired session token', '']) {
      const e = normalizeError(raw);
      expect(e.actions).not.toContain('autoRetry' as never);
    }
  });
});

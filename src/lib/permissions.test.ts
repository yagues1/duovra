import { describe, expect, it } from 'vitest';
import type { Conversation } from './types';
import { globalPermissions, permissionsFor, riskOf } from './permissions';

const conv = (permissionPrefs: Conversation['permissionPrefs']): Conversation => ({
  id: 'c', projectId: 'p', title: 't', createdAt: 0, updatedAt: 0, lastAgent: null, lastModel: null, lastEffort: null,
  draft: '', permissionPrefs,
});

describe('permisos del compositor', () => {
  it('parte de los ajustes globales de Duovra', () => {
    expect(globalPermissions('claude', {})).toEqual({ mode: 'manual' });
    expect(globalPermissions('codex', {})).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
    expect(globalPermissions('claude', { 'claude.permissionMode': 'plan' })).toEqual({ mode: 'plan' });
  });

  it('guarda por conversación y agente sin mezclar proveedores', () => {
    const c = conv({ claude: { mode: 'acceptEdits' }, codex: { sandbox: 'read-only', approval: 'untrusted' } });
    expect(permissionsFor(c, 'claude', {})).toEqual({ mode: 'acceptEdits' });
    expect(permissionsFor(c, 'codex', {})).toEqual({ sandbox: 'read-only', approval: 'untrusted' });
    // Lo elegido para Claude no se traslada a Codex.
    expect(permissionsFor(conv({ claude: { mode: 'bypassPermissions' } }), 'codex', {})).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
  });

  it('ignora valores desconocidos y vuelve al ajuste global', () => {
    expect(permissionsFor(conv({ claude: { mode: 'inventado' } }), 'claude', { 'claude.permissionMode': 'plan' })).toEqual({ mode: 'plan' });
    expect(permissionsFor(conv({ codex: { sandbox: 'x', approval: 'never' } }), 'codex', {})).toEqual({ sandbox: 'workspace-write', approval: 'never' });
  });

  it('distingue sandbox y aprobación al valorar el riesgo', () => {
    expect(riskOf('codex', { sandbox: 'workspace-write', approval: 'on-request' })).toBe('safe');
    expect(riskOf('codex', { sandbox: 'workspace-write', approval: 'never' })).toBe('reduced');
    expect(riskOf('codex', { sandbox: 'danger-full-access', approval: 'untrusted' })).toBe('danger');
    expect(riskOf('claude', { mode: 'bypassPermissions' })).toBe('danger');
    expect(riskOf('claude', { mode: 'plan' })).toBe('safe');
  });
});

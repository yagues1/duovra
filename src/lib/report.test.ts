import { describe, expect, it, vi } from 'vitest';
import worker from '../../services/bug-reports/worker';
import { confirmedReport, invalidField, issueBody, normalizeDraft, type Report } from './report';

const report: Report = {
  id: '24a65d7e-9d8b-4f42-83b2-c0af53e5c017',
  title: 'Falla @everyone',
  description: 'Ruta C:\\Users\\Demo\\app y correo demo@example.test',
  steps: 'Abrir la vista\nAuthorization: Bearer valor-de-prueba',
  expected: '',
  category: 'visual',
  consent: true,
  version: '0.1.1',
  platform: 'Windows (x86_64)',
};

function fixture() {
  const rows = new Map<string, number | null>();
  const limiter = { limit: vi.fn(async () => ({ success: true })) };
  const env: Parameters<typeof worker.fetch>[1] = {
    GITHUB_ISSUES_TOKEN: 'test-only',
    GITHUB_REPOSITORY: 'owner/repo',
    REPORT_LIMITER: limiter,
    SERVICE_LIMITER: limiter,
    CAPTURES: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    REPORTS: {
      prepare(query) {
        let args: (string | number)[] = [];
        return {
          bind(...values) { args = values; return this; },
          async run() {
            const [id] = args;
            if (query.startsWith('INSERT')) {
              if (rows.has(String(id))) return { meta: { changes: 0 } };
              rows.set(String(id), null);
            } else if (query.startsWith('UPDATE')) rows.set(String(args[1]), Number(id));
            else if (query.startsWith('DELETE')) rows.delete(String(id));
            return { meta: { changes: 1 } };
          },
          async first<T>() { return { issue_number: rows.get(String(args[0])) } as T; },
        };
      },
    },
  };
  const send = (changes = {}, headers = {}) => worker.fetch(new Request('https://worker.example.test/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    body: JSON.stringify({ ...report, ...changes }),
  }), env);
  return { send, limiter, env };
}

describe('reporte de errores', () => {
  it('valida los campos obligatorios y el consentimiento', () => {
    expect(invalidField({ ...report, steps: ' ' })).toBe('steps');
    expect(invalidField({ ...report, consent: false })).toBe('consent');
    expect(invalidField({ ...report, title: 'x'.repeat(121) })).toBe('title');
    expect(invalidField(report)).toBeUndefined();
  });

  it('sanea credenciales, menciones y datos personales comunes', () => {
    const sanitized = normalizeDraft(report);
    const body = issueBody({ ...report, ...sanitized }, '2026-11-08T10:00:00.000Z');
    expect(sanitized.title).toBe('Falla ＠everyone');
    expect(body).toContain('    Abrir la vista');
    expect(body).toContain('ID: ' + report.id);
    expect(body).not.toMatch(/valor-de-prueba|example\.test|Users\\Demo/);
  });

  it('rechaza tamaños, adjuntos inválidos y spam antes de crear un Issue', async () => {
    const { send, limiter } = fixture();
    expect((await send({ capture: 'no-es-un-jpeg' })).status).toBe(400);
    expect((await send({ capture: 'a'.repeat(1_500_000) })).status).toBe(413);
    limiter.limit.mockResolvedValue({ success: false });
    expect((await send()).status).toBe(429);
  });

  it('requiere una confirmación válida y devuelve el mismo Issue si se repite el reporte', async () => {
    const { send } = fixture();
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ number: 4 }, { status: 201 }));
    try {
      const first = await send({ extra: 'campo inesperado' });
      expect(first.status).toBe(201);
      expect(confirmedReport(await first.json(), report.id)).toBe(true);
      expect(confirmedReport({ id: report.id, issueNumber: 0 }, report.id)).toBe(false);
      const body = JSON.parse(String(upstream.mock.calls[0][1]?.body));
      expect(body.body).not.toContain('campo inesperado');
      expect((await send()).status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { upstream.mockRestore(); }
  });

  it('no confirma errores de red ni crea otro Issue si se perdió la respuesta', async () => {
    const { send } = fixture();
    const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('red'));
    try {
      expect((await send()).status).toBe(502);
      expect((await send()).status).toBe(409);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { upstream.mockRestore(); }
  });
});

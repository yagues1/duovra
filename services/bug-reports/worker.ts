import { confirmedReport, invalidField, issueBody, MAX_CAPTURE_BYTES, MAX_REPORT_BYTES, normalizeDraft, type Report } from '../../src/lib/report';

interface Env {
  GITHUB_ISSUES_TOKEN: string;
  GITHUB_REPOSITORY: string;
  REPORT_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
  SERVICE_LIMITER: Env['REPORT_LIMITER'];
  CAPTURES: {
    put(key: string, data: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
    delete(key: string): Promise<void>;
  };
  REPORTS: { prepare(query: string): Statement };
}

interface Statement {
  bind(...values: (string | number)[]): Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
const PLATFORM = /^Windows \((x86_64|x86|aarch64)\)$/;

function json(body: object, status: number) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function readReport(request: Request): Promise<Report> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let data = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REPORT_BYTES) throw new RangeError('size');
      data += decoder.decode(value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function captureBytes(capture: unknown): Uint8Array | undefined {
  if (capture === undefined) return;
  if (typeof capture !== 'string' || capture.length > Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(capture)) throw new Error('capture');
  const bytes = Uint8Array.from(atob(capture), (char) => char.charCodeAt(0));
  if (bytes.length > MAX_CAPTURE_BYTES || bytes[0] !== 255 || bytes[1] !== 216 ||
      bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('capture');
  // El cliente reexporta a JPEG. Rechaza segmentos de metadatos antes de la imagen.
  for (let i = 2; i + 3 < bytes.length;) {
    const marker = bytes[i + 1];
    const length = bytes[i + 2] * 256 + bytes[i + 3];
    if (bytes[i] !== 255 || length < 2 || i + 2 + length >= bytes.length ||
        (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) throw new Error('capture');
    if (marker === 0xda) return bytes;
    i += 2 + length;
  }
  throw new Error('capture');
}

async function handle(request: Request, env: Env) {
  if (new URL(request.url).pathname !== '/report') return json({ error: 'route' }, 404);
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'type' }, 415);
  if (Number(request.headers.get('Content-Length')) > MAX_REPORT_BYTES) return json({ error: 'size' }, 413);
  if (!env.GITHUB_ISSUES_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) return json({ error: 'setup' }, 503);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return json({ error: 'client' }, 400);
  const limits = await Promise.all([env.REPORT_LIMITER.limit({ key: `ip:${ip}` }), env.SERVICE_LIMITER.limit({ key: 'service' })]);
  if (limits.some(({ success }) => !success)) return json({ error: 'rate' }, 429);

  let report: Report;
  let capture: Uint8Array | undefined;
  try {
    const raw = await readReport(request);
    if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id) ||
        typeof raw.version !== 'string' || raw.version.length > 64 || !VERSION.test(raw.version) ||
        typeof raw.platform !== 'string' || !PLATFORM.test(raw.platform) || invalidField(raw)) {
      return json({ error: 'fields' }, 400);
    }
    report = { ...normalizeDraft(raw), id: raw.id, version: raw.version, platform: raw.platform };
    // El saneamiento también puede cambiar la longitud.
    if (invalidField(report)) return json({ error: 'fields' }, 400);
    capture = captureBytes(raw.capture);
  } catch (error) {
    return error instanceof RangeError ? json({ error: 'size' }, 413) : json({ error: 'content' }, 400);
  }

  const date = new Date().toISOString();
  const claim = await env.REPORTS.prepare('INSERT OR IGNORE INTO reports (id, created_at) VALUES (?, ?)').bind(report.id, date).run();
  if (!claim.meta.changes) {
    const existing = await env.REPORTS.prepare('SELECT issue_number FROM reports WHERE id = ?')
      .bind(report.id).first<{ issue_number: number | null }>();
    if (existing?.issue_number) return json({ id: report.id, issueNumber: existing.issue_number }, 200);
    return json({ error: 'pending' }, 409);
  }

  const key = `reports/${report.id}.jpg`;
  const releaseClaim = async () => {
    if (capture) await env.CAPTURES.delete(key);
    await env.REPORTS.prepare('DELETE FROM reports WHERE id = ? AND issue_number IS NULL').bind(report.id).run();
  };
  if (capture) {
    try {
      await env.CAPTURES.put(key, capture, { httpMetadata: { contentType: 'image/jpeg' } });
    } catch {
      await releaseClaim();
      return json({ error: 'capture' }, 503);
    }
  }

  // Si se pierde la respuesta de GitHub, se conserva la reserva para evitar duplicados.
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'duovra-reports',
    },
    body: JSON.stringify({ title: report.title, body: issueBody(report, date, !!capture) }),
  });
  if (response.status !== 201) {
    if (response.status >= 400 && response.status < 500) await releaseClaim();
    return json({ error: 'upstream' }, 502);
  }
  const created = await response.json() as { number?: number };
  const receipt = { id: report.id, issueNumber: created.number };
  if (!confirmedReport(receipt, report.id)) return json({ error: 'upstream' }, 502);
  await env.REPORTS.prepare('UPDATE reports SET issue_number = ? WHERE id = ?').bind(receipt.issueNumber, report.id).run();
  return json(receipt, 201);
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch {
      return json({ error: 'unconfirmed' }, 502);
    }
  },
};

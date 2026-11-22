// Servidor de pruebas local. No crea Issues ni utiliza credenciales.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

const [dir, installer, version = '0.1.2'] = process.argv.slice(2);
if (!dir || !installer) throw new Error('Uso: distribution-server.mjs <certificados> <instalador firmado> [versión]');
const origin = 'https://127.0.0.1:17443';
const bytes = readFileSync(installer);
const signature = readFileSync(installer + '.sig', 'utf8').trim();
const invalidPath = join(dir, 'invalid-setup.exe');
const invalidSignature = readFileSync(invalidPath + '.sig', 'utf8').trim();
const corrupted = Buffer.from(bytes);
corrupted[corrupted.length - 1] ^= 1;
let mode = 'current';
const receipts = new Set();

createServer({
  cert: readFileSync(join(dir, 'localhost.pem')),
  key: readFileSync(join(dir, 'localhost.key')),
}, async (req, res) => {
  function json(status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  const url = new URL(req.url, origin);
  if (url.pathname === '/qa' && req.method === 'POST') {
    mode = url.searchParams.get('mode') ?? 'current';
    return json(200, { mode });
  }
  if (url.pathname === '/latest.json') {
    console.log('Manifiesto QA:', mode);
    if (mode === 'current') { res.writeHead(204).end(); return; }
    if (mode === 'metadata') return json(200, { version: 'incorrecta' });
    return json(200, {
      version: mode === 'older' ? '0.1.0' : mode === 'version' ? '9.9.9' : version,
      notes: 'Canal local de QA. Instalador de prueba firmado con una clave efímera.',
      platforms: { [mode === 'architecture' ? 'windows-aarch64' : 'windows-x86_64']: { url: origin + (mode === 'installer-failure' ? '/invalid-setup.exe' : '/qa-setup.exe?fixture=' + mode),
        signature: mode === 'installer-failure' ? invalidSignature : signature } },
    });
  }
  if (url.pathname === '/invalid-setup.exe') {
    const data = readFileSync(invalidPath);
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' });
    res.end(data);
    return;
  }
  if (url.pathname === '/qa-setup.exe') {
    const fixture = url.searchParams.get('fixture');
    console.log('Instalador QA:', fixture);
    if (fixture === 'download-error') { res.writeHead(503).end(); return; }
    const data = fixture === 'signature' ? corrupted : bytes;
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' });
    const start = 0;
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(offset + 160_000, data.length);
      res.write(data.subarray(offset, next));
      offset = next;
      if (fixture === 'interrupted' && offset < data.length) { res.destroy(); return; }
      if (offset === data.length) { clearInterval(timer); res.end(); }
    }, 45);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (url.pathname === '/report' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_500_000) return json(413, { error: 'size' });
      chunks.push(chunk);
    }
    if (mode === 'report-unavailable') return json(503, { error: 'setup' });
    const report = JSON.parse(Buffer.concat(chunks).toString());
    if (!report.consent || report.description.includes('example.test')) return json(400, { error: 'report' });
    if (mode === 'report-error' && report.capture) {
      receipts.add(report.id);
      req.socket.destroy();
      return;
    }
    if (!receipts.has(report.id)) return json(400, { error: 'report' });
    return json(200, { id: report.id, issueNumber: 42 });
  }
  json(404, {});
}).listen(17443, '127.0.0.1', () => console.log('Canal de QA disponible en ' + origin));

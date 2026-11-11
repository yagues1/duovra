// Servidor de pruebas local. No crea Issues ni utiliza credenciales.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

const [dir, installer, version = '0.1.2'] = process.argv.slice(2);
if (!dir || !installer) throw new Error('Uso: distribution-server.mjs <certificados> <instalador firmado> [versión]');
const origin = 'https://127.0.0.1:17443';
const bytes = readFileSync(installer);
const signature = readFileSync(installer + '.sig', 'utf8').trim();
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
    if (mode === 'current') { res.writeHead(204).end(); return; }
    return json(200, {
      version: mode === 'older' ? '0.1.0' : mode === 'version' ? '0.1.9' : version,
      notes: 'Canal local de QA. Instalador de prueba firmado con una clave efímera.',
      platforms: { 'windows-x86_64': { url: origin + '/qa-setup.exe', signature } },
    });
  }
  if (url.pathname === '/qa-setup.exe') {
    if (mode === 'download-error') { res.writeHead(503).end(); return; }
    const data = mode === 'signature' ? corrupted : bytes;
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' });
    const start = 0;
    let offset = start;
    const timer = setInterval(() => {
      const next = Math.min(offset + 160_000, data.length);
      res.write(data.subarray(offset, next));
      offset = next;
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
    const report = JSON.parse(Buffer.concat(chunks).toString());
    if (mode === 'report-error') {
      receipts.add(report.id);
      req.socket.destroy();
      return;
    }
    if (!receipts.has(report.id) || !report.consent || !report.capture || report.description.includes('example.test')) {
      return json(400, { error: 'report' });
    }
    return json(201, { id: report.id, issueNumber: 42 });
  }
  json(404, {});
}).listen(17443, '127.0.0.1', () => console.log('Canal de QA disponible en ' + origin));

// Compara el front compilado actualmente en dist con la referencia exacta de Beta 2.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'output', 'qa', 'background');
const reference = 'e3c0e84';
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(out, 'bundle-'));
const source = join(work, 'source');
const tar = join(work, 'source.tar');
const nodeOptions = { cwd: root, stdio: 'inherit', windowsHide: true };

function sizes(directory) {
  const names = readdirSync(directory, { recursive: true }).filter((name) => statSync(join(directory, name)).isFile());
  const assets = names.map((name) => ({ name, size: statSync(join(directory, name)).size }));
  const subset = (where) => assets.filter((asset) => where(asset.name)).reduce((sum, { size }) => sum + size, 0);
  const gzip = (where) => assets.filter((asset) => where(asset.name)).reduce((sum, { name }) => sum + gzipSync(readFileSync(join(directory, name))).length, 0);
  const js = (name) => name.endsWith('.js');
  const entry = (name) => /^index-.+\.js$/.test(basename(name));
  const worker = (name) => /^field\.worker-.+\.js$/.test(basename(name));
  return {
    total: subset(() => true), js: subset(js), jsGzip: gzip(js),
    entry: subset(entry), entryGzip: gzip(entry), worker: subset(worker), workerGzip: gzip(worker),
    thumbnails: subset((name) => /^backgrounds[\\/]/.test(name)),
  };
}

try {
  mkdirSync(source);
  execFileSync('git', ['archive', '--format=tar', '-o', tar, reference], nodeOptions);
  execFileSync('tar', ['-xf', tar, '-C', source], nodeOptions);
  symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'), 'junction');
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { ...nodeOptions, cwd: source });
  const before = sizes(join(source, 'dist'));
  const after = sizes(join(root, 'dist'));
  assert(before.entry > 0 && after.entry > 0, 'Faltan archivos de entrada de Vite');
  const delta = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key]]));
  const report = { reference, unit: 'bytes', before, after, delta };
  writeFileSync(join(out, 'bundle.json'), JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  if (dirname(realpathSync(work)) === realpathSync(out) && basename(work).startsWith('bundle-')) {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

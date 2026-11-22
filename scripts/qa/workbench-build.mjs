// Compila un ejecutable portable de QA con identidad y actualizador aislados.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'output', 'qa', 'workbench');
const target = join(out, 'target');
const app = join(out, 'app');
const env = { ...process.env, CARGO_TARGET_DIR: target, VITE_DUOVRA_QA: '0' };
delete env.STUDIO_REPORT_ENDPOINT;
delete env.STUDIO_QA_TLS_CERT_PEM;

const result = spawnSync(process.execPath, ['scripts/tauri.mjs', 'build', '--ci', '--no-bundle', '--config', 'scripts/qa/workbench-tauri.json'], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, 'No se pudo compilar el ejecutable QA');
const release = join(target, 'release');
const executable = join(app, 'Duovra Workbench QA.exe');
mkdirSync(app, { recursive: true });
copyFileSync(join(release, 'duovra.exe'), executable);
const loader = join(release, 'WebView2Loader.dll');
if (existsSync(loader)) copyFileSync(loader, join(app, 'WebView2Loader.dll'));
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(app, 'THIRD_PARTY_NOTICES.md'));
copyFileSync(join(root, 'LICENSE'), join(app, 'LICENSE.txt'));
copyFileSync(join(root, 'public', 'licenses', 'Visual-effects-MIT.txt'), join(app, 'Visual-effects-MIT.txt'));
console.log(executable);

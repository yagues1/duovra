// Compila un ejecutable portable de QA de la mejora 1.0.0 Beta 2 con identidad y perfil propios
// (dev.duovra.studio.qa.beta2). No toca la instalación ni el perfil de la beta personal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'output', 'qa', 'beta2');
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target');
const app = join(out, 'app');
const env = { ...process.env, CARGO_TARGET_DIR: target, VITE_DUOVRA_QA: '0' };
delete env.STUDIO_REPORT_ENDPOINT;
delete env.STUDIO_QA_TLS_CERT_PEM;

const result = spawnSync(process.execPath, ['scripts/tauri.mjs', 'build', '--ci', '--no-bundle', '--config', 'scripts/qa/beta2-tauri.json', '--', '--locked'], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, 'No se pudo compilar el ejecutable QA');
const release = join(target, 'release');
const executable = join(app, 'Duovra Beta 2 QA.exe');
mkdirSync(app, { recursive: true });
const { mainBinaryName } = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
copyFileSync(join(release, (mainBinaryName ?? 'duovra') + '.exe'), executable);
const loader = join(release, 'WebView2Loader.dll');
if (existsSync(loader)) copyFileSync(loader, join(app, 'WebView2Loader.dll'));
console.log(executable);

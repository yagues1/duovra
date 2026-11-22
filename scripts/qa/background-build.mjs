// Ejecutable portable, con identidad independiente de las betas instaladas.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target');
const app = join(root, 'output', 'qa', 'background-polish', 'app');
const env = { ...process.env, CARGO_TARGET_DIR: target, VITE_DUOVRA_QA: '0' };
for (const name of ['STUDIO_REPORT_ENDPOINT', 'STUDIO_QA_TLS_CERT_PEM', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_CONFIG']) delete env[name];

const result = spawnSync(process.execPath, [
  'scripts/tauri.mjs', 'build', '--ci', '--no-bundle', '--config', 'scripts/qa/background-tauri.json', '--', '--locked',
], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'No se pudo compilar el ejecutable QA');

mkdirSync(app, { recursive: true });
const release = join(target, 'release');
const base = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const executable = join(app, 'Duovra Fondos QA.exe');
copyFileSync(join(release, `${base.mainBinaryName}.exe`), executable);
const loader = join(release, 'WebView2Loader.dll');
if (existsSync(loader)) copyFileSync(loader, join(app, basename(loader)));
for (const license of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'public/licenses/Visual-effects-MIT.txt', 'public/licenses/Background-image-codecs.txt']) {
  copyFileSync(join(root, license), join(app, basename(license)));
}
console.log(executable);

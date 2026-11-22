// Build portable con identidad, datos y actualizador aislados.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const insights = process.argv.includes('--agent-insights');
const visual = process.argv.includes('--visual-previews');
const interactive = process.argv.includes('--interactive-views');
const rc1 = process.argv.includes('--rc1');
const variant = rc1 ? 'rc1' : interactive ? 'interactive-views' : visual ? 'visual-previews' : insights ? 'agent-insights' : 'execution-queue';
const out = join(root, 'output', 'qa', variant);
const app = join(out, 'app');
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target');
const env = { ...process.env, CARGO_TARGET_DIR: target, VITE_DUOVRA_QA: '0' };
delete env.STUDIO_REPORT_ENDPOINT;
delete env.STUDIO_QA_TLS_CERT_PEM;
delete env.TAURI_SIGNING_PRIVATE_KEY;
delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
delete env.TAURI_CONFIG;
const result = spawnSync(process.execPath, [
  'scripts/tauri.mjs', 'build', '--ci', ...(rc1 ? ['--bundles', 'nsis'] : ['--no-bundle']),
  '--config', `scripts/qa/${variant}-tauri.json`, '--', '--locked',
], { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'No se pudo compilar el ejecutable QA');
mkdirSync(app, { recursive: true });
const release = join(target, 'release');
const base = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const executable = join(app, rc1 ? 'Duovra 0.6.0 RC1 QA.exe' : interactive ? 'Duovra Interactive Views QA.exe' : visual ? 'Duovra Visual Previews QA.exe' : insights ? 'Duovra Agent Insights QA.exe' : 'Duovra Execution Queue QA.exe');
copyFileSync(join(release, (rc1 ? 'duovra' : base.mainBinaryName ?? 'duovra') + '.exe'), executable);
const loader = join(release, 'WebView2Loader.dll');
if (existsSync(loader)) copyFileSync(loader, join(app, 'WebView2Loader.dll'));
const notices = ['THIRD_PARTY_NOTICES.md', 'LICENSE', 'public/licenses/Visual-effects-MIT.txt'];
if (visual || interactive || rc1) notices.push('public/licenses/Mermaid-MIT.txt', 'public/licenses/parse5-MIT.txt');
for (const license of notices) {
  copyFileSync(join(root, license), join(app, license.split('/').at(-1)));
}
console.log(executable);
if (rc1) {
  const installer = 'Duovra RC1 QA_0.6.0-rc.1_x64-setup.exe';
  copyFileSync(join(release, 'bundle', 'nsis', installer), join(out, installer));
  console.log(join(out, installer));
}

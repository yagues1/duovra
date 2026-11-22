// Empaqueta la distribución de Windows. Solo escribe artefactos locales.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyNotices, windowsCargoPackages } from './dependency-notices.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const config = readJson('src-tauri/tauri.conf.json');
const lock = readJson('package-lock.json');
const { version, identifier, productName, mainBinaryName } = config;
assert(process.platform === 'win32' && process.arch === 'x64', 'Se requiere Windows x64');
assert.match(version, /^\d+\.\d+\.\d+$/);
for (const value of [readJson('package.json').version, lock.version, lock.packages[''].version]) {
  assert.equal(value, version);
}
const cargoPackage = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8');
assert.equal(/^version = "([^"]+)"\r?$/m.exec(cargoPackage)?.[1], version);
assert.equal(/^name = "duovra"\r?\nversion = "([^"]+)"\r?$/m.exec(cargoLock)?.[1], version);
assert.equal(config.bundle.createUpdaterArtifacts, false);
assert.deepEqual(config.plugins.updater.endpoints, []);

const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, ...options });
const git = (...args) => run('git', args, { encoding: 'utf8' }).trim();
const source = { commit: git('rev-parse', 'HEAD'), modified: !!git('status', '--porcelain') };
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target');
mkdirSync(join(root, 'output'), { recursive: true });
const work = mkdtempSync(join(root, 'output', 'release-stage-'));
const notices = join(work, 'DEPENDENCY-NOTICES.txt');
const cargoPackages = windowsCargoPackages(root);
writeFileSync(notices, dependencyNotices(root, cargoPackages));
const webview2 = cargoPackages.find((pkg) => pkg.name === 'webview2-com-sys');
assert(webview2, 'No se encontró webview2-com-sys en el grafo de Windows');
const loader = join(work, 'WebView2Loader.dll');
const loaderBytes = readFileSync(join(dirname(webview2.manifest_path), 'x64', 'WebView2Loader.dll'));
// Microsoft WebView2 SDK 1.0.3800.47, cubierto por los avisos de redistribución.
assert.equal(
  createHash('sha256').update(loaderBytes).digest('hex'),
  '86545b66cdb0603bc26b626fb9ad610cb6e71f28d468f5ea66df23b03dda96d5',
  'WebView2Loader.dll no coincide con el SDK documentado',
);
writeFileSync(loader, loaderBytes);
const overlay = join(work, 'tauri.notices.json');
const resources = {
  ...config.bundle.resources,
  [relative(join(root, 'src-tauri'), notices)]: 'DEPENDENCY-NOTICES.txt',
  [relative(join(root, 'src-tauri'), loader)]: 'WebView2Loader.dll',
};
writeFileSync(overlay, JSON.stringify({ bundle: { resources } }));
const excluded = /^(?:TAURI_SIGNING_.*|TAURI_CONFIG|STUDIO_REPORT_ENDPOINT|STUDIO_QA_TLS_CERT_PEM|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.test(name)));
Object.assign(env, { CARGO_TARGET_DIR: target, DUOVRA_RELEASE_BUILD: '1', VITE_DUOVRA_QA: '0' });
assert(!env.CARGO_BUILD_TARGET, 'Usa el toolchain nativo x64 sin CARGO_BUILD_TARGET');
run(process.execPath, ['scripts/tauri.mjs', 'build', '--ci', '--no-sign', '--bundles', 'nsis', '--config', relative(root, overlay), '--', '--locked'], {
  env, stdio: 'inherit',
});

const release = join(target, 'release');
const executable = join(release, mainBinaryName + '.exe');
for (const file of [executable, loader]) {
  const image = readFileSync(file);
  const pe = image.readUInt32LE(0x3c);
  assert.equal(image.toString('ascii', pe, pe + 4), 'PE\x00\x00');
  assert.equal(image.readUInt16LE(pe + 4), 0x8664, 'El binario debe ser x64');
}

const base = `${productName}-${version}`;
const directory = join(root, 'output', 'distribution', base);
const installerName = base + '-windows-x64-setup.exe';
const portableName = base + '-windows-x64-portable.zip';
mkdirSync(directory, { recursive: true });
const portable = join(work, 'portable');
mkdirSync(portable);
copyFileSync(executable, join(portable, mainBinaryName + '.exe'));
for (const [sourcePath, destination] of Object.entries(resources)) {
  cpSync(resolve(root, 'src-tauri', sourcePath), join(portable, destination), { recursive: true });
}
writeFileSync(join(portable, 'PORTABLE.txt'), [
  `${productName} ${version} for Windows x64`,
  '',
  `Extract the full ZIP and keep WebView2Loader.dll beside ${mainBinaryName}.exe.`,
  'Microsoft Edge WebView2 Evergreen Runtime and at least one signed-in provider CLI',
  'are required for agent use. Nothing needs to run from the source checkout.',
  `Duovra stores its profile in %APPDATA%\\${identifier} and shares it with the installed app.`,
  'Close other editions before switching and back up the profile before upgrading.',
  'Windows may show a SmartScreen warning because the application is unsigned.',
  '',
].join('\n'));

const archive = join(work, portableName);
run('tar.exe', ['-a', '-cf', archive, '-C', portable, '.'], { stdio: 'inherit' });
copyFileSync(join(release, 'bundle', 'nsis', `${productName}_${version}_x64-setup.exe`), join(directory, installerName));
copyFileSync(archive, join(directory, portableName));
const checksums = [installerName, portableName].map((name) => {
  const hash = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
  return `${hash}  ${name}`;
});
writeFileSync(join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
writeFileSync(join(directory, 'build.json'), JSON.stringify({ version, identifier, source }, null, 2) + '\n');
console.log(directory);

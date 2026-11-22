// Empaqueta la distribución de Windows. Solo escribe artefactos locales.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyNotices, windowsCargoPackages } from './dependency-notices.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const unsigned = process.argv[2] === '--unsigned';
assert(process.argv.length === (unsigned ? 3 : 2), 'Uso: build:windows [--unsigned]');
const reportEndpoint = 'https://duovra-bug-reports.duovra.workers.dev/report';
const releases = 'https://github.com/yagues1/duovra/releases';
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
assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.deepEqual(config.plugins.updater.endpoints, [releases + '/latest/download/latest.json']);
assert.equal(config.plugins.updater.requireSignedVersion, true);
const publicKey = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8');
const publicKeyBytes = Buffer.from(publicKey.trim().split(/\r?\n/).at(-1), 'base64');
assert(publicKey.startsWith('untrusted comment: ') && publicKeyBytes.length === 42, 'Falta la clave pública de Tauri');
if (!unsigned) assert(process.env.TAURI_SIGNING_PRIVATE_KEY, 'Falta TAURI_SIGNING_PRIVATE_KEY para firmar la distribución');

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
writeFileSync(overlay, JSON.stringify({
  bundle: { resources, createUpdaterArtifacts: !unsigned },
  ...(unsigned && { plugins: { updater: { pubkey: '', endpoints: [] } } }),
}));
const excluded = /^(?:TAURI_SIGNING_.*|TAURI_CONFIG|STUDIO_REPORT_ENDPOINT|STUDIO_QA_TLS_CERT_PEM|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS)$/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.test(name)));
Object.assign(env, { CARGO_TARGET_DIR: target, DUOVRA_RELEASE_BUILD: '1', VITE_DUOVRA_QA: '0' });
if (!unsigned) {
  env.STUDIO_REPORT_ENDPOINT = reportEndpoint;
  env.TAURI_SIGNING_PRIVATE_KEY = process.env.TAURI_SIGNING_PRIVATE_KEY;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
}
assert(!env.CARGO_BUILD_TARGET, 'Usa el toolchain nativo x64 sin CARGO_BUILD_TARGET');
run(process.execPath, ['scripts/tauri.mjs', 'build', '--ci', ...(unsigned ? ['--no-sign'] : []), '--bundles', 'nsis', '--config', relative(root, overlay), '--', '--locked'], {
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
const destination = join(root, 'output', 'distribution', base + (unsigned ? '-unsigned' : ''));
const directory = join(work, 'packages');
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
const installer = join(release, 'bundle', 'nsis', `${productName}_${version}_x64-setup.exe`);
copyFileSync(installer, join(directory, installerName));
copyFileSync(archive, join(directory, portableName));
const assets = [installerName, portableName];
if (!unsigned) {
  const signature = readFileSync(installer + '.sig', 'utf8').trim();
  const signatureText = Buffer.from(signature, 'base64').toString('utf8');
  const [, encodedSignature, trustedComment, encodedCommentSignature] = signatureText.trim().split(/\r?\n/);
  const signatureBytes = Buffer.from(encodedSignature, 'base64');
  const commentPrefix = 'trusted comment: ';
  assert(signatureBytes.length === 74 && signatureBytes.toString('ascii', 0, 2) === 'ED'
    && signatureBytes.subarray(2, 10).equals(publicKeyBytes.subarray(2, 10)),
    'La firma no corresponde a la clave pública integrada');
  assert(trustedComment?.startsWith(commentPrefix) && trustedComment.split(/\s/).includes(`version:${version}`),
    'La firma debe incluir la versión de esta release');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBytes.subarray(10).toString('base64url') }, format: 'jwk' });
  const hash = createHash('blake2b512').update(readFileSync(installer)).digest();
  const messageSignature = signatureBytes.subarray(10);
  const signedComment = Buffer.concat([messageSignature, Buffer.from(trustedComment.slice(commentPrefix.length))]);
  assert(verify(null, hash, key, messageSignature) &&
    verify(null, signedComment, key, Buffer.from(encodedCommentSignature, 'base64')),
    'La firma de Tauri y su versión deben ser verificables con la clave pública integrada');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const notes = changelog.split(`\n## ${version}\n`)[1]?.split(/^## /m)[0].trim();
  assert(notes, 'Faltan las notas de esta versión en CHANGELOG.md');
  writeFileSync(join(directory, 'notes.md'), notes + '\n');
  writeFileSync(join(directory, installerName + '.sig'), signature + '\n');
  writeFileSync(join(directory, 'latest.json'), JSON.stringify({
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature, url: `${releases}/download/v${version}/${installerName}` } },
  }, null, 2) + '\n');
  assets.push(installerName + '.sig', 'latest.json');
}
const checksums = assets.map((name) => {
  const hash = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
  return `${hash}  ${name}`;
});
writeFileSync(join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
writeFileSync(join(directory, 'build.json'), JSON.stringify({ version, identifier, source }, null, 2) + '\n');
cpSync(directory, destination, { recursive: true });
console.log(destination);

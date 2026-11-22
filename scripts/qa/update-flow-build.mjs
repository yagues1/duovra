import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const base = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const directory = resolve('output/qa/distribution');
const current = base.version;
const versionParts = current.split('.').map(Number);
versionParts[2]++;
const next = versionParts.join('.');
const productName = 'Duovra Distribution QA';
const mainBinaryName = 'duovra-distribution-qa';
const identifier = 'dev.duovra.studio.qa.distribution';
const origin = 'https://127.0.0.1:17443';

assert.equal(process.platform, 'win32');
mkdirSync(directory, { recursive: true });
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(TAURI_CONFIG|TAURI_SIGNING_.*|STUDIO_REPORT_ENDPOINT|STUDIO_QA_TLS_CERT_PEM)$/i.test(name)) delete env[name];
}
const run = (program, args, processEnv = env, stdio = 'inherit') => {
  const result = spawnSync(program, args, { env: processEnv, stdio });
  if (result.status !== 0) throw result.error ?? new Error(`${program} terminó con código ${result.status}`);
};
const openssl = process.env.DUOVRA_QA_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
const ca = join(directory, 'ca.pem');
const cert = join(directory, 'localhost.pem');
const serverKey = join(directory, 'localhost.key');
const caKey = join(directory, 'ca.key');
if (!existsSync(cert)) {
  const csr = join(directory, 'localhost.csr');
  const extensions = join(directory, 'localhost.ext');
  writeFileSync(extensions, 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-subj', '/CN=Duovra QA CA', '-keyout', caKey, '-out', ca]);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', serverKey, '-out', csr]);
  run(openssl, ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-out', cert, '-days', '30', '-extfile', extensions]);
}

const tauri = (args, processEnv = env, stdio = 'inherit') =>
  run(process.execPath, ['scripts/tauri.mjs', ...args], processEnv, stdio);
const signingKey = join(directory, 'qa-updater.key');
const signingPassword = 'duovra-local-test-fixture';
if (!existsSync(signingKey)) {
  // El generador puede imprimir la clave privada incluso si la escribe en disco.
  tauri(['signer', 'generate', '--ci', '-p', signingPassword, '-w', signingKey], env, 'ignore');
}
const pubkey = readFileSync(signingKey + '.pub', 'utf8').trim();
const target = resolve(env.CARGO_TARGET_DIR ?? 'src-tauri/target');
Object.assign(env, {
  CARGO_TARGET_DIR: target,
  CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS ?? '3',
  DUOVRA_RELEASE_BUILD: '1',
  VITE_DUOVRA_QA: '0',
  STUDIO_QA_TLS_CERT_PEM: readFileSync(ca, 'utf8'),
  TAURI_SIGNING_PRIVATE_KEY: signingKey,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
});
const invalidInstaller = join(directory, 'invalid-setup.exe');
writeFileSync(invalidInstaller, 'Instalador inválido para probar el rechazo de Windows.');
tauri(['signer', 'sign', '--app-version', next, invalidInstaller], env);
const release = join(target, 'release');
for (const version of [next, current]) {
  const overlay = join(directory, `tauri-${version}.json`);
  const testingCurrent = version === current;
  writeFileSync(overlay, JSON.stringify({
    productName, mainBinaryName, identifier, version,
    app: { windows: [{ ...base.app.windows[0], title: productName }] },
    bundle: { createUpdaterArtifacts: !testingCurrent },
    plugins: { updater: { pubkey, endpoints: [origin + '/latest.json'] } },
  }));
  const buildEnv = { ...env, STUDIO_REPORT_ENDPOINT: origin + '/report' };
  // El actualizador usa un canal HTTPS local y solamente instala el producto de QA.
  tauri(['build', '--ci', '--features', 'qa-loopback', '--bundles', 'nsis', '--config', overlay, '--', '--locked'], buildEnv);
  const installer = join(release, 'bundle', 'nsis', `${productName}_${version}_x64-setup.exe`);
  const name = join(directory, `qa-${version}-setup.exe`);
  copyFileSync(installer, name);
  if (!testingCurrent) copyFileSync(installer + '.sig', name + '.sig');
}
writeFileSync(join(directory, 'build.json'), JSON.stringify({ current, next, productName, mainBinaryName, identifier }, null, 2));

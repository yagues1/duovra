import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.env.STUDIO_RELEASE_VERSION ?? '';
const repository = process.env.STUDIO_UPDATE_REPOSITORY ?? '';
const publicKey = process.env.STUDIO_UPDATER_PUBLIC_KEY?.trim() ?? '';
const source = process.env.STUDIO_SOURCE_REPOSITORY ?? '';
const out = 'output/release';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const npm = JSON.parse(readFileSync('package.json', 'utf8'));
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync('src-tauri/Cargo.toml', 'utf8'))?.[1];
const changelog = readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
const [, notes = ''] = changelog.split(`## ${version}\n`, 2);
const body = notes.split(/^## /m)[0].trim();

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    [config.version, npm.version, cargo].some((value) => value !== version) || !body) {
  throw new Error('La versión debe ser SemVer estable, coincidir en Tauri, Cargo y npm y tener notas.');
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || source)) {
  throw new Error('Configura el repositorio GitHub de distribución (owner/name).');
}
const keyText = Buffer.from(publicKey, 'base64').toString('utf8');
if (!keyText.startsWith('untrusted comment: ') || Buffer.from(keyText.trim().split('\n').at(-1), 'base64').length !== 42) {
  throw new Error('Configura el contenido de la clave pública generada por Tauri.');
}
const releases = `https://github.com/${repository || source}/releases`;

switch (process.argv[2]) {
  case 'configure':
    if (process.env.STUDIO_HAS_SIGNING_KEY !== 'true') throw new Error('Falta el secreto de firma de Tauri.');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'tauri.signed.json'), JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: publicKey, endpoints: [`${releases}/latest/download/latest.json`] } },
    }));
    break;
  case 'manifest': {
    const name = `${config.productName}_${version}_x64-setup.exe`;
    const installer = join('src-tauri/target/release/bundle/nsis', name);
    const signature = readFileSync(`${installer}.sig`, 'utf8').trim();
    if (!signature) throw new Error('Falta la firma del instalador.');
    const assets = join(out, 'assets');
    mkdirSync(assets, { recursive: true });
    copyFileSync(installer, join(assets, name));
    copyFileSync(`${installer}.sig`, join(assets, `${name}.sig`));
    writeFileSync(join(assets, 'notes.md'), body + '\n');
    writeFileSync(join(assets, 'latest.json'), JSON.stringify({
      version, notes: body, pub_date: new Date().toISOString(),
      platforms: { 'windows-x86_64': { signature, url: `${releases}/download/v${version}/${name}` } },
    }, null, 2));
    break;
  }
  default:
    throw new Error('Uso: release-config.mjs configure | manifest');
}

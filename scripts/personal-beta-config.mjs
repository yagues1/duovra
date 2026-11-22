import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const { identifier } = config;
const version = '1.0.0-beta.2';
// Lee el nombre histórico de los artefactos de Beta 2 cuando están disponibles.
const distribution = join(root, 'output', 'distribution');
const directory = process.env.DUOVRA_BETA2_ARTIFACTS
  ? resolve(process.env.DUOVRA_BETA2_ARTIFACTS)
  : (readdirSync(distribution, { withFileTypes: true, throwIfNoEntry: false }) ?? [])
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-' + version))
    .map((entry) => join(distribution, entry.name))
    .find((path) => existsSync(join(path, 'portable'))) ?? join(distribution, 'Duovra-' + version);
const portable = join(directory, 'portable');
const installerSuffix = `_${version}_x64-setup.exe`;
const installerName = (readdirSync(directory, { throwIfNoEntry: false }) ?? [])
  .find((name) => name.endsWith(installerSuffix));
const productName = installerName?.slice(0, -installerSuffix.length);
const portableName = (readdirSync(portable, { throwIfNoEntry: false }) ?? []).find((name) => name.endsWith('.exe'));

// Regresión sobre otra build QA aislada (por ejemplo, la revisión de patrones): con DUOVRA_QA_TARGET_EXE,
// las suites en modo --personal-beta usan ese ejecutable, su identidad, su variable de perfil
// desechable y su carpeta de salida. Sin la variable, todo sigue apuntando a la beta.
const target = process.env.DUOVRA_QA_TARGET_EXE;
if (target && !(process.env.DUOVRA_QA_TARGET_IDENTIFIER && process.env.DUOVRA_QA_TARGET_PROFILE_VARIABLE && process.env.DUOVRA_QA_TARGET_OUTPUT)) {
  throw new Error('DUOVRA_QA_TARGET_EXE requiere DUOVRA_QA_TARGET_IDENTIFIER, DUOVRA_QA_TARGET_PROFILE_VARIABLE y DUOVRA_QA_TARGET_OUTPUT');
}

export const beta = {
  identifier: target ? process.env.DUOVRA_QA_TARGET_IDENTIFIER : identifier,
  productName, version, directory, portable, installerName,
  executable: target ? resolve(target) : join(portable, portableName ?? 'duovra.exe'),
  installer: join(directory, installerName ?? 'installer.exe'),
  qa: target ? resolve(process.env.DUOVRA_QA_TARGET_OUTPUT) : join(root, 'output', 'qa', 'personal-beta', version),
  profileVariable: target ? process.env.DUOVRA_QA_TARGET_PROFILE_VARIABLE : 'DUOVRA_BETA_TEST_PROFILE',
};

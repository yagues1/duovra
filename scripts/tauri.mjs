// Envoltorio de la CLI de Tauri para Windows.
//
// Con el toolchain x86_64-pc-windows-gnu, un MinGW externo con hilos MCF puede aportar
// un crt2.o que no enlaza con la biblioteca estándar de Rust
// (`undefined reference to __MCF_cxa_atexit`). Si el host es GNU, forzamos el enlazador
// autocontenido que distribuye rustup. Con un toolchain MSVC no se cambia nada.
//
// Además añade ~/.cargo/bin al PATH del proceso (rustup se instaló sin modificar el PATH global).
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin};${env.PATH ?? env.Path ?? ''}`;
delete env.Path;

try {
  const vv = execFileSync('rustc', ['-vV'], { env, encoding: 'utf8' });
  const host = /host: (\S+)/.exec(vv)?.[1] ?? '';
  const gnu = host.endsWith('windows-gnu');
  if (gnu) {
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { env, encoding: 'utf8' }).trim();
    const linker = join(sysroot, 'lib', 'rustlib', host, 'bin', 'self-contained', 'x86_64-w64-mingw32-gcc.exe');
    if (existsSync(linker)) {
      env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ??= linker;
      env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS ??= '-C link-self-contained=yes';
    }
  }
  if (env.DUOVRA_RELEASE_BUILD === '1') {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const flags = [
      `--remap-path-prefix=${homedir()}=/build-user`,
      `--remap-path-prefix=${resolve(env.CARGO_HOME ?? join(homedir(), '.cargo'))}=/cargo`,
      `--remap-path-prefix=${resolve(root)}=/duovra`,
    ];
    if (gnu) flags.push('-C', 'link-self-contained=yes');
    env.CARGO_ENCODED_RUSTFLAGS = flags.join('\x1f');
  }
} catch {
  console.error('No se encontró rustc. Instala Rust con rustup: https://rustup.rs');
  process.exit(1);
}

const args = process.argv.slice(2);
const r = spawnSync('npx', ['tauri', ...args], { env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);

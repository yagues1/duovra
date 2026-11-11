// Envoltorio de la CLI de Tauri para Windows.
//
// Motivo: en este equipo Rust usa el toolchain x86_64-pc-windows-gnu y en el PATH hay un MinGW con
// hilos MCF (C:\mingw64) cuyo crt2.o no enlaza con la biblioteca estándar de Rust
// (`undefined reference to __MCF_cxa_atexit`). Si el host es GNU, forzamos el enlazador
// autocontenido que distribuye rustup. Con un toolchain MSVC no se cambia nada.
//
// Además añade ~/.cargo/bin al PATH del proceso (rustup se instaló sin modificar el PATH global).
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env };
const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin};${env.PATH ?? env.Path ?? ''}`;
delete env.Path;

try {
  const vv = execFileSync('rustc', ['-vV'], { env, encoding: 'utf8' });
  const host = /host: (\S+)/.exec(vv)?.[1] ?? '';
  if (host.endsWith('windows-gnu')) {
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { env, encoding: 'utf8' }).trim();
    const linker = join(sysroot, 'lib', 'rustlib', host, 'bin', 'self-contained', 'x86_64-w64-mingw32-gcc.exe');
    if (existsSync(linker)) {
      env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ??= linker;
      env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS ??= '-C link-self-contained=yes';
    }
  }
} catch {
  console.error('No se encontró rustc. Instala Rust con rustup: https://rustup.rs');
  process.exit(1);
}

const args = process.argv.slice(2);
const r = spawnSync('npx', ['tauri', ...args], { env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);

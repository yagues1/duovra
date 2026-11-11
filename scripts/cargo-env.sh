# Uso: source scripts/cargo-env.sh  (Git Bash). Mismo ajuste que scripts/tauri.mjs para cargo directo.
export PATH="$HOME/.cargo/bin:$PATH"
_host=$(rustc -vV | sed -n 's/^host: //p')
if [[ "$_host" == *windows-gnu ]]; then
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$(rustc --print sysroot)/lib/rustlib/$_host/bin/self-contained/x86_64-w64-mingw32-gcc.exe"
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="-C link-self-contained=yes"
fi

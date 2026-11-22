# Revisión de glib en Duovra 1.0.0

Revisión del 21 de noviembre de 2026. Base Git `cd3f25f` de `feature/1.0.0-background-customization`. La candidata examinada declara la versión `1.0.0-beta.2`.

## A. Origen

Dependabot señaló `src-tauri/Cargo.lock` en la versión pública 0.5.1. El aviso afecta a `glib::VariantStrIter` en versiones desde 0.15.0 hasta antes de 0.20.0. GitHub asigna una severidad moderada de 6,9. RustSec clasifica el mismo aviso como `unsound` y fija 0.20.0 como primera versión corregida. [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) · [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)

## B. Resolución actual

El [manifiesto de Rust](../../src-tauri/Cargo.toml) usa Tauri 2 con sus *features* predeterminadas. El [lockfile](../../src-tauri/Cargo.lock) resuelve Tauri 2.12.5 y una sola copia de `glib`, **0.18.5** de crates.io. Esa copia cae dentro del intervalo afectado. SHA-256 del lockfile inspeccionado, idéntico en la base y en la rama de trabajo:

```text
f3fef9b62fe24f22b96429bce27331b48091ee68ec71b7a9e359ef0eefda8c13
```

## C. Grafo y uso

Rutas principales observadas con `cargo tree --locked -i glib@0.18.5 --target all` y con el target Linux:

```text
duovra → tauri 2.12.5 → gtk 0.18.2 → glib 0.18.5
duovra → tauri 2.12.5 → webkit2gtk 2.0.2 → glib 0.18.5
duovra → tauri 2.12.5 → tauri-runtime-wry 2.12.3 → wry 0.57.1 → webkit2gtk 2.0.2 → glib 0.18.5
```

`tauri-runtime`, `tao` y `muda` también introducen GTK en esos targets. `gio`, `gdk`, `soup3` y otros bindings comparten la misma copia de `glib`. La feature predeterminada `wry` de Tauri habilita su runtime. Los manifiestos resueltos de Tauri/Wry limitan GTK y WebKitGTK a Linux y los BSD indicados abajo.

En Linux y BSD el iterador afectado está disponible como API de la dependencia compilada. La búsqueda de referencias directas en Duovra y las fuentes Rust disponibles del grafo Linux no demuestra alcanzabilidad en ejecución. La revisión se limita a resolución e inspección estática. En Windows ninguna ruta de la aplicación puede llamar a la copia afectada, porque el target excluye el crate.

## D. Plataformas

| Target | Resultado de `cargo tree --locked -i glib@0.18.5 --target …` | Distribución configurada |
| --- | --- | --- |
| `x86_64-pc-windows-msvc` | Sin ruta a `glib`. El grafo contiene `webview2-com 0.39.1`. | CI y publicación de Windows x64 |
| `x86_64-pc-windows-gnu` | Sin ruta a `glib`. | Toolchain local del portable de QA |
| `x86_64-unknown-linux-gnu` | `glib 0.18.5` por GTK/WebKitGTK. | Linux ejecuta tareas de CI del frontend y de publicación, sin binario Linux |
| FreeBSD, NetBSD, OpenBSD y DragonFly x64 | `glib 0.18.5` por GTK/WebKitGTK. | Sin artefactos configurados |
| macOS x64 y arm64 | Sin ruta a `glib`. | Sin artefactos configurados |

La [configuración de Tauri](../../src-tauri/tauri.conf.json) define un instalador NSIS. El [workflow de CI actual](../../.github/workflows/ci.yml) compila en Windows con Cargo `--locked`.

## E. Auditoría Rust

`cargo-audit 0.23.0` revisó 521 paquetes frente a 1555 avisos de RustSec. Salió con código 0 y clasificó **0 entradas como vulnerabilidad y 6 como avisos**. La base consultada fue `55e1c3dfbd834237a05bbbf7b50ba3b5be27b662`. La clasificación `unsound` de RustSec conserva el hallazgo de `glib` aunque el contador de vulnerabilidades sea cero. [Versión de cargo-audit](https://github.com/rustsec/rustsec/releases/tag/cargo-audit%2Fv0.23.0) · [Base de avisos](https://github.com/RustSec/advisory-db/commit/55e1c3dfbd834237a05bbbf7b50ba3b5be27b662)

| Aviso | Paquete | Origen y alcance comprobado |
| --- | --- | --- |
| [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) · `unsound` | `glib 0.18.5` | GTK/WebKitGTK en Linux y BSD. Corregido a partir de 0.20.0. |
| [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) · `unmaintained` | `proc-macro-error 1.0.4` | Dependencia de compilación de `glib-macros` y `gtk3-macros` en el grafo GTK. Su sustitución requiere cambios upstream en esas macros. |
| [RUSTSEC-2026-0371](https://rustsec.org/advisories/RUSTSEC-2026-0371.html), [RUSTSEC-2026-0370](https://rustsec.org/advisories/RUSTSEC-2026-0370.html) y [RUSTSEC-2026-0372](https://rustsec.org/advisories/RUSTSEC-2026-0372.html) · `unmaintained` | `zbus_names 4.3.5`, `zvariant 5.15.1` y su macro `zvariant_derive 5.15.1` | Rama Linux/BSD de `tauri-plugin-opener 2.7.2` a través de `zbus 5.19.0`. La auditoría omite un rango corregido para esos avisos. Una migración de `zbus` de major requiere que el plugin la soporte. |
| [RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543.html) · `unmaintained` | `chrono 0.4.45` | Dependencia opcional de `serde_with 3.24.0` registrada en el lockfile. Sin ruta ni siquiera con `--target all` para las features activadas por Duovra. |

Los seis paquetes señalados se excluyen de ambos grafos Windows x64 y del grafo macOS arm64 inspeccionado. La auditoría cubre avisos conocidos en la base consultada y no certifica la seguridad del código ni de la plataforma.

Evidencia local en `output/qa/background-polish/security/`: `cargo-audit.json`, `cargo-tree.txt` y `compatibilidad.txt`. Comandos de reproducción desde el proyecto:

```powershell
cargo audit --no-fetch --db <copia-de-advisory-db> --json --file src-tauri/Cargo.lock
cargo tree --manifest-path src-tauri/Cargo.toml --locked -i glib@0.18.5 --target all
cargo tree --manifest-path src-tauri/Cargo.toml --locked -i glib@0.18.5 --target x86_64-pc-windows-msvc
cargo tree --manifest-path src-tauri/Cargo.toml --locked -i glib@0.18.5 --target x86_64-unknown-linux-gnu
```

## F. Decisión

Caso B para Windows y caso D para Linux/BSD. `gtk 0.18.2` y `webkit2gtk 2.0.2` requieren `glib ^0.18`. Las versiones estables más recientes consultadas, Tauri 2.12.7, tauri-runtime-wry 2.12.5 y Wry 0.57.3, siguen seleccionando GTK 0.18 y WebKitGTK 2.0. `gtk 0.19.0` y `webkit2gtk 3.0.0` ya dependen de `glib 0.22`, pero quedan fuera de esas restricciones. Una actualización aislada del lockfile resulta insuficiente. [Tauri 2.12.7](https://crates.io/crates/tauri/2.12.7) · [Wry 0.57.3](https://crates.io/crates/wry/0.57.3) · [Seguimiento en Tauri](https://github.com/tauri-apps/tauri/issues/12048) · [Seguimiento en Wry](https://github.com/tauri-apps/wry/issues/1474)

La resolución de Rust se conserva. La alerta histórica de GitHub y la rama de 0.5.1 quedaron fuera de esta revisión.

## G. Conclusión

**¿La futura Duovra 1.0.0 para Windows x64 contiene la vulnerabilidad GHSA-wrw7-89jp-8q8g?**

**No afecta a Windows, pero permanece en otro target.** Los grafos Windows x64 excluyen `glib`. Linux y BSD mantienen la versión vulnerable 0.18.5.

## H. Preparación del lanzamiento

La revisión no identificó un impedimento de dependencias Rust para seguir preparando el lanzamiento Windows x64 con este lockfile y estas features. Repite la auditoría sobre el lockfile final antes de publicarlo. Una futura distribución Linux/BSD requiere una decisión separada sobre el riesgo residual y una resolución comprobada con una pila upstream compatible que elimine las copias afectadas.

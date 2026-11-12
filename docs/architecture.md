# Arquitectura

Aplicación de escritorio local para Windows: **Tauri 2** (backend Rust) + **React 19 / TypeScript** (WebView2). No hay servidor remoto ni servicio de coordinación entre agentes: el usuario elige a mano qué agente responde cada mensaje.

```
┌──────────────────────────── Interfaz (src/) ─────────────────────────────┐
│ components/shell      Barra superior, controles de ventana, fondo        │
│ components/sidebar    Árbol de proyectos y conversaciones                │
│ components/chat       Mensajes, cronología, aprobaciones, Markdown       │
│ components/composer   Cuadro de escritura, agente/modelo/razonamiento    │
│ components/panel      Panel de consulta (archivo, diff, terminal)        │
│ components/projects   Gestión de proyectos                               │
│ components/settings   Ajustes                                            │
│ state/store.ts        Estado (Zustand) y manejo de eventos de ejecución  │
│ lib/                  IPC tipado, eventos, diff, formato, resaltado      │
│ styles/               Tokens, capas CSS, componentes                     │
└───────────────▲──────────────────────────────────┬───────────────────────┘
        evento `run-event`                  comandos `invoke`
┌───────────────┴──────────── Backend (src-tauri/src/) ────────────────────┐
│ commands.rs     API expuesta a la interfaz                               │
│ db.rs           SQLite (rusqlite, bundled): proyectos, conversaciones,   │
│                 mensajes, sesiones de proveedor, ajustes, cuentas, uso   │
│ agents/mod.rs   Capa común: ejecuciones, cronología normalizada,         │
│                 permisos, cancelación, persistencia                      │
│ agents/context.rs  Contexto compartido entre agentes                     │
│ agents/codex.rs    Adaptador Codex App Server (JSON-RPC por stdio)       │
│ agents/claude.rs   Adaptador Claude Code (`claude -p`, stream-json)      │
│ detect.rs       Detección de las CLIs instaladas                         │
└──────────────────────────────────────────────────────────────────────────┘
```

## Flujo de un mensaje

1. `send_message` valida que no haya otra ejecución en la conversación, guarda el mensaje del usuario (con agente, modelo y esfuerzo) y un mensaje de asistente en estado `running`.
2. Se calcula el contexto compartido (ver abajo) y se lanza el adaptador del proveedor.
3. El adaptador traduce el protocolo del proveedor a elementos normalizados (`text`, `reasoning`, `command`, `file_change`, `tool`, `web_search`, `plan`, `notice`, `diff`) y emite `run-event` (`item`, `delta`, `output`, `approval`, `usage`, `session`, `finished`).
4. La interfaz agrupa los deltas por fotograma (`lib/events.ts`) para no renderizar por token.
5. Al terminar, el backend guarda el contenido, la cronología, el estado, el consumo y la referencia de sesión del proveedor. El progreso se guarda cada 1,5 s durante la ejecución.
6. Si la aplicación se cierra con una ejecución activa, al abrirla se marca como interrumpida (el proceso del agente terminó con ella). La sesión del proveedor se conserva y el siguiente mensaje la reanuda.

## Contexto compartido entre agentes

Cada proveedor mantiene su propia sesión interna (hilo de Codex, sesión de Claude Code); la aplicación no afirma que sean equivalentes. Por conversación y agente se guarda `provider_sessions(session_id, last_seq)`:

- Si el agente elegido ya tiene sesión, solo recibe los intercambios posteriores a `last_seq` (los que gestionó el otro agente).
- Si no tiene sesión (o no se puede reanudar), recibe el historial previo.
- El bloque se envía una sola vez, en `<conversation_context>`, empezando por lo más reciente y con un presupuesto de ~36 000 caracteres; cada mensaje se recorta por el centro. Indica qué agente y modelo produjo cada respuesta, y resume archivos cambiados y comandos.
- El mensaje del usuario guarda una nota (`contextNote`) que la interfaz muestra: «Contexto compartido: N mensajes de Codex».

Pruebas: `agents::context::tests` (Rust).

## Permisos

- **Codex**: las peticiones del servidor `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` e `item/permissions/requestApproval` se muestran como tarjetas y se responden con `accept`, `acceptForSession` o `decline`. La política de aprobación y el sandbox se configuran en Ajustes → Agentes y se aplican también a hilos ya cargados.
- **Claude Code**: con `--permission-prompts host`, la CLI envía `control_request` `can_use_tool`; se responde `allow`/`deny` (y `updatedPermissions` con las sugerencias de la CLI para «Permitir en esta sesión»). El modo (`manual`, `acceptEdits`, `plan`…) se elige en Ajustes.
- Al cancelar, las solicitudes pendientes se rechazan para que el agente no quede esperando.

## Rendimiento visual

- `backdrop-filter` solo en superficies flotantes: barra lateral, compositor, panel derecho, menús y diálogos. Las burbujas usan rellenos semitransparentes sin desenfoque.
- Animaciones con `transform`/`opacity` (Motion). Excepciones conscientes: el ancho de la barra lateral y del panel derecho se anima con un muelle al abrir/cerrar (una vez por acción).
- Fondo: aurora WebGL de un solo shader (`src/lib/aurora.ts`) a media resolución y 24–30 fps, pausada con la ventana oculta y estática en *Reducida*. El mismo shader curva el fondo en los cantos de las superficies de cristal y la luz ambiental se lee con `readPixels` de 1 px unas tres veces por segundo (`src/lib/optics.ts`). Sin WebGL, capas SVG estáticas.
- Vista de archivos en bloques de 200 líneas con `content-visibility: auto`.
- Tres niveles de intensidad por tokens (`[data-intensity]`); el automático mide fps periódicamente y baja un nivel si hay dos muestras seguidas < 45 fps. `prefers-reduced-motion` fuerza «reducida».

## Capas CSS

Tailwind v4 usa capas (`base`, `components`, `utilities`). Las clases propias están en `@layer components` y las reglas de elementos en `@layer base`, para que las utilidades de Tailwind prevalezcan. (Una clase propia sin capa anulaba utilidades como `fixed`: los menús aparecían fuera de pantalla.)

## Compilación en este equipo

Rust usa el toolchain `x86_64-pc-windows-gnu` (sin MSVC Build Tools). El MinGW del PATH (`C:\mingw64`, hilos MCF) no enlaza con la biblioteca estándar de Rust, así que `scripts/tauri.mjs` y `scripts/cargo-env.sh` fuerzan el enlazador autocontenido de rustup. Con un toolchain MSVC no cambian nada. El crate se compila solo como `rlib` (la variante `cdylib`, para móvil, supera el límite de exportaciones de `ld`). El manifiesto de Windows (Common Controls v6) se incrusta con `embed-resource` en todos los binarios, incluidos los de prueba. `build.rs` declara `icons/icon.ico` como dependencia: tauri-build no recompilaba el recurso cuando solo cambiaba el icono.

# Session Manager (1.0.11, fase 3)

Bifurcar, editar, regenerar, importar, organizar y exportar conversaciones sin añadir paneles
permanentes. La complejidad está en el motor; la interfaz son menús contextuales y diálogos compactos.

Código: `src-tauri/src/db/sessions.rs` (bifurcación, importación y organización en SQLite),
`src-tauri/src/importer.rs` (lectura de sesiones externas), `agents/mod.rs` · `codex.rs` · `claude.rs`
(continuación nativa), `export.rs` (formatos), `src/components/sessions/` (diálogos y acciones).

## Bifurcar

«Bifurcar desde aquí» (menú contextual del mensaje) crea una conversación con identificador propio que
conserva:

- Los mensajes hasta el elegido, incluido, con sus adjuntos y referencias (identificadores nuevos).
- Las preferencias de agente, modelo, razonamiento, permisos y contexto.
- La memoria compartida **tal como era en ese punto**: de `memory_revisions` se toma la última revisión
  de cada recuerdo con `anchor_seq` ≤ corte. Ediciones y archivados posteriores no se heredan; los
  recuerdos eliminados (retiradas) tampoco. El archivado ahora ancla su revisión al punto actual de la
  conversación (antes conservaba el ancla de la última edición, lo que reconstruía mal un punto anterior).
- `origin = { kind: "fork", purpose, conversationId, title, messageId, seq, native }`.

No copia la cola de ejecución, las intervenciones, las sesiones nativas ni las entregas de memoria. Las
copias de mensajes conservan su actividad, pero `run_insights.duplicate = 1`: no cuentan dos veces en
Estadísticas. La original no se modifica. Bifurcar no restaura archivos (el diálogo lo indica); no hay
checkpoints.

### Continuación nativa (`origin.native.<agente>`)

Para cada agente que participó antes del corte se decide al bifurcar:

| Estado | Significado |
| --- | --- |
| `pending` | Bifurcación nativa posible: sesión de origen, punto exacto (`anchor`), `lastSeq` y cuenta |
| `rebuild` | Se reconstruirá con Context Engine 2.0. `reason`: `workdir`, `compacted`, `noAnchor`, `noSession` |
| `native` / `rebuilt` | Resolución real en el primer envío a ese agente (con la sesión creada o el motivo) |

Al primer envío, si la conversación aún no tiene sesión de ese agente y la cuenta activa es la misma:

- **Codex 0.169.0**: `thread/fork { threadId, lastTurnId, cwd, approvalPolicy, sandbox, excludeTurns }`.
  `lastTurnId` es inclusivo (esquema generado con `codex app-server generate-ts`). Admite otro `cwd`.
- **Claude Code 2.1.325**: `--resume <origen> --fork-session --resume-session-at <uuid>`. La opción
  `--resume-session-at` está oculta en `--help`, pero es la que usa el Agent SDK oficial y existe en el
  binario instalado. El `uuid` es el último elemento de la transcripción del turno, que ahora se guarda
  en `run_insights.details.nativeAnchor`. Antes de usarla se comprueba que la transcripción existe y
  contiene ese elemento. Solo en el mismo directorio: Claude Code guarda las sesiones por carpeta.

La sesión de origen **nunca se reanuda** desde la copia: solo se bifurca, así dos conversaciones no
escriben en el mismo hilo nativo. Con la bifurcación confirmada se registra la sesión nueva con
`last_seq = lastSeq` (lo que el hilo bifurcado contiene); las entregas de memoria empiezan vacías y la
memoria se reenvía una vez. Si falla, se crea una sesión nueva reconstruida y el mensaje lo indica.
Otra cuenta nunca se usa para bifurcar: se reconstruye (`otherAccount`).

Mensajes anteriores a esta fase no tienen `nativeAnchor` de Claude Code: se reconstruyen.

## Editar y regenerar

- «Editar mensaje» (mensajes del usuario): bifurca **antes** del mensaje y deja el texto editado y los
  adjuntos que siguen existiendo como borrador. No se envía nada ni se consume nada.
- «Regenerar respuesta» (respuestas): bifurca antes del mensaje del usuario que la originó, con su texto
  como borrador y el mismo agente preseleccionado; el usuario puede elegir el otro en el compositor. Si la
  respuesta original modificó archivos o ejecutó comandos, el diálogo lo advierte y ofrece un worktree.
  Nunca se envía sola.

## Worktrees

El diálogo ofrece continuar en el mismo directorio (predeterminado), crear un worktree nuevo (el diálogo
y las comprobaciones de la 1.0.9, con `onCreated`) o usar uno existente (o el directorio principal). No se
copian dependencias, secretos ni archivos ignorados.

## Importar sesiones externas

Menú del proyecto → «Importar sesiones…». Proveedor, cuenta, búsqueda, vista previa y selección; carga
bajo demanda y paginada.

- **Codex**: `thread/list` (paginado, `searchTerm`), `thread/read` (metadatos) y `thread/turns/list`
  (`itemsView: full`; respaldo `thread/read` con turnos). Se importan los textos de usuario
  (`userMessage`, con imágenes locales como adjuntos) y de respuesta (`agentMessage`); estado del turno.
  El modelo por mensaje no consta en los turnos: se deja vacío (el del hilo queda en `origin.meta`).
- **Claude Code**: la CLI no ofrece listar ni leer sesiones por el transporte actual y no se introduce
  otro SDK. Se leen en modo lectura solo `<config>/projects/<carpeta>/<sesión>.jsonl` de la cuenta
  elegida (identificador validado como UUID). Rama activa por `parentUuid`; sin ramas laterales,
  mensajes internos, resultados de herramientas, razonamiento ni comandos locales. Modelo del mensaje si
  consta. Título: `custom-title`, `summary` o el primer mensaje.
- `imported_sessions (agent, session_id)` impide duplicados; también se rechaza una sesión que Duovra
  ya usa como sesión nativa. Al eliminar la conversación importada se puede volver a importar.
- Continuar: «Bifurcar la sesión nativa» (recomendado; la original no se toca y no hay conflicto si sigue
  abierta en otra aplicación) o «Reconstruir el contexto en Duovra». Claude Code desde otra carpeta se
  reconstruye.

## Organización

Menú de la conversación: Fijar/Desfijar, Archivar/Desarchivar, Ir a la conversación original, Exportar.
Las fijadas van primero en su espacio; las archivadas salen de la lista (menú del proyecto →
«Conversaciones archivadas…») sin perder mensajes, memoria, sesiones ni referencias. Icono discreto para
bifurcadas e importadas, con la procedencia en la información emergente.

## Recuperación

Reutiliza la del Context Engine 2.0 (sesión no disponible → sesión nueva reconstruida, marcada como tal;
entregas inciertas reenviadas con aviso de duplicados y sin repetir tareas; ejecuciones interrumpidas al
reiniciar en revisión). Se amplía con la bifurcación nativa como primera opción en copias e importaciones
y su caída a reconstrucción, sin cambiar de cuenta ni de proveedor y sin elevar permisos.

## Exportar

«Exportar conversación…»: Markdown, JSON (`format: "duovra.conversation"`, `version: 1`: mensajes con
agente, modelo, razonamiento, estado y adjuntos; memoria; procedencia sin identificadores nativos), HTML
autónomo (todo escapado, CSP `default-src 'none'`) y memoria resumida local. Adjuntos opcionales: se
copian a `<nombre> - adjuntos/` (máx. 50 MB cada uno). Nunca credenciales, cuentas, sesiones nativas ni
salidas de herramientas.

## Migración (aditiva)

`conversations.pinned_at`, `archived_at`, `origin` (`'{}'`) y la tabla `imported_sessions`. Sin cambio de
`user_version`. Comprobada con la base QA de la fase 2.

## Verificación

1. `cargo test --lib` y `npx vitest run`.
2. App QA aislada (perfil `dev.duovra.studio.qa.agents`, CDP 9333) y
   `node scripts/qa/session-manager-webview.mjs <carpeta> [--real]`. Con `--real`: 6 turnos breves
   (Claude Code haiku/medium ×3, Codex gpt-6-luna/high ×3) en modo manual / solo lectura.

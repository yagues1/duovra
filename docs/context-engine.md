# Context Engine 2.0 (1.0.11, fase 2)

Contexto compartido entre Claude Code y Codex: persistente, transparente, configurable y bajo control del
usuario. El usuario sigue eligiendo manualmente el agente de cada mensaje; no hay orquestación, llamadas
ocultas a modelos, fallbacks de proveedor ni servicios externos.

## Capas

| Capa | Contenido | Regla |
| --- | --- | --- |
| 1 · Instrucciones persistentes | Recuerdos del usuario de categoría `instruction` o `constraint` | Prioritarias. Nunca se descartan en silencio |
| 2 · Memoria compartida | Objetivos, decisiones, restricciones, estado, tareas, archivos, resultados, problemas, notas | Solo viajan las revisiones que la sesión no tiene |
| 3 · Historial reciente | Intercambios posteriores al último mensaje **confirmado** de la sesión | Atribución a usuario, agente, modelo y estado |
| 4 · Mensaje actual | Texto, adjuntos y referencias | Nunca se recorta |

El bloque (`<duovra_context>`) declara que es contexto de referencia: no concede permisos, no cambia
ajustes ni sustituye el mensaje del usuario. Los recuerdos de un agente se marcan como observaciones
del agente, separados de las instrucciones del usuario.

Código: `src-tauri/src/agents/context.rs` (motor puro y probado), `agents/shared_context.rs`
(orquestación en `Studio`), `db/memory.rs` (persistencia).

## Preferencias

- Globales (Ajustes → Contexto y memoria): `context.enabled` (compartir contexto, sí por defecto),
  `context.mode` (`auto`, `economy`, `full`) y `context.resendAfterCompaction` (volver a enviar
  instrucciones y recuerdos tras una compactación, sí por defecto).
- Por conversación (`conversations.context_prefs`): solo si eligió un modo propio (`mode`), que prevalece.
  `mode: null` vuelve al ajuste global sin borrar nada. El modo `custom` de versiones anteriores se
  conserva y sigue funcionando en el motor, pero la interfaz ya no lo ofrece.
- Desactivar el contexto compartido equivale a `off`: no se transfiere memoria ni historial.

## Presupuesto adaptable

- Sin datos del proveedor: presupuesto conservador fijo (36.000 caracteres en `auto`, como antes).
- Con ventana (`contextWindow`) **y** ocupación real (`contextTokens` de la última petición) comunicadas
  por el proveedor **en esa misma sesión**: espacio libre = ventana − ocupación − reserva de salida
  (`maxOutputTokens` o 10 % de la ventana) − mensaje actual. Cada modo toma una fracción con límites.
- Nunca se usan tokens acumulados, facturados ni la cuota de la suscripción como ocupación.
- Estimación local: 3 caracteres por token (conservadora). Sin tokenizador.
- Máximo absoluto del bloque: 160.000 caracteres. Lo prioritario que no cabe en el presupuesto se envía
  igualmente hasta ese máximo y la nota del mensaje lo avisa (`priorityOverBudget`).

## Seguimiento de entregas

Riesgo confirmado en 1.0.10: `set_session` fijaba `last_seq` al mensaje del asistente en cuanto se
conocía la sesión. En Codex eso ocurría **antes** de `turn/start`; si el turno se rechazaba, el contexto
compartido se daba por recibido sin haberlo sido. Corregido:

| Estado | Cuándo | Efecto |
| --- | --- | --- |
| Preparado | Al iniciar el envío | — |
| Enviado | Claude: prompt escrito en stdin. Codex: antes de `turn/start` | — |
| Confirmado | Claude: `message_start`, mensaje `assistant` o `result` con turnos. Codex: `turn/start` devuelve el id del turno | Avanza `last_seq` y marca las revisiones de memoria como recibidas |
| Incierto | Enviado sin confirmación al cerrar el turno | `last_seq` no avanza, `uncertain_seq` recuerda desde dónde. El siguiente turno reenvía avisando de posibles duplicados, sin repetir la tarea |
| No enviado | Codex rechazó `turn/start`, o nunca salió | Nada avanza; se vuelve a preparar |

Una sesión nueva (o de otra cuenta) empieza con `last_seq = 0`. El seguimiento es por conversación,
proveedor, sesión nativa y cuenta; la conversación fija el proyecto y el worktree.

## Memoria (SQLite, migración aditiva)

- `memories`: id, conversación, `scope` (`conversation`),
  categoría, contenido (≤ 4000), prioridad (0/1), autor (`user`/`agent`), origen
  (`manual`/`message`/`summary`), agente y modelo de origen, mensajes de origen, `anchor_seq`,
  revisión, archivado, fechas.
- `memory_revisions`: cada revisión con su `anchor_seq` (último mensaje de la conversación al guardarla).
- `memory_deliveries`: revisión recibida por cada sesión (`confirmed`, `uncertain`, `retracted`).
- Columnas nuevas: `conversations.context_prefs`, `provider_sessions.uncertain_seq` y
  `provider_sessions.native_context` (compactaciones). No cambia `user_version`.
- Archivar o eliminar un recuerdo ya entregado comunica su retirada una vez («No longer applies»).
  Eliminar uno entregado deja una retirada versionada (`deleted_at`): se oculta, pierde sus revisiones,
  conserva solo un extracto de 160 caracteres y se purga cuando todas las sesiones vigentes que lo
  recibieron confirman la retirada. Sin entregas previas, se borra en el acto. No se intenta borrar
  nada del contexto nativo del proveedor.

## Resumen y reorganización (internos)

La interfaz ya no los ofrece. Se conservan el campo `purpose`, el análisis `parseProposal` y
`memoryRequestText` para recuperación, depuración y fases siguientes.

Acción explícita: el usuario elige agente y modelo, se avisa del consumo y se envía un mensaje visible
con `purpose` (`memorySummary` o `memoryCompact`). El backend fija permisos restringidos (Codex
`read-only` + `never`; Claude Code `manual`, donde cualquier cambio pide aprobación) y nunca lo encola.
No se usa el modo plan de Claude Code: con `"model": "opusplan"` en la configuración del usuario, ese
modo cambia el modelo elegido (comprobado con 2.1.325: `init` declaraba `claude-haiku-5-5` y
`modelUsage` atribuía la petición a `claude-sonnet-5-5`). La respuesta se analiza como **datos**
(bloque `duovra-memory`), el usuario edita y elige; nada se aplica solo. Una «instrucción» propuesta por
un agente se degrada a restricción del agente. La reorganización archiva (no borra) los recuerdos
sustituidos que el usuario apruebe y no toca las instrucciones persistentes. Estos intercambios no se
transfieren como historial.

## Compactación nativa (comprobada con las versiones instaladas)

- **Codex 0.169.0**: `thread/compact/start { threadId }` responde `{}` al aceptar. La compactación real
  es un turno propio: `turn/started` → `item/started|completed` (`contextCompaction`) → `turn/completed`.
  Solo se da por completada con `turn/completed` `completed` y el elemento completado. Tras compactar,
  `thread/tokenUsage/updated` trae `last.inputTokens = 0`: la ocupación queda desconocida hasta el
  siguiente turno (no se estima). `thread/compacted` (obsoleto) no se emitió.
- **Claude Code 2.1.325**: `/compact` como mensaje stream-json con `--resume <sesión>` funciona:
  `system/status: compacting` → `compact_boundary { trigger: manual, pre_tokens, post_tokens }` →
  `result success` con `num_turns: 0`; la sesión conserva su id. Se exige `compact_boundary`.
  `post_tokens` es la ocupación comunicada tras compactar. Se lanza en modo `manual`, no `plan` (ver
  `opusplan` arriba).
- La ventana de Claude se toma de `result.modelUsage[<modelo de la última petición>]`, no del modelo de
  la sesión: pueden diferir.
- Solo con la conversación inactiva; los envíos se bloquean mientras dura. No afecta a la otra sesión,
  al historial visible ni a archivos. Tras compactar, las entregas de memoria de esa sesión se invalidan.
- Las compactaciones automáticas observadas durante un turno se registran igual.

## Interfaz

- Indicador circular junto a Enviar. Su tarjeta muestra solo el agente, el porcentaje y los tokens
  usados frente al máximo (si el proveedor los comunica; si no, estado neutral) y «Compactar contexto»,
  habilitado según el Capability Registry.
- Ajustes → Contexto y memoria: compartir contexto, modo global, compactación (gestionada por cada
  proveedor; Duovra no la lanza sola), recordar la memoria tras compactar, modo de la conversación
  abierta y acceso al gestor de memoria.
- «Fijar en memoria compartida» en el menú contextual de cada mensaje (clic derecho, tecla Menú).
- Gestor de memoria cargado bajo demanda (`ContextDialogs`, `React.lazy`), sin datos técnicos en la
  vista principal (el origen y las versiones anteriores se abren por recuerdo).
- La compactación automática nativa la gestiona cada proveedor (Codex `model_auto_compact_token_limit`,
  Claude Code `autoCompactEnabled`). No se ha verificado que pueda cambiarse de forma fiable desde el
  transporte actual sin llamadas reales, así que Duovra no la modifica.
- El estado se consulta al abrir, al cambiar de agente y al terminar un turno; nunca al escribir.

## Fase 3 (Session Manager)

Bifurcaciones, importaciones y recuperación avanzada: ver `docs/session-manager.md`.

## Verificación

1. `cargo test --lib` y `npx vitest run`.
2. App aislada (perfil `dev.duovra.studio.qa.agents`, CDP 9333) y
   `node scripts/qa/context-engine-webview.mjs <carpeta>`; con `--real`, las llamadas mínimas con los
   modelos autorizados (`docs/qa/test-model-policy.md`).
3. `node scripts/qa/context-settings-webview.mjs <carpeta>`: preferencias globales y por conversación,
   eliminación y capturas de la interfaz. No invoca modelos.

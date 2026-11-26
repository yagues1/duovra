# Registro de capacidades de los agentes (1.0.11 · fase 1)

Punto único para saber qué admite **esta** instalación de Claude Code o Codex, con la cuenta y el
modelo seleccionados. Código: `src-tauri/src/agents/capabilities.rs` (detección y caché),
`src/lib/types.ts` (`AgentCapabilities`, `Capability`), `src/lib/commands.ts` (Command Registry),
`src/components/settings/AgentCapabilities.tsx` (vista).

## Principios

- **Nada se deduce del nombre** de un modelo ni de la documentación pública. Cada capacidad lleva su
  `source` (respuesta de la CLI, lista de métodos del servidor, esquema generado por la CLI…).
- **Cuatro estados**: `supported`, `unsupported`, `experimental`, `unknown`. Sin dato fiable,
  `unknown`.
- **Cuatro niveles**: `installation`, `account`, `model`, `run`. Lo que solo se observa durante un
  turno (tareas de Claude, límites de Claude) no se afirma de antemano.
- **Proveedor frente a Duovra**: `status` describe al proveedor; `integrated` (`yes`, `partial`,
  `no`) describe a Duovra. La vista separa ambos y no presenta como disponible lo que aún no se
  integra.
- **Sin coste**: nunca se inicia un turno, se crea un hilo ni se consume cuota para detectar nada.

## Detección

| Agente | Consulta | Proceso | Cuándo |
| --- | --- | --- | --- |
| Claude Code | `control_request` · `initialize` (modelos, alias, esfuerzos, modo rápido, comandos, agentes) | `claude -p … stream-json`, se cierra al responder | Catálogo: primer acceso, caducidad, cambio de cuenta/ejecutable, «Actualizar» |
| Claude Code | `claude --help` (opciones `--resume`, `--fork-session`, modo `plan`) | corto | Una vez por binario, solo al abrir la vista de capacidades |
| Codex | `initialize`, `model/list`, `account/read` | App Server ya existente | Igual que antes |
| Codex | Sondeo `duovra/methodProbe` con parámetros de tipo inválido | mismo App Server | Una vez al arrancar el servidor. El servidor responde `unknown variant …, expected one of …` con todos los métodos que reconoce; nada se ejecuta |
| Codex | `modelProvider/capabilities/read` (solo si el servidor lo reconoce) | mismo App Server | Al abrir la vista |
| Codex | `codex app-server generate-json-schema` (esquema **estable**) en una carpeta temporal que se borra | corto (~2 s) | Una vez por binario, solo al abrir la vista |

Clasificación de Codex: un método que el servidor reconoce y está en el esquema estable es
`supported`; si lo reconoce pero no está en el esquema estable, `experimental` (requiere
`experimentalApi`, que Duovra mantiene desactivado); si no lo reconoce, `unsupported`. Las
notificaciones (`turn/plan/updated`, `thread/tokenUsage/updated`…) solo aparecen en el esquema.

## Caché

- Clave: agente + ruta, tamaño y fecha del ejecutable (cambian al actualizar la CLI) + carpeta de la
  cuenta. Cambiar de cuenta o de ejecutable usa otra entrada sin tirar las anteriores.
- Vigencia de una hora; cambiar un ajuste `agents.<agente>.*` o la cuenta activa la caduca.
- Consultas simultáneas del mismo agente se agrupan (una sola CLI a la vez por agente).
- Si una consulta falla, se devuelven los últimos datos válidos de esa cuenta con `stale: true` y el
  motivo. La interfaz los marca como «datos desactualizados»; nunca como confirmados.
- Al confirmar datos nuevos se emite `capabilitiesChanged` por `run-event`; las vistas releen la
  caché sin lanzar otra consulta. No hay sondeo en segundo plano.

## Modelos (Agent Model Engine 2.0)

`ModelInfo` añade `exact` (identificador exacto), `alias`, `upgrade`, `contextWindow` (solo si el
proveedor la informa; hoy ninguno lo hace en el catálogo) y `traits` (rasgos declarados: esfuerzo,
pensamiento adaptativo, modo automático, pensamiento desactivable, versión multiagente).

- El selector conserva la agrupación por familias, añade búsqueda a partir de 8 modelos, resume los
  niveles de razonamiento y muestra «Rápido» solo si el modelo lo declara.
- Un modelo nuevo aparece sin actualizar Duovra: todo sale del catálogo del proveedor.
- Un modelo retirado se conserva en la conversación, el selector lo indica y el envío queda
  bloqueado hasta elegir otro (el compositor ya ofrecía la sustitución explícita). La cola no cambia.
- Modelo solicitado frente al real (Detalles del turno): modelo solicitado, resolución anunciada por
  el catálogo al enviar (`catalogResolved`), modelo de la sesión, modelo comunicado en el turno y
  redirecciones (`model/rerouted`). El alias nunca se presenta como prueba del modelo usado.

## Command Registry (fundamentos)

`src/lib/commands.ts` declara `CommandSpec` (id, nombre, descripción, proveedor, capacidad, argumentos,
acción, estados de ejecución, confirmación, consumo) y tres orígenes: `local` (Duovra), `native`
(operaciones del proveedor mapeadas a una capacidad) y `custom` (comandos comunicados por la CLI).
Desde la fase 5 el menú `/` usa este registro: ver [control-center.md](control-center.md).
`mayRunWithoutConfirmation` sigue siendo falso para todo lo descubierto.

## Eventos

No hay un segundo sistema: todo sigue por `run-event` (tiempo real) y `run_insights.details`
(persistente, por mensaje, con cuenta, sesión y turno del proveedor). Atribución disponible hoy:
proyecto y worktree vía la conversación; conversación, ejecución (`runId`), cuenta (`accountId`),
agente y sesión del proveedor en los insights. Para fases siguientes:

| Necesidad | Base existente |
| --- | --- |
| Contexto y compactación | `compacted`, `lastInputTokens`, `thread/tokenUsage/updated`, `compact_boundary` |
| Solicitudes interactivas | `approval` / `PendingApproval` (mismo canal para `item/tool/requestUserInput` y AskUserQuestion) |
| Planes y tareas | `record_plan` (`turn/plan/updated`, TodoWrite, Task tools) |
| Subagentes | `subagents` en insights |
| Cambios de modelo | evento `model`, `lastRequestModel`, `reroutedFrom/To`, `catalogResolved` |
| Errores | `fail` / `finished` con mensaje |
| Cambios de capacidades | `capabilitiesChanged` (nuevo) |

## Compatibilidad real de las versiones instaladas

Obtenida el 2026-11-26 con `scripts/qa/agent-capabilities-webview.mjs` sobre la app en desarrollo
(perfil QA aislado) y las CLIs de este equipo: **Claude Code 2.1.325** (sesión iniciada, perfil de la
CLI) y **Codex CLI 0.169.0** (App Server, sesión ChatGPT). Sin mensajes a modelos.

| Capacidad | Nivel | Claude Code · proveedor | Fuente | Duovra | Codex · proveedor | Fuente | Duovra |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Respuesta en directo | instalación | Compatible | integración stream-json | Sí | Compatible | esquema · `item/agentMessage/delta` | Sí |
| Adjuntos de imágenes | modelo | Desconocida | `initialize` no informa modalidades | Sí | Compatible | `model/list` · `inputModalities` | Sí |
| Reanudar sesiones | instalación | Compatible | `--resume` | Sí | Compatible | `thread/resume` | Sí |
| Bifurcar sesiones | instalación | Compatible | `--fork-session` (+ `--resume-session-at`) | Sí (1.0.11) | Compatible | `thread/fork` (`lastTurnId`) | Sí (1.0.11) |
| Listar sesiones | instalación | Desconocida | sin método en la CLI | Parcial (lectura local) | Compatible | `thread/list` | Sí (1.0.11) |
| Leer sesiones | instalación | Desconocida | sin método en la CLI | Parcial (lectura local) | Compatible | `thread/read` · `thread/turns/list` | Sí (1.0.11) |
| Compactación | instalación | Compatible | comando `/compact` | Parcial (aviso) | Compatible | `thread/compact/start` | Parcial (aviso) |
| Planificación | instalación | Compatible | `--permission-mode plan` | Parcial | Compatible | esquema · `item/plan/delta` | Parcial |
| Preguntas interactivas | instalación | Desconocida | `initialize` no enumera herramientas | No | Compatible | esquema · `item/tool/requestUserInput` | No |
| Indicaciones durante el turno | ejecución | Desconocida | sin mecanismo comunicado | No | Compatible | `turn/steer` | Sí |
| Interrupción | ejecución | Compatible | `control_request` · interrupt | Sí | Compatible | `turn/interrupt` | Sí |
| Comandos rápidos | instalación | Compatible | `initialize.commands` (149, 57 integrados) | Parcial (1.0.11 · menú `/`) | No compatible | el App Server no publica comandos | No |
| Tareas | ejecución | Desconocida | se confirma con eventos | Sí | Compatible | esquema · `turn/plan/updated` | Sí |
| Subagentes | instalación | Compatible | `initialize.agents` | Sí | Compatible | `model/list` · `multiAgentVersion` | Sí |
| Revisión de código | instalación | Compatible | comando `/code-review` | Sí (1.0.11) | Compatible | `review/start` | Sí (1.0.11) |
| Objetivos persistentes | instalación | Compatible | comando `/goal` | No (objetivo propio de Duovra) | Compatible | `thread/goal/set` | No (inicia trabajo autónomo) |
| Información de consumo | ejecución | Compatible | evento `result` | Sí | Compatible | esquema · `thread/tokenUsage/updated` | Sí |
| Límites de uso | cuenta | Desconocida | se confirma con `rate_limit_event` | Sí | Compatible | `account/rateLimits/read` | Sí |

Otros datos reales:

- Claude Code comunica 15 modelos (14 con niveles de esfuerzo; `claude-haiku-4-5-20251001` sin
  niveles), alias `default`, `opus`, `sonnet`, `fable`, `haiku` y `opusplan` con su `resolvedModel`,
  modo rápido en `default`, `opus`, `fable`, `claude-opus-5` y `claude-opus-4-8`. Al abrir la
  conexión informa `fast_mode_state: off` con `fast_mode_disabled_reason: sdk_opt_in_required`.
  No informa ventana de contexto en el catálogo.
- Codex comunica 10 modelos sin alias (`id` = `model`), todos con niveles de razonamiento y nivel
  de servicio `priority` («Fast»), modalidades texto+imagen y `upgrade` en los 5.6. El servidor
  reconoce 187 métodos, 78 de ellos fuera del esquema estable (experimentales, no activados).
  `modelProvider/capabilities/read`: `imageGeneration` y `webSearch` verdaderos.
- Todos los métodos que la investigación previa reservaba para fases posteriores (`thread/list`,
  `thread/read`, `thread/resume`, `thread/fork`, `thread/compact/start`, `turn/steer`,
  `turn/interrupt`, `review/start`, `thread/goal/*`, `modelProvider/capabilities/read`,
  `item/tool/requestUserInput`, `turn/plan/updated`, `item/plan/delta`,
  `thread/tokenUsage/updated`) son **estables** en 0.169.0.

## Verificación

1. `cargo test --lib` y `npx vitest run`.
2. App aislada: con `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`,
   `node scripts/tauri.mjs dev --config scripts/qa/agent-experience-tauri.json` (identificador
   `dev.duovra.studio.qa.agents`, datos propios; no toca la instalación personal).
3. `node scripts/qa/agent-capabilities-webview.mjs <carpeta>`: detección, catálogos reales, caché,
   actualización deduplicada, informe de capacidades, caducidad por cambio de cuenta y datos
   desactualizados con un ejecutable que falla.

# Planning & Decisions (1.0.11, fase 4)

Duovra integra el modo plan nativo y las preguntas interactivas de Claude Code y Codex. Nada se simula con instrucciones en el mensaje: si el proveedor no comunica un plan o una pregunta por su mecanismo nativo, Duovra no muestra ninguna tarjeta.

## Modo de trabajo

- Dos modos en el compositor, junto a los permisos: **Construir** (predeterminado) y **Planificar**.
- Se guarda por conversación y agente (`conversations.work_modes`). Una conversación nueva trabaja en Construir.
- Es independiente de los permisos: cambiar de modo no los modifica y planificar nunca los eleva. «Planificar» ya no aparece en el menú de permisos de Claude Code; un ajuste antiguo `plan` vuelve a Manual.

## Claude Code 2.1.325

Mecanismo: `--permission-mode plan` y las solicitudes `control_request` (`can_use_tool`) del canal stream-json.

- **Modelo en modo plan.** La CLI sustituye el ajuste de modelo en modo plan cuando es el alias `haiku` (pide Sonnet) u `opusplan` (pide Opus), y `--model` cuenta como ese ajuste. Verificado con la CLI real contra una API simulada: `--model haiku` → `claude-sonnet-5-5`; `--model claude-haiku-5-5` → `claude-haiku-5-5`. Duovra pasa el identificador exacto del catálogo en modo plan (salvo `opusplan`, que el usuario elige por ese comportamiento) y avisa en el turno si la CLI atiende una petición con otro modelo.
- **`ExitPlanMode`.** Llega como `can_use_tool` con `input: {}`: la CLI no repite el plan. El texto está en el bloque `tool_use` del asistente, que llega antes; como respaldo, el archivo de plan dentro de `<config>/plans`. Aprobar: `allow` (y `setMode` a los permisos elegidos para Construir si no son Manual). Pedir cambios: `deny` con la petición; la CLI sigue en modo plan y vuelve a llamar a `ExitPlanMode` (nueva versión). Rechazar: `deny` y se detiene la ejecución.
- **`AskUserQuestion`.** 1-4 preguntas de 2-4 opciones, con selección individual o múltiple. Se responde con `allow` y `updatedInput.answers` (`texto de la pregunta → etiqueta`; varias separadas por comas). La CLI siempre admite una respuesta personalizada.
- **Restricciones reales del modo plan** (comprobadas con la API simulada): `Write`/`Edit` fuera del archivo de plan y las herramientas MCP sin `readOnlyHint` piden aprobación al host; `Read` se ejecuta; `Bash` y las MCP de solo lectura dependen de un control de seguridad automático de la CLI (con una clave de API se deniegan sin preguntar). **No es un sandbox estricto**: si el usuario aprueba una acción, se ejecuta. Las solicitudes de aprobación en modo plan lo indican en la tarjeta.

## Codex App Server 0.169.0 (verificado también con 0.172.0)

La 0.172.0 no cambia nada de lo que usa esta fase: `TurnStartParams`, `CollaborationMode`, `item/plan/delta`, `turn/plan/updated`, `ToolRequestUserInput*`, `thread/fork`, `thread/resume` e `InitializeCapabilities` son idénticos, y `collaborationMode` sigue exigiendo `experimentalApi`. Novedades sin uso todavía en Duovra: `thread/search/*`, `thread/realtime/list`, `modelProvider/default/set` y un `AgentMessageDisplay` con modos `show`/`hide`/`block` para el historial recuperado (afectará a la importación de sesiones, no a los turnos).


- `turn/start.collaborationMode` y `collaborationMode/list` exigen `capabilities.experimentalApi` en `initialize` (sin él: «requires experimentalApi capability»). Duovra lo activa y solo usa de esa superficie el modo plan, `item/plan/delta` e `item/tool/requestUserInput`; no activa `features.*`.
- Cada turno declara su modo (`plan` o `default`) con el modelo y el esfuerzo elegidos, porque el modo se guarda en el hilo.
- **Plan propuesto**: elemento `plan` (con `item/plan/delta`) de un turno en modo plan. El turno termina al proponerlo; la aprobación inicia un turno nuevo en modo `default`. `turn/plan/updated` es una lista de tareas de la ejecución y sigue en TurnInsights: nunca se convierte en un plan pendiente.
- **Preguntas**: `item/tool/requestUserInput` (`questions[]` con `id`, `header`, `question`, `isOther`, `isSecret`, `options`). Respuesta: `{ answers: { <id>: { answers: [..] } } }`. Codex exige opciones en todas las preguntas; la respuesta libre va por «Otra» (`isOther`). Por defecto solo se ofrece en modo plan (`default_mode_request_user_input` está en desarrollo y desactivado).
- El modo plan de Codex son instrucciones de colaboración: el sandbox y la aprobación elegidos siguen vigentes.

## Interacciones

Tabla `interactions` (SQLite). Cada plan o pregunta tiene identificador propio, versión (planes), conversación, mensaje, ejecución, agente, cuenta y sesión. `native = 1` mientras la ejecución espera la respuesta; un reinicio las marca `interrupted`.

- Responder valida las respuestas contra las opciones mostradas y usa un cambio de estado atómico: no se puede responder dos veces ni a otra ejecución. Las respuestas a preguntas secretas no se guardan.
- Cancelar una ejecución cierra sus solicitudes en el proveedor (`deny` o respuesta vacía) y las deja `cancelled`.
- Un plan nuevo deja como `superseded` el anterior pendiente; la tarjeta antigua se reduce a una línea.
- Aprobar con el otro agente: si la solicitud de Claude Code seguía abierta, se rechaza y se detiene esa ejecución antes de empezar el turno nuevo. El turno nuevo usa la selección y los permisos de ese agente en la conversación.
- La barra lateral marca «espera» en las conversaciones con planes o preguntas pendientes.

## Context Engine y Session Manager

- El estado se refleja en el elemento de la cronología (`plan_proposal`, `question`), así que el historial compartido lleva el plan con su decisión real y las preguntas con sus respuestas (sin las secretas). Un plan sin aprobar se presenta como propuesta del agente, no como instrucción del usuario. No hay llamadas adicionales a modelos ni cambios en la memoria.
- El turno que implementa un plan lleva `<approved_plan version="N">` con la versión exacta cuando la sesión que lo recibe no es la que lo propuso (otro agente o sesión reconstruida). La nota de contexto guarda `approvedPlan`.
- Bifurcar copia planes y preguntas de los mensajes copiados con identificadores nuevos; lo que estaba pendiente pasa a `historical` y no se puede responder ni aprobar.

## QA

- `scripts/qa/planning-claude-protocol.mjs`: CLI real de Claude Code contra una API simulada (sin modelos).
- `scripts/qa/planning-codex-protocol.mjs`: App Server real de Codex con un proveedor simulado (sin modelos).
- `scripts/qa/planning-mock-apis.mjs` + `scripts/qa/planning-webview.mjs`: Duovra en el perfil QA aislado con cuentas que apuntan a las APIs simuladas.

# Agent Control Center (1.0.11, fase 5)

Nombre funcional de la fase: no añade ningún panel. Todo vive en el compositor (menú `/`, botón principal,
cápsula de objetivo) y en las interfaces que ya existían (selectores, Workbench, memoria, Session Manager).

## Menú `/`

- Aparece al escribir `/` al principio del mensaje y con el cursor en esa primera palabra. Filtra al
  escribir (prefijo, alias y búsqueda difusa), se navega con flechas, Enter o Tab elige, Escape cierra y
  el ratón funciona igual. El borrador y los adjuntos se conservan.
- **Elegir nunca ejecuta nada del proveedor.** Los comandos de Duovra que solo abren una interfaz existente
  o cambian un ajuste local (modo, selectores) se aplican al elegirlos; `/compact` y `/review` abren su
  confirmación. `/stop` y los comandos del proveedor quedan **preparados** en una etiqueta del compositor y
  solo se ejecutan con un envío explícito (Enter o botón). Escape o Retroceso al principio los quitan.
- Un texto normal que empieza por `/` se envía tal cual: sin coincidencias, Enter envía el mensaje.
- Sin consulta solo se listan los comandos de Duovra compatibles con el agente, la cuenta, la conversación y
  el estado de ejecución. Los del proveedor aparecen al escribir, en su propio grupo. `/help` lista todos,
  también los no disponibles con su motivo.

## Comandos de Duovra

| Comando | Acción (reutilizada) | Consumo |
| --- | --- | --- |
| `/compact`, `/context` | Tarjeta de contexto; compactar conserva su confirmación | `/compact` sí, tras confirmar |
| `/plan`, `/build` | Modo de trabajo de la fase 4 | No |
| `/model`, `/effort`, `/fast`, `/permissions` | Selectores del compositor | No |
| `/review` | Revisión nativa (ver abajo) | Sí, tras confirmar |
| `/diff` | Workbench → cambios Git | No |
| `/fork` | Bifurcación del Session Manager desde la última respuesta | No |
| `/resume` | Importar o recuperar una sesión del agente (Session Manager) | No |
| `/new`, `/memory`, `/usage`, `/tasks`, `/status` | Conversación nueva, memoria compartida, Estadísticas, Actividad de Workbench, Ajustes → Agentes | No |
| `/stop` | Detener (la misma cancelación) | No |
| `/goal` | Editor del objetivo de la conversación | No |
| `/help` | Ayuda dentro del menú | No |

## Claude Code 2.1.325: comandos comunicados

`initialize` comunica 149 comandos (57 integrados en la CLI). Comprobado con la CLI real contra una API
simulada (`scripts/qa/control-claude-protocol.mjs`), sin modelos y sin ejecutar los 149:

| Comando | Resultado en `-p` + stream-json |
| --- | --- |
| `/context`, `/usage`, `/cost`, `/model`, `/effort`, `/goal`, `/clear` | Local, sin petición a la API |
| `/fast` | Local: «Fast mode is not available in the Agent SDK» |
| `/compact` | Dos peticiones al modelo |
| `/code-review` (`/review` es alias) | Una petición al modelo (skill integrada) |
| `/status`, `/help`, `/permissions`, `/memory` | «isn't available in this environment» (no figuran en `initialize`) |
| Comando inexistente | Se envía al modelo como texto |

Clasificación en Duovra (`src/lib/commands.ts`):

- **Atendido por Duovra** (conflicto de nombre resuelto de forma explícita): `compact`, `context`, `model`,
  `effort`, `fast`, `goal`, `usage`, `cost`, `code-review`, `review`, `clear`. Gana el comando de Duovra;
  el del proveedor solo aparece en `/help` con «Lo gestiona el comando de Duovra». `/goal` de Claude Code
  inicia trabajo autónomo: Duovra nunca lo usa.
- **Solo terminal**: integrados que gestionan la propia CLI (configuración, cuenta, sesión, interfaz de la
  terminal, flujos remotos). No se envían.
- **Personalizados** (`builtin: false`: skills, plugins, comandos del usuario): se ofrecen al buscar y se
  envían tal cual, marcados «Personalizado», con aviso de consumo.
- **Sin verificar**: el resto de integrados. Se ofrecen al buscar con esa etiqueta.

Un comando del proveedor se envía con `providerCommand`: el texto exacto y **sin** el bloque de contexto
compartido (impediría a la CLI reconocer la `/`). El contexto pendiente viaja en el siguiente mensaje
normal. Si la CLI responde solo con `result` (comando local), ese texto es la respuesta. No se encolan.

## Codex 0.172.0

El App Server no publica comandos rápidos. Duovra traduce sus comandos a métodos oficiales:
`thread/compact/start` (`/compact`), `review/start` (`/review`), `turn/interrupt` (`/stop`),
`thread/fork` (`/fork`), `thread/resume` (al continuar). Nunca envía texto de la terminal interactiva.

## Control durante la ejecución

Con el agente trabajando y un borrador, junto al botón principal aparece un pequeño desplegable:

- **Enviar ahora**: `turn/steer` con `expectedTurnId` (Codex). Acuse con el ID del turno → aceptada; sin
  acuse → queda en el historial como no confirmada y el borrador se libera para no repetirla; rechazo del
  proveedor → error y el borrador se conserva. Verificado con el App Server real: un `expectedTurnId`
  distinto se rechaza («expected active turn id … but found …»).
- **Añadir a la cola**: el comportamiento de siempre (y el de Enter).
- **Interrumpir y continuar**: `interrupt_and_submit` reserva la conversación, pide la interrupción por el
  mismo camino que «Detener» (cierra permisos, planes y preguntas pendientes), espera a que la ejecución se
  cierre y guarde su trabajo (hasta 20 s) y entonces inicia el mensaje, antes que la cola, que queda en
  pausa. No deshace archivos. Si la interrupción no se confirma, no envía nada y el mensaje sigue en el
  compositor. Nunca cambia de agente.

Claude Code 2.1.325: un mensaje enviado por stream-json durante un turno se procesa **después**, como un
turno nuevo (comprobado con la API simulada: dos resultados, el segundo mensaje llega en la segunda
petición). No hay acuse ni turno esperado, así que Duovra no lo presenta como intervención: «Enviar ahora»
queda deshabilitado y se ofrecen la cola o interrumpir y continuar.

## Cola

Sin cambios de diseño: editar, reordenar, eliminar, pausar y reanudar ya existían y conservan agente,
modelo, razonamiento, velocidad, permisos y modo; el worktree es el de la conversación. Una cancelación,
un fallo o un estado incierto pausan la cola (no continúa sola). Revisiones y comandos del proveedor no se
encolan.

## Objetivos

- Objetivo **compartido de Duovra**: un recuerdo `goal` con prioridad reservada (2), escrito por el usuario,
  uno activo por conversación. Reutiliza revisiones, entrega por sesión, bifurcación y exportación de la
  memoria. En el contexto viaja en `<conversation_goal>` antes que las instrucciones y la memoria, también
  en modo personalizado. Completarlo lo archiva y se comunica como «completado»; retirarlo lo elimina
  (con la retirada versionada habitual). Definirlo nunca inicia una ejecución.
- **Modo de objetivos nativo de Codex** (`thread/goal/set|get|clear`, estables en 0.172.0): **no se
  activa**. Con la API simulada, `thread/goal/set` con estado `active` inició turnos autónomos al instante
  (21 peticiones en 4 s) que no pertenecen a ningún mensaje de Duovra, así que no se pueden atribuir al
  historial ni a los permisos. `status: paused` y `thread/goal/clear` los detienen. Nunca se transfiere
  trabajo autónomo a Claude Code.

## Revisión de código

- Codex: `review/start` inline en el hilo de la conversación con `uncommittedChanges`, `baseBranch`,
  `commit` o `custom`. El turno muestra `enteredReviewMode`/`exitedReviewMode` como avisos y la respuesta
  en el chat; los cambios se consultan en Workbench. El historial guarda «/review · …». No lleva el
  contexto compartido.
- Claude Code: se prepara `/code-review [rama]` en el compositor como comando del proveedor; nunca se
  añaden `--fix` ni `--comment`. Sin commit ni instrucciones libres: su comando no los admite.

## Errores

El backend guarda una línea útil seguida de «Detalle del proveedor: …» con el original (credenciales
ocultas: `Bearer`, `sk-…`, `token=…`, secuencias aleatorias largas). El mensaje fallido ofrece acciones
según el caso (preparar de nuevo en el compositor, otro modelo, cambiar de agente, cuenta, recuperar
sesión, permisos, límites) y el original en un desplegable. Sin reintentos automáticos ni cambios de
proveedor.

## Importación (Codex 0.172.0)

`agentMessage.moderation.display.mode` = `hide` o `block`: el texto no se importa ni se muestra; queda un
aviso. Aplica a la importación de sesiones y a los turnos en directo.

## QA

- `scripts/qa/control-claude-protocol.mjs`, `scripts/qa/control-codex-protocol.mjs`: CLIs reales contra
  APIs simuladas.
- `scripts/qa/control-mock-apis.mjs` + `scripts/qa/control-webview.mjs`: Duovra en el perfil QA aislado.

# Activity Center, tareas y subagentes (1.0.11, fase 6)

Última fase de funcionalidades de la 1.0.11. Reutiliza TurnInsights, los normalizadores de tareas y
subagentes, la memoria versionada del Context Engine 2.0, el Command Registry y Workbench. No añade paneles
permanentes, servicios externos, SDK ni llamadas ocultas a modelos.

## Activity Center

- Acceso discreto en la barra lateral (pie y barra contraída): icono «Actividad» con el número de
  ejecuciones activas o esperas cuando las hay. Se abre como superficie flotante; `/status` también lo abre.
- Una fila por conversación de cualquier proyecto: título, proyecto · worktree, agente, modelo (el
  comunicado por el proveedor si existe), actividad actual y estado: **Trabajando**, **Esperando
  aprobación**, **Esperando respuesta** (plan o pregunta, aunque la ejecución ya no exista),
  **Interrumpiendo**, **En cola** (con «en pausa»), **Completado**, **Error** y **Detenido** (terminadas en
  esta sesión de la app, en memoria).
- Clic en una fila: abre la conversación (donde se responden aprobaciones, planes y preguntas). Botón
  Detener: la misma cancelación de siempre. Nunca lanza agentes.
- Datos: `runs`, `pendingInteractions` del store, `queue_overview` (nuevo, solo lectura: encargos sin
  despachar de todas las conversaciones) e insights de cada ejecución visible. Se leen al abrir y al
  llegar eventos (`run-event`, `agent-insights`, agrupados a 100–250 ms). Sin sondeo.
- Progreso: barra solo cuando el proveedor comunica la lista completa (TodoWrite, `turn/plan/updated`);
  es «completadas / total», nunca tiempo ni esfuerzo. Sin total conocido: actividad indeterminada.

## Tareas y subagentes

- Formatos reutilizados (sin cambios en los normalizadores): Claude Code TodoWrite, TaskCreate/TaskUpdate
  (con dependencias `blockedBy`/`blocks`), tareas en segundo plano (`task_started|updated|progress|notification`)
  y Agent/Task; Codex `turn/plan/updated` (con `explanation`), `collabAgentToolCall` y `subAgentActivity`.
- Workbench → Actividad: barra solo con total conocido; las listas incrementales (Task tools, segundo
  plano) muestran «n tareas comunicadas». Los subagentes activos van primero y abiertos; los terminados,
  contraídos. Estados finales: **Finalizado**, **Cancelado** (confirmado por el proveedor), **Fallido** y
  **Estado final desconocido** cuando el turno terminó sin cierre comunicado (nunca se marca completado).
  Los campos desconocidos no ocupan espacio.
- Chat: cada TodoWrite era una tarjeta «Plan de trabajo» nueva; ahora solo se muestra la última del turno
  (las anteriores siguen en la actividad y como revisiones en Workbench).
- No hay control individual de subagentes: ninguno de los dos proveedores ofrece una operación fiable
  desde el transporte actual.

## Alcance definitivo y compatibilidad

Se retiran Ajustes → Instrucciones, Ajustes → Prompts, los comandos locales `/instructions` y
`/prompts`, el selector de prompts y la aplicación automática de instrucciones propias de Duovra.
Las tablas históricas `instructions`, `instruction_revisions`, `instruction_deliveries` y `prompts`
se conservan sin eliminar sus datos ni cambiar la versión de SQLite.

El Context Engine conserva memoria, objetivos y sus entregas. Una sesión nativa reanudada con
entregas registradas del antiguo centro recibe un aviso explícito de retirada, sin volver a transmitir
su contenido, incluso con el contexto compartido desactivado. Una entrega incierta se vuelve a
comunicar hasta confirmarse. El aviso no borra el historial nativo; los comandos nativos que omiten
el contexto lo difieren hasta un mensaje normal. Las sesiones nuevas no reciben esas instrucciones.
Las bifurcaciones nativas pueden heredar la necesidad de retirada de la sesión de origen.

El cierre técnico guarda la evidencia en `legacy_instruction_context`, una tabla aditiva
sin texto de instrucciones ni referencias al padre. El registro está separado por conversación,
agente, sesión, cuenta y secuencia. Cada bifurcación copia la evidencia hasta el corte en la
misma transacción; al resolver la bifurcación nativa se conserva el estado para la nueva sesión.
Un aviso confirmado cierra la retirada desde ese punto histórico. Una entrega incierta no la
cierra. La reconstrucción de una sesión nueva no hereda el aviso. La migración inicial recupera
las entregas históricas y las notas de contexto copiadas cuando existe evidencia; no puede
reconstruir evidencia eliminada antes de la migración si tampoco sobreviven esas notas.

Los archivos nativos `AGENTS.md`, `CLAUDE.md` y `.claude/rules/` siguen bajo responsabilidad
de las CLI. Duovra no modifica su contenido ni configuración. La interfaz de detección se retira.

## Comandos y verificación

`/status` abre Activity Center; `/tasks` abre Actividad del Workbench; `/memory` abre memoria.
Se mantienen los comandos de fase 5. QA de Activity Center:
`node scripts/qa/activity-webview.mjs <qa>` (perfil aislado, APIs simuladas).

Los resultados siguientes pertenecen a la implementación anterior a la retirada; se conservan
como evidencia histórica y no constituyen una nueva validación de las funciones retiradas.

### Cierre de QA de la fase 6 (26/11/2026)

Worktree `Duovra-1.0.11`, rama `feat/duovra-1.0.11`, base `ea42ff2` (fase 5).
Implementación y QA preparadas para revisión visual; sin commit de fase 6.

| Validación | Resultado |
| --- | --- |
| Rust, `cargo test --lib --no-default-features --locked` | 136/136, sin fallos ni ignoradas |
| TypeScript, `npm run typecheck` | Correcto |
| Vitest, `npm test` | 245/245 en 46 archivos; incluye i18n 8/8 |
| QA integrada | 6 iniciales + 10 de la continuación conservadas; la prueba de rechazo de tareas se sustituye por la regresión dirigida de abajo |
| QA dirigida tras la revisión visual | 3/3, sin errores de página |
| Regresión final de scripts QA | 6/6 unitarias; ruta explícita 2/2 y ruta predeterminada 2/2; 8/8 comprobaciones negativas con el registro real de la simulación |
| Modelos reales | 0 llamadas; CLIs instaladas con APIs simuladas en loopback |

No se repitieron las seis pruebas iniciales aprobadas. La continuación validó el selector de prompts,
el rechazo de herramientas no disponibles, el fixture de Codex (2/3, dos revisiones), subagentes,
Activity Center, comandos locales, bifurcación histórica y persistencia tras recarga.
El Activity Center confirmó tres conversaciones activas o en espera, una pregunta realmente pendiente
(`answer`), dos ejecuciones `working` y la cancelación de la ejecución larga desde su botón.
El subagente de Claude se canceló durante la petición local de 90 s: turno `cancelled`, último
estado del subagente `running`, representación terminal `unknown`. El otro ejemplo de Claude
sí recibió un resultado y se muestra finalizado. Estos resultados son de QA simulada, no de modelos reales.

**Correcciones de cierre:** los chats provisionales se conservan con borrador temporal hasta el primer
turno (la consulta `bootstrap` elimina chats vacíos); se espera el mensaje asistente concreto y el fin
de su ejecución. La recarga comprueba el store y despliega la barra lateral cuando está contraída.
Los turnos activos de QA se envían mediante el store con cuenta, modelo y esfuerzo comprobados,
no por IPC directo sin registrar el inicio. Los escenarios lentos duran 90 s y liberan su temporizador
si se cierra la conexión. El fixture se verifica por IPC y por ARIA (2 de 3); las aserciones de espera,
cancelación y resultado terminal no aceptan estados activos como fin. La lista del Activity Center
ahora se ajusta a la anchura disponible (370/370 px en QA, todos los controles visibles).
La captura de Prompts espera su sección y un prompt concreto.

**Regresión final de reproducibilidad (26/11/2026):** `parseActivityArgs` separa flags y argumentos
posicionales. Se verificaron `<qa> <salida> --resume-visual --review-tasks` y
`<qa> --resume-visual --review-tasks`; la segunda escribe en `<qa>/report-fase6`.
La prueba de tareas identifica cada turno mediante un UUID, limita las peticiones al tramo actual
del registro y correlaciona los resultados con los identificadores de las herramientas del turno.
El simulador cuenta solo las llamadas posteriores al último mensaje humano para Claude y Codex;
los turnos anteriores no agotan los límites de seis y dos llamadas. Se exige un turno asistente
concreto completado y ausencia de planes inventados. Los rechazos se cuentan por identificador
único y se exige al menos uno de cada proveedor.

En las dos invocaciones dirigidas, tanto en conversaciones nuevas como al reanudar las mismas
sesiones nativas, se observaron **6 rechazos de Claude** (7 peticiones) y **2 rechazos de Codex**
(3 peticiones), cero planes y cero errores de página. Ambas sesiones reanudadas avanzaron de
secuencia 2 a 4 sin cambiar de identidad. En total se registraron 40 peticiones locales del
escenario; 8 comprobaciones negativas sobre el registro observado (retirando el turno actual de
cada proveedor, manteniendo el histórico) fallaron como se esperaba. Las seis pruebas de Node
también cubren ambas rutas, el reinicio de los contadores y la ausencia de rechazos válidos.
El modo dirigido crea y elimina únicamente dos conversaciones temporales por invocación y
conserva los diez ejemplos de entrega. Se reinició solo el servidor de APIs simuladas; la app
QA permaneció abierta y sus datos se conservaron. No se recompiló Rust ni se repitió Vitest:
los cambios posteriores afectan únicamente a scripts QA y documentación.

Rust: el proceso QA cargaba recursos del directorio `target/debug` (incluido WebView2Loader.dll).
Tras cerrar únicamente esa instancia, se completó la compilación con el target existente; se volvió
a abrir el ejecutable QA ya compilado con Vite. El error original de tauri-build no identificaba el
archivo exacto. Queda un aviso no bloqueante de código no usado (`get_instruction`).

**Límites observados:** Claude Code 2.1.325 en `-p` rechaza las herramientas TodoWrite/TaskCreate/TaskUpdate
en este entorno. Codex 0.172.0 con el proveedor simulado rechazó `update_plan` y `spawn_agent`.
Duovra no muestra tareas ni subagentes ficticios en esos turnos; el progreso de Codex se validó mediante
un fixture SQLite explícitamente identificado, no mediante un evento real del proveedor. La detección
de archivos nativos se comprobó con las reglas y confirmaciones descritas arriba. El control individual
de subagentes y la sincronización de instrucciones hacia archivos nativos siguen fuera del alcance.

**Evidencias locales:** `output/qa-fase6-final/activity-webview.json` y `shots/` (11 pruebas);
`output/qa-fase6-review/activity-webview.json` y `shots/` (3 comprobaciones dirigidas).
Los seis primeros resultados se registraron en la salida de la ejecución anterior; no se incluyen como
resultados de una única ejecución del JSON de continuación. Las capturas de revisión sustituyen a las
anteriores del Activity Center, subagente cancelado y ajustes. Las cifras de tokens de los ejemplos
son inventadas por el simulador, no consumo de créditos.

Los informes históricos se conservan; el resultado anterior de rechazo de tareas no constituye
evidencia suficiente por sí mismo y queda sustituido por
`output/qa-fase6-regression/explicit/activity-webview.json` y
`output/qa-fase6-regression/default-root/report-fase6/activity-webview.json`.
En esa misma carpeta se conservan `unit-tests.tap`, `requests-scoped.jsonl`,
`negative-checks.json` y `review-ready.json`. La raíz de prueba de la ruta predeterminada
utilizó un enlace temporal al registro local del mock, retirado al terminar para conservar el
informe predeterminado histórico. La nueva captura `output/qa-fase6-review/shots/entrega-visual-regresion.png`
confirma que Activity Center y el fixture 2/3 siguen disponibles tras la regresión.

Entrega comprobada: `output/qa-fase6-review/review-ready.json` y `shots/entrega-visual.png`.
El proyecto QA conserva diez conversaciones, cuatro instrucciones aplicables a la conversación
original, dos prompts, el fixture 2/3 y los dos casos de subagentes. La app queda abierta con la pregunta
pendiente y los dos turnos cancelados en Activity Center, junto al Workbench de Codex.
En una recarga del WebView de desarrollo, la pregunta sigue pendiente y navegable, pero la ejecución
nativa anterior no se reconstruye en el store de React; las ejecuciones nuevas sí muestran su botón
Detener. No se ha ampliado el alcance a recuperación de ejecuciones en caliente.
Espacio libre al cierre: C: 22,54 GiB; G: 21,41 GiB. Sin nuevos directorios target.

### Revisión visual del alcance definitivo

Correcciones posteriores a la revisión del usuario (26/11/2026). La QA dirigida en WebView2
real del perfil `dev.duovra.studio.qa.agents` pasó 6/6 comprobaciones, sin errores de página:

- Pie lateral: botones de 222 × 32 px y separación uniforme de 3 px; riel de 31 × 31 px,
  separación entre botones contiguos de 4,875 px.
- Tres ciclos de minimización/restauración: tamaño transitorio 144 × 19 px, distribución
  lógica conservada de 1360 × 779 px, zoom, anclaje de mascota y estado de paneles idénticos.
- Redimensionamiento legítimo a 804 × 641 px, sin solapamiento.
- Cierre inmediato por pointerdown fuera en agente, modelo, esfuerzo, permisos, modo y contexto;
  cambio entre menús y Escape. Fast y opciones de envío durante un turno no estaban disponibles
  en el escenario sin ejecución.
- Construir/Planificar: 96,95 × 30 px en ambos estados, etiquetas correctas, preferencias
  independientes por agente persistidas en SQLite, sin modificar permisos ni iniciar turnos.
- Ocho pestañas de Ajustes, veinte comandos locales, IPC retirado, aviso de retirada visible
  en el contexto previsto de una sesión antigua y creación/lectura/eliminación de una memoria
  temporal. La base QA mantiene 5 instrucciones, 7 revisiones, 15 entregas y 2 prompts históricos.

Validación dirigida: Rust 32/32 (contexto, instrucciones históricas, memoria y sesiones),
Vitest 26/26 (incluye i18n 8/8), TypeScript correcto, Node QA 6/6 y compilación incremental
correcta. No se repitió la QA integral ni se enviaron mensajes a modelos. Evidencias:
`output/qa-fase6-visual-corrections/report.json` y `review-ready.png`. Reproducción:
`node scripts/qa/phase6-visual-corrections.mjs` con el WebView QA abierto en CDP 9333.
Espacio libre al cierre: C: 22,66 GiB, G: 21,53 GiB. Sin nuevos directorios target.
La aprobación visual y el commit de fase 6 quedan pendientes del usuario.

#### Cierre técnico tras revisión de código (26/11/2026)

- Regresiones Rust dirigidas: 45/45 (instrucciones históricas, Session Manager, Context Engine,
  memoria y exportación); i18n 9/9, TypeScript correcto y Node QA 6/6. Compilación incremental
  correcta con el target existente. Se conserva la traducción del error de conversación
  desaparecida en exportación.
- WebView real: la conversación antigua tiene aviso, excluye tres revisiones de instrucciones
  y la nueva no tiene aviso. Los datos históricos siguen intactos (5 instrucciones, 7 revisiones,
  15 entregas y 2 prompts); SQLite `quick_check`: ok.
- Codex contra la API local: una bifurcación encadenada continúa nativamente después de eliminar
  el padre intermedio. La primera petición contiene el aviso y ninguna instrucción histórica;
  la segunda no contiene el aviso. El contexto previsto tras confirmar tampoco lo incluye.
- Fast en los catálogos de Claude Code (default) y Codex (gpt-6.2-sol): cierre por pointerdown,
  desaparición del DOM, región libre para clics y cambio de selector. No se enviaron mensajes
  con esos modelos. Las opciones de envío se comprobaron durante un turno simulado de Codex
  (gpt-6-luna): mismos resultados, sin enviar el borrador.
- La primera ejecución del guion obtuvo 2/3: el escenario de envío por IPC agotó su espera
  del compositor. Se corrigió el guion para usar el flujo normal de envío del store y la
  repetición exclusivamente de ese escenario pasó 1/1. En ambos informes: cero errores de página.
  Evidencias separadas en `output/qa-fase6-technical-closure/report.json` y
  `output/qa-fase6-technical-menus/report.json`. Reproducción dirigida:
  `node scripts/qa/phase6-visual-corrections.mjs --closure-only`;
  solo menús: `node scripts/qa/phase6-visual-corrections.mjs --menus-only`.
- Sin llamadas a modelos reales. QA abierta en el perfil aislado, sin conversaciones temporales.
  C: 22,49 GiB y G: 21,37 GiB libres. Sin commit ni inicio de fase 7.

En el perfil aislado, abrir el proyecto histórico «QA · Activity & Instructions (datos de prueba)».
Revisar Actividad, tareas de Codex (fixture 2/3), subagentes de Claude Code, separación del pie
lateral, modos Construir/Planificar y cierre de menús. En Ajustes ya no existen Instrucciones ni
Prompts. Los nombres históricos de conversaciones se conservan.

Para reanudar la QA previa: `--resume-visual`. El modo `--review-activity` comprueba
Activity Center, cancelación de subagente y `/status`. Para la regresión de herramientas:
`node scripts/qa/activity-webview.mjs <qa> <salida-nueva> --resume-visual --review-tasks`.
Pruebas puras: `node --test scripts/qa/activity-qa-helpers.test.mjs`.

#### Corrección final de la migración histórica (26/11/2026)

La migración procesa las bifurcaciones de padre a hijo, estabilizando la evidencia heredada antes de resolver cada sesión nativa y preservando los estados directos. Las notas duplicadas quedan como respaldo cuando falta el origen. Las regresiones `preexisting_resolved_fork_inherits_confirmed_withdrawal_after_pending_parent` y `migration_orders_deep_preexisting_forks_and_preserves_direct_states` cubren el caso A-B-C, nueve bifurcaciones, cortes históricos, estados directos, eliminación de orígenes e idempotencia.

Validación dirigida: Rust 38/38 (instrucciones 5, sesiones 8, contexto 16, contexto compartido 2, memoria 7); compilación incremental correcta. QA abierta (PID 1924) con perfil dev.duovra.studio.qa.agents, WebView inicializado y SQLite quick_check=ok. Se conservan los recuentos históricos 5/7/15/2/13 y no quedan conversaciones temporales. C: 22,49 GiB; G: 21,37 GiB. Cero llamadas a modelos reales; no se repitió QA integral.

Limitaciones: corrección de migración inicial de una versión no publicada, sin reparación retroactiva de bases ya migradas; la base QA inspeccionada no presenta el caso defectuoso. No puede reconstruirse evidencia histórica que haya desaparecido por completo. Advertencia previa no bloqueante de notify::compose sin uso. Pendiente aprobación visual; sin commit ni inicio de fase 7.

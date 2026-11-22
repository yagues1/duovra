# Duovra 0.6.0 · Fase 4C

En **Workbench → Turno**, Operaciones conserva la actividad de herramientas, Tareas muestra los planes y delegaciones observados, y Contexto presenta la sesión y el uso del turno seleccionado. El selector incluye los turnos anteriores de la conversación. **Ajustes → Estadísticas** consulta la actividad registrada y permite elegir ámbito, periodo, proveedor, modelo y desglose.

## Contratos comprobados

| Proveedor | Actividad | Contexto y uso |
| --- | --- | --- |
| Claude Code 2.1.325 | La CLI entrega herramientas estructuradas y eventos `system/task_*`. Se usa el resultado de `TodoWrite`, `TaskCreate` o `TaskUpdate` para confirmar cambios en el plan. Las delegaciones requieren IDs del protocolo o del resultado de `Agent` y `Task`. Las herramientas de un subagente se vinculan mediante `parent_tool_use_id`. | `system/init` comunica sesión y modelo. `assistant.message.usage` aporta entrada por solicitud. `result.usage` desglosa el turno principal. `modelUsage[modelo]` puede comunicar ventana de contexto y máximo de salida. `total_cost_usd` es una estimación local acumulada de la CLI. |
| Codex App Server 0.169.0 | El esquema generado sin `--experimental` incluye `turn/plan/updated`, `collabAgentToolCall` y `subAgentActivity`. Se conserva el ID del hilo receptor y se asocia cada resultado al estado de ese receptor. El estado de la llamada de colaboración y el estado del subagente tienen alcances distintos. | `thread/tokenUsage/updated` incluye `total`, `last` y la ventana opcional. Los tokens de razonamiento están incluidos en los de salida. App Server no comunica un coste por turno en este evento. |

Referencias del contrato. [Claude Code · Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking) · [Claude Code · Tipos de mensajes](https://code.claude.com/docs/en/agent-sdk/typescript) · [Claude Code · Subagents](https://code.claude.com/docs/en/agent-sdk/subagents) · [Codex App Server 0.169.0](https://github.com/openai/codex/tree/rust-v0.169.0/codex-rs/app-server).

La revisión cubrió tareas, agentes, contexto, detalles de sesión, uso, actividad y los mapeadores de Claude Code y Codex. Duovra agrupa la actividad por turno, con transporte Tauri y persistencia local.

## Qué significan las cifras

- **Confirmadas.** El proveedor comunica estados, IDs, ventanas, salida y caché. Los estados pendientes al terminar un turno conservan el último dato observado. Un subagente sin cierre observado aparece como tal. Los porcentajes de contexto requieren dos medidas comparables.
- **Calculadas.** SQLite agrega una proyección por mensaje asistente despachado. El tiempo de ejecución se calcula desde el despacho hasta el cierre local observado. Un cierre por recuperación tras reinicio conserva duración desconocida. El historial compartido muestra mensajes y caracteres de Duovra. La entrada de un turno puede incluir varias solicitudes al modelo y superar la ventana informada para una sola solicitud.
- **Estimadas.** El coste de Claude usa el cálculo de la CLI. En una sesión reanudada, Duovra resta el último acumulado fiable de esa sesión. Los contadores decrecientes o la falta de una referencia inmediata dejan el coste desconocido. Duovra carece de un tarifario propio y distingue el coste estimado del coste reportado.
- **Desconocidas.** Un dato ausente permanece nulo. Las estadísticas muestran cobertura por métrica. El desglose por modelo usa el modelo del turno registrado en Duovra. La estimación de Claude puede incluir subagentes, mientras que los tokens de resultado corresponden al bucle principal. El consumo de un subagente se muestra en su detalle cuando viene identificado y queda fuera de las sumas del turno.

La actividad se vincula al turno en que se recibió. Las actualizaciones que llegan con el turno ya cerrado pueden quedar fuera de la vista, y el historial anterior carece de proyecciones de actividad. Los IDs de dependencias se conservan tal como llegan. Si los datos de una tarea proceden de otro turno y el proveedor solo envía el ID en el turno seleccionado, sus detalles permanecen indisponibles.

## Reconciliación y persistencia

La migración SQLite v1 añade `run_insights` y `insight_claude_requests`. Conserva mensajes, sesiones y el registro histórico `usage_log`. Se recuperan los estados históricos para actividad y los totales guardados son consultables en **Registro anterior** con su cobertura original. El panel consulta un turno y el dashboard recupera agregados de columnas materializadas e indexadas.

- La identidad nativa combina proveedor, sesión y turno de Codex o UUID de resultado de Claude. La clave única protege las sumas al repetir eventos. El progreso de uso se guarda durante la ejecución y el cierre queda en la transacción existente.
- Codex usa diferencias entre snapshots acumulados y conserva un punto de referencia entre turnos. Si al reanudar falta una base fiable, el primer snapshot sirve de referencia y el resto queda marcado como parcial. Una repetición del mismo acumulado aporta cero incremento. Un retroceso marca la cobertura parcial y conserva el mayor acumulado observado. El relleno sintético del contador tras un límite de contexto queda fuera del consumo medido. [Codex · TokenUsageInfo](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/protocol.rs#L2442).
- Claude deduplica las solicitudes por sesión e ID. El resultado sustituye el recuento provisional del turno, y el recuento provisional preserva la entrada disponible cuando falta el resultado. La salida provisional de los mensajes assistant carece de precisión suficiente para contabilizarla.
- La cola solo crea un registro estadístico cuando despacha un turno. Steer añade mensajes de usuario al mismo turno Codex. El reinicio deja visible el último checkpoint de un turno interrumpido.

## Reproducir la QA

Desde el worktree de Duovra:

```powershell
npm run typecheck
npm test
npm run build
node scripts/qa/execution-queue-build.mjs --agent-insights
node scripts/qa/execution-queue-webview.mjs --agent-insights
```

Para las pruebas Rust en Windows GNU, usa el enlazador autocontenido del toolchain, igual que `scripts/tauri.mjs`.

```powershell
$env:Path = "$HOME/.cargo/bin;$env:Path"
$duovraSysroot = rustc --print sysroot
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $duovraSysroot 'lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/x86_64-w64-mingw32-gcc.exe'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS = '-C link-self-contained=yes'
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

La build portable de la QA inicial usa `dev.duovra.agentinsights.qa` y tiene desactivados el actualizador y el envío de reportes. El arnés provisiona perfiles simulados y ejecuta los flujos en WebView2 con IPC nativo y SQLite. Las imágenes y el informe iniciales se guardan en `output/qa/agent-insights/evidencia`.

Pasaron el typecheck, el build frontend, 89 pruebas frontend, 27 pruebas Rust y 16 comprobaciones en WebView2 157.0.4341.60. La QA nativa incluyó teclado, movimiento reducido, despacho, cancelación, Steer, reanudación tras reinicio y verificaciones `integrity_check` y `foreign_key_check` de SQLite.

## Cierre con proveedores reales · 19 de noviembre de 2026

La build del cierre usa la identidad QA `dev.duovra.agentinsights.closure.qa`, un perfil propio de WebView2 y SQLite independiente. Se enviaron dos turnos pequeños desde el compositor de la misma conversación en un proyecto temporal. Se comprobó el catálogo con `node scripts/qa/check-test-models.mjs` antes de enviar. La captura conservó los campos relevantes de los eventos originales de las CLIs.

- **Claude Code 2.1.325.** `haiku` con `medium` en los argumentos de la CLI. `system/init` y `assistant.message.model` confirmaron `claude-haiku-5-5`. Se observó `Read`, su resultado y un `result` exitoso con dos solicitudes. El historial muestra la identidad resuelta y la vista Contexto conserva la sesión, la ventana y el uso.
- **Codex App Server 0.169.0.** `thread/start` confirmó `gpt-6-luna`; `turn/start` envió `high` al mismo hilo. Se observó la apertura del turno, la lectura de `control.txt` con `commandExecution` completado y código 0, dos `thread/tokenUsage/updated` y `turn/completed`. El hilo y el turno del protocolo quedaron vinculados al registro local.
- Las dos ejecuciones prescindieron de las herramientas estructuradas de planificación. Claude Code no emitió `TodoWrite`, `TaskCreate` ni `TaskUpdate`; Codex no emitió `turn/plan/updated`. Tampoco hubo eventos de delegación en ninguna de las dos. Estos casos cuentan con cobertura de contratos y fixtures. La captura del plan incompleto y las capturas de delegaciones usan fixtures.

| Métrica | Claude Code | Codex | Estadísticas antes y después |
| --- | ---: | ---: | ---: |
| Turnos completados | 1 | 1 | 2 |
| Entrada fresca | 4 | 22.300 | 22.304 |
| Lectura de caché | 6.694 | 21.632 | 28.326 |
| Creación de caché | 6.994 | 0 | 6.994 |
| Entrada total | 13.692 | 43.932 | 57.624 |
| Salida | 268 | 248 | 516 |
| Total de tokens del turno | 13.960 | 44.180 | — |
| Entrada de la última solicitud | 6.996 | 22.152 | — |
| Ventana de contexto comunicada | 1.000.000 | 258.400 | — |
| Duración local | 10.316 ms | 88.861 ms | 99.177 ms |
| Coste reportado | No disponible | No disponible | No disponible |
| Estimación de la CLI | 0,00160014 USD | No disponible | 0,0016 USD en pantalla |

Claude comunicó `duration_ms=5384` y `total_cost_usd=0.0016001400000000003`. Codex comunicó `durationMs=86628` y el campo `cacheWriteInputTokens` con valor cero en ambos snapshots. Estadísticas usa el tiempo transcurrido local desde el despacho. La cobertura fue de 2/2 en duración y cada métrica de tokens, 0/2 en coste reportado y 1/2 en coste estimado.

En el hilo nuevo de Codex, los acumulados pasaron de 21.976 a 44.180 tokens. El segundo evento aportó 22.204 tokens adicionales y coincidió con `last`, que desglosó 22.152 de entrada y 52 de salida. Duovra guardó 44.180 para el turno y el hilo, y conservó los 105 tokens de razonamiento dentro de los 248 de salida. Esta ejecución observó dos acumulados crecientes. La repetición exacta de un snapshot se comprobó con el fixture.

Tras el primer reinicio, Duovra restauró la conversación con Claude. Se eligió Codex manualmente y la respuesta combinó la clave anterior con el contenido del segundo archivo. El bloque enviado en `turn/start` tenía 739 caracteres, dos mensajes previos de Claude y cero omitidos. Contexto distingue los dos mensajes persistidos, ese bloque compartido y la sesión nueva de Codex con su última solicitud y su ventana medida en tokens. La prueba usó sesiones efímeras en las CLIs para proteger el historial habitual. Se comprobó la continuidad compartida tras reiniciar Duovra. La reanudación nativa de una sesión CLI tras reiniciar se cubrió con fixtures.

Tras el segundo reinicio coincidieron los registros SQLite, las proyecciones de los dos turnos, el historial y los agregados de conversación y proyecto. Se comprobaron los filtros por proveedor y modelo y los desgloses por conversación y proyecto en Estadísticas. `integrity_check` devolvió `ok` y `foreign_key_check` devolvió cero incidencias.

Workbench muestra el estado de la ejecución aparte del último estado comunicado del plan. Las revisiones nuevas conservan la hora local de recepción y las anteriores siguen accesibles. Subagentes muestra primero el rol, estado, tarea y resultado. Los identificadores, métricas y demás detalles técnicos se consultan en secciones plegables del mismo panel.

Durante el arranque en frío, se observó que el selector puede cerrar el menú sin aplicar el cambio de agente mientras se inicializan las preferencias del compositor. Esperar a que aparezca el modelo actual permitió cambiar a Codex. El hallazgo queda documentado fuera de los dos ajustes del Workbench.

Pasaron el typecheck, el build frontend, 89 pruebas frontend, 27 pruebas Rust y 16 comprobaciones con fixtures en WebView2 157.0.4341.60. Las regresiones incluyeron cola, Steer, recuperación, repetición exacta de snapshots, navegación por teclado y ancho reducido del Workbench. En el mismo ejecutable se comprobó que Archivos abre TypeScript con resaltado y Git muestra el diff preparado de un repositorio temporal. Las pruebas real y de fixtures terminaron sin errores de página.

La build portable y la evidencia local están en `output/qa/agent-insights-closure/`. `validacion-real/evidencia/comparacion-real.json` conserva la comparación antes y después. Los extractos de eventos están en `validacion-real/*-eventos.ndjson`. Las capturas con datos simulados y su verificación están en `fixtures/evidencia/`.

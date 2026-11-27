# Duovra 1.0.11 — Agent Experience: validación local de fase 7

Fecha: 27/11/2026. Rama `feat/duovra-1.0.11`. Base de fase 5: `ea42ff2`; fase 6 aprobada y cerrada en `b95435b`. Esta preparación no publica ni firma una release. No se ha alterado el diseño o código funcional de fase 6.

## Batería final

| Comprobación | Resultado |
| --- | --- |
| Rust, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -j 2` | 136/136, incluido el nuevo test de migración |
| Vitest, `npm test` | 246/246 en 46 archivos, incluido i18n ES/EN 9/9 |
| TypeScript y frontend, `npm run build` | Correcto |
| Node, `node --test scripts/qa/activity-qa-helpers.test.mjs` | 6/6 |
| Integración dirigida WebView2 y APIs simuladas | Cuatro recorridos superados en tres ejecuciones |
| Preflight estático de distribución | Versiones coherentes, configuración Tauri idéntica a 1.0.10 salvo versión, workflow y script de empaquetado intactos, notas y salidas requeridas |

Rust utiliza el toolchain GNU local y el target ya existente `%TEMP%/duovra-target-qa`. La integración reutiliza la build debug de QA de fase 6 en `src-tauri/target` (mismo backend funcional, manifiesto de compilación anterior al bump), WebView2 con el frontend de desarrollo actual y las CLI 2.1.325 / 0.172.0. No se confunde esta prueba con ejecutar el futuro instalador firmado de 1.0.11.

### Migración de la versión pública

Fixture SQL en `src-tauri/src/db/fixtures/schema-1.0.10.sql`, obtenido del esquema de la release `0c8fbea`, sin diferencias de esquema respecto a su integración `9a289f7`. Se crea un perfil de disco temporal con registros sintéticos de las 14 tablas de aplicación existentes; no se accede al perfil personal.

El test `migracion_publica_1_0_10_conserva_perfil_e_idempotencia` abre la base mediante el código real `Db::open`, verifica todas las columnas y registros anteriores, incluidos proyectos, historial, referencias de adjuntos, borradores, sesiones nativas, cuentas, worktrees, preferencias, datos de fondo, cola y estadísticas. Comprueba valores nuevos, ausencia de datos inventados, limpieza de conversaciones vacías sin pérdida de sesiones o adjuntos y una segunda apertura idéntica. `PRAGMA integrity_check`: ok; `foreign_key_check`: sin filas; idempotencia verificada. Los archivos externos se representan mediante referencias sintéticas: la prueba no instala el binario anterior ni autentica sesiones de proveedor. Las pruebas históricas de retirada y bifurcaciones siguen pasando. No se añadió ninguna reparación retroactiva.

### Integración combinada

`scripts/qa/phase7-integration.mjs` exige cuentas QA con configuración local verificada. Usa servidores loopback existentes (no modelos reales) y un proyecto Git desechable. Conserva los informes de los intentos, no sustituye fallos por aprobaciones:

- `output/qa-phase7/integration.json`: contexto, objetivo persistente, transferencia de plan entre Codex y Claude y bifurcación histórica; worktree y Live Preview aislado, correctos. Los otros dos recorridos no completaron sus comprobaciones.
- `output/qa-phase7/control-recheck/integration.json`: steering de Codex, ausencia de steering Claude, cola, interrupción y continuación correctos. Se ajustó la preparación del catálogo y se separó el turno lento de cola del de steering (el simulador puede completar este último enseguida).
- `output/qa-phase7/question-recheck/integration.json`: `/status`, Activity Center, pregunta, rechazo de respuesta inválida, resolución y permisos correctos. El guion invocaba `bootstrap` tras vaciar un chat provisional con el comando local; esa API de arranque limpia chats vacíos. Se conserva un objetivo de prueba para mantener el chat durante la comprobación.

Los tres informes registran cero errores de página y diez peticiones a APIs simuladas en total (5 + 3 + 2). Los fallos de preparación del guion no justificaron cambios en producción. Los cuatro recorridos tienen un resultado positivo verificable. Los perfiles de migración y proyectos temporales propios se eliminaron; los informes y las cachés existentes se conservan.

### Cierre de la revisión de integración (27/11/2026)

Se corrigen exclusivamente las dos deficiencias de QA señaladas tras `877effd`; no cambia el código de producción.

- **Aislamiento previo a cualquier mutación:** `phase7-integration-helpers.mjs` comprueba una única página CDP candidata y el identificador nativo de solo lectura `dev.duovra.studio.qa.agents`. Después consulta las cuentas activas desde el store ya cargado y listo, verifica sus directorios y los endpoints loopback. Solo una vez autorizado se permite invocar `bootstrap`; el rechazo desconecta sin recargar, consumir avisos de restauración ni modificar conversaciones. El guard de envíos también usa el store y vuelve a verificar la identidad y las cuentas. La regresión usa un perfil ficticio con conversaciones (incluida una provisional vacía) y un aviso pendiente: una identidad ajena se rechaza tras el único IPC de identidad, sin leer el store ni alterar esos datos. También se rechazan páginas ambiguas, store no listo, cuentas ajenas y configuración no local. No se accedió a la instalación personal.
- **Entrega efectiva:** el recorrido conserva la comprobación de previsualización y añade aserciones sobre el registro de la petición Codex `QA-PLAN`, delimitado inmediatamente antes del envío y correlacionado mediante UUID. Exige `planMode: true`, `context: true`, `goal: true` y `goalText` idéntico al objetivo creado. Para Claude, se correlaciona la petición de aprobación por el mismo UUID; el simulador registra la versión y el texto íntegro del bloque de plan aprobado de esa petición, no del histórico. Se comparan con el plan persistido de Codex y se conserva la comprobación del identificador, versión y agente en la nota de contexto.

Resultados efectivos:

| Comprobación dirigida | Resultado |
| --- | --- |
| `node --test scripts/qa/phase7-integration-helpers.test.mjs` | 7/7, incluido el rechazo seguro y las aserciones negativas con histórico y peticiones ajenas |
| `node scripts/qa/phase7-integration.mjs output/qa-phase7/handoff-recheck --handoff-only` | 1/1 en WebView2 QA, 3 peticiones loopback, 0 errores de página |
| Entrega Codex | 1 petición correlacionada: contexto y objetivo presentes, texto exacto del objetivo, modo plan activo |
| Transferencia Claude | 1 petición correlacionada: versión 1 y texto íntegro coincidente con el plan aprobado |
| Controles negativos sobre copias en memoria del registro real | 7/7: omitir contexto u objetivo, alterar el objetivo, omitir la petición actual, alterar versión, omitir texto del plan u omitir la transferencia provocan fallo |

Evidencias locales adicionales: `output/qa-phase7/handoff-recheck/integration.json` y `delivery-evidence.json` en esa carpeta (registros correlacionados y controles negativos). Se reinició únicamente el simulador QA para cargar los nuevos campos del registro; se conserva el histórico anterior y el resto de los informes. Cero llamadas a modelos reales. Sin nuevas regresiones de producción, sin repetir las baterías satisfactorias de Rust/Vitest ni las otras tres rutas integradas; no se recompiló. Los proyectos y directorios temporales propios se limpiaron.

### Rendimiento

No se repitió la batería visual aprobada de fase 6 (63/63 escenarios de compositor). La build informa de chunks grandes (incluido ELK) y de una importación dinámica de WebView2 que también es estática; son advertencias, no errores de compilación. No se realizó un benchmark comparativo de 1.0.10 ni se refactorizó el empaquetado. Sin nuevos targets ni compilación release local.

## Distribución y publicación

Los cinco manifiestos están sincronizados en 1.0.11. El identificador público, la clave pública, el endpoint y la exigencia de versión firmada permanecen idénticos a 1.0.10. El workflow oficial de Windows x64 y el script de distribución permanecen intactos. Referencian el entorno y los secretos de firma existentes; no se consultan ni regeneran claves privadas.

El workflow generará `build.json`, instalador NSIS, ZIP portable, firma del instalador, `latest.json` y `SHA256SUMS.txt`, además de `notes.md` como texto auxiliar de release. No se han generado, firmado ni verificado esos binarios aún. Tras autorización quedan CI de Windows, workflow firmado, validación de artefactos, prueba real de actualización en Windows aislado y publicación; después, sincronización web según [el plan](release-1.0.11-web-plan.md). Las notas están en [CHANGELOG.md](../CHANGELOG.md).

Compatibilidad: [limitaciones conocidas](compatibility.md#agent-experience--1011). No se anuncian funcionalidades retiradas ni se extrapola la evidencia de fixtures a modelos reales.

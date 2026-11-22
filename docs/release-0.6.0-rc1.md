# Duovra 0.6.0 RC1

## A. Resumen

La candidata Windows x64 integra el campo de luz, Workbench, la cola persistente, la actividad por turno y las vistas de las fases 3–4E. La rama local `release/0.6.0-stabilization` parte de `71f4e7c`. La referencia 0.5.1 para SQLite es el tag local `v0.5.1` en `315bc71`.

## B. Defectos

| ID | Severidad | Causa | Corrección | Regresión | Estado |
| --- | --- | --- | --- | --- | --- |
| RC-01 | P0 | El cambio de política Codex se daba por confirmado antes de que el proveedor aceptara `turn/start`. | Invalidar el valor anterior al enviar el cambio y guardar la política solo tras una respuesta con ID de turno. | Fixture en el mismo hilo con rechazo, respuesta incompleta y reintento con el sandbox de solo lectura. | Corregido |
| RC-02 | P0 | La aprobación Codex se asociaba al hilo. Podían aparecer solicitudes tardías mientras se cancelaba el turno y se ofrecían opciones que Codex podía excluir. | Verificar el turno, serializar la decisión con la cancelación y validar las opciones en el backend. | Solicitud anterior rechazada, aprobación del turno vigente, cancelación tardía y reinicio con autorización pendiente. | Corregido |
| RC-03 | P1 | La creación del esquema y las migraciones podían quedar a medio aplicar. Faltaba un respaldo de la base anterior. | Instantánea SQLite previa, cambio de esquema transaccional y mensaje de arranque para errores de acceso. | Fallo intermedio con rollback en Rust, migración desde `v0.5.1` con WAL y verificación del respaldo. | Corregido |
| RC-04 | P1 | Las escrituras de borradores podían completarse fuera de orden o quedar en vuelo al cerrar desde la barra. | Serializar por conversación, esperar al cerrar y retener el texto si falla SQLite. | Vitest con escritura retardada, fallo y reintento. Cierre y reapertura por NSIS. | Corregido |
| RC-05 | P1 | Enter podía enviar un texto con una mención aún pendiente de resolución. | Consumir Enter simple mientras se carga o filtra el catálogo de archivos. | WebView2 retiene el IPC de catálogo y verifica el borrador y el historial. | Corregido |
| RC-06 | P1 | Una respuesta incompleta de Codex podía dejar el turno vivo. Los errores del proveedor podían exportar texto crudo a SQLite o a la interfaz. | Cerrar el turno en estado fallido. Convertir errores RPC, resultados de error y stderr en mensajes controlados. | Fixture de rechazo con un marcador que debe quedar fuera del mensaje y fixture sin ID de turno. | Corregido |
| RC-07 | P2 | La vista ampliada de un widget pequeño ocupaba toda la altura y la selección de Workbench y la paleta perdía su indicador en colores forzados. | Altura ajustada al contenido con máximo y scroll interno. Contorno de selección con color de sistema. | Calculadora en WebView2, widget de 40 filas en Edge, selección forzada y cinco ciclos de Workbench. | Corregido |
| RC-08 | P2 | Desuscribirse de los eventos de ejecución dejaba un fotograma pendiente de procesar. | Cancelar el fotograma y liberar su cola al desmontar. | Suites de streaming y navegación. | Corregido |
| RC-09 | P2 | El selector cambia de contenido durante un segundo fallo al reintentar el catálogo y el foco puede volver al cuerpo de la página. | Pendiente. | Fixture Edge. | Abierto |
| RC-10 | P2 | «Ir al final» se desmonta al terminar el desplazamiento y el foco puede volver al cuerpo de la página. | Pendiente. | Fixture Edge. | Abierto |
| RC-11 | P2 | Cambiar Workbench de columna a modal desmonta la vista ampliada. Los valores del widget se conservan. | Pendiente. | Redimensionado de 1360 a 800 px con un widget activo. | Abierto |
| RC-12 | P2 | Escape en un control del iframe HTML aislado llega al documento interno. Tab o Shift+Tab permiten volver al diálogo para cerrar. | Pendiente. | Teclado con un campo HTML de fixture. | Abierto |

## C. Seguridad

- **Permisos y recuperación.** El backend verifica proveedor, ejecución y turno. Las pruebas alternan conversaciones, autorizan y rechazan, y comprueban que una cancelación o un reinicio no concede un permiso pendiente. Se conserva la política del sandbox de cada proveedor. [Esquema de permisos del Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs).
- **Archivos y Git.** WebView2 y Rust cubren rutas relativas, rutas externas, junctions, archivos ausentes o grandes y repositorios inexistentes. Git comprobó staged, unstaged y diffs con el índice intacto. La lectura y salida tienen límites y los procesos tienen timeout.
- **HTML, SVG y Mermaid.** El iframe HTML mantiene origen opaco, CSP y sandbox. WebView2 comprobó que no se ejecutan scripts ni acciones, no se observa tráfico externo y el contenido no dispone del transporte nativo ni acceso al documento padre. SVG y Mermaid renderizan mediante las rutas de aislamiento ya aprobadas.
- **Widgets e IPC.** Once entradas rechazadas en WebView2. Se comprueba que el contrato declarativo conserva la fuente para inspección, que el contenido inválido no crea controles ejecutables y que un widget válido sigue funcionando tras cerrar la vista inválida. Las pruebas unitarias cubren límites y validación de esquema.
- **Persistencia.** SQLite ejecutó `integrity_check` y `foreign_key_check` en el perfil original de prueba, el respaldo y la base migrada. La prueba de dependencias de producción de npm devolvió cero avisos.

## D. Rendimiento

Equipo de prueba con Windows 11 Pro, build 26300, Intel Core i7-8550U, Intel UHD Graphics 620 y 8 GB de RAM. WebView2 157.0.4341.60. Las mediciones son muestras locales con fixtures, no un benchmark comparativo de latencia ni una prueba sostenida de GPU.

- Workbench se probó con un historial de más de 120 filas, búsqueda durante streaming, archivo superior al límite de previsualización y cambios repetidos de pestaña. Las vistas visuales ejercitan múltiples widgets y diagramas de varias dimensiones, con aperturas, cierres y cambios de conversación.
- El JS y CSS referenciado desde el HTML de inicio sumó **1.168.090 bytes**, **359.515 bytes gzip**. La copia local de referencia anterior a 4E sumó **1.163.609** y **358.134** respectivamente. El primer render mantiene diferidos Mermaid, HTML/SVG y widgets. Vite advierte del tamaño del chunk de arranque y de ELK, que se carga desde Mermaid. Las pruebas no justificaron cambiar las dependencias ni reescribir FieldEngine.
- De lanzar el proceso a obtener bootstrap por CDP se midieron **1,42–2,04 s** en cinco arranques del instalador y los perfiles QA. Primera edición del compositor tras recarga, **535 ms**. Estas cifras incluyen el enlace de CDP y sus sondeos.
- Tras cinco ciclos de Workbench el heap JS pasó de **11,94 a 12,08 MB** después de forzar GC, de **3.704 a 3.857 nodos** y de **444 a 462 listeners**. En una pasada anterior se mantuvieron estables los contadores de nodos y listeners. El muestreo cubre el proceso de render y excluye la memoria nativa y GPU, por lo que no permite descartar fugas a largo plazo.
- El campo de luz se comprobó en WebView2 con worker, en reposo y en actividad. Se detuvo al minimizar, se restauró la ventana y se comprobó la pausa con movimiento reducido. Con el worker desactivado por el fixture, el render se recuperó mediante el fallback del hilo principal.

## E. SQLite

Se probó la creación de las tablas desde un perfil con solo ajustes para redirigir las CLIs a fixtures. Se crearon, renombraron y eliminaron proyectos y conversaciones, y se recuperó un borrador tras cerrar y reinstalar.

La migración tomó el esquema del tag 0.5.1, con datos de conversaciones, agentes, modelos, sesiones, preferencias, cuentas, adjuntos, herramientas y uso. El respaldo incluyó el WAL con transacciones confirmadas. Las filas históricas se conservaron exactamente en dos reaperturas. Las columnas nuevas se inicializaron con valores vacíos y las métricas antiguas conservaron su procedencia. Los reinicios no duplicaron las proyecciones de estadísticas.

La restauración de producción utiliza la [copia previa a la migración](distribution.md#upgrade-and-back-up). Se preservan por separado las transacciones realizadas después del cambio de esquema.

## F. QA

- `npm run typecheck`, build Vite y **131 pruebas frontend** en 26 archivos. **28 pruebas Rust** con `cargo test --locked --lib`.
- **52 comprobaciones de integración** registradas. Cola, Steer y estadísticas (18), vistas y widgets (12), selector en frío (2), Workbench y rendimiento (16), e instalación y migración (4). El cierre forzado dejó una autorización pendiente y dos turnos activos. Los encargos y efectos se mantuvieron sin reenvíos y el turno confirmado por Codex se reconcilió por su ID.
- WebView2 nativo con fixtures locales de Claude Code y Codex. La validación anterior del protocolo real de Steer está registrada en [Cola y Steer](execution-queue.md). Esta fase no realizó inferencias con proveedores reales.
- La revisión cubrió teclado, Shift+Tab, Escape, retorno de foco, colores forzados, modo estrecho y movimiento reducido. Quedaron sin ensayo un lector de pantalla, el cambio de DPI del sistema y un equipo sin WebView2 preinstalado. La matriz de robustez se probó con fallos de fixtures, no con una caída real de red o una sesión real caducada.

### Reproducción local

```powershell
node scripts/qa/execution-queue-build.mjs --rc1
node scripts/qa/execution-queue-webview.mjs --rc1 --agent-insights
node scripts/qa/execution-queue-webview.mjs --rc1 --interactive-views --regression-visual
node scripts/qa/execution-queue-webview.mjs --rc1 --visual-previews --selector-only
node scripts/qa/workbench.mjs --rc1
node scripts/qa/rc1-lifecycle.mjs
```

## G. Instalación y actualizaciones

NSIS x64 de QA instalado por usuario en un directorio de prueba. Se verificó apertura, cierre, reinstalación, persistencia, desinstalación y conservación de los datos. La migración se hizo sobre un fixture fiel al esquema de 0.5.1. La sustitución de binarios usó el instalador RC1 de QA.

Producción conserva el nombre `Duovra`, el identificador `dev.claudecodexstudio.app`, la clave pública, el endpoint HTTPS de GitHub Releases y la opción `requireSignedVersion`. El workflow se revisó por código. La comprobación pendiente de lanzamiento es un ensayo de actualización de 0.5.1 a 0.6.0 con artefacto firmado, firma vinculada a la versión y validación de la instalación en un equipo limpio. También queda por comprobar la entrega de reportes contra la infraestructura configurada para producción.

## H. Candidata

| Artefacto de QA | Ruta relativa | SHA-256 |
| --- | --- | --- |
| Portable Windows x64 | `output/qa/rc1/app/` | `deff25c5093266e7187669e8ccb95abc911f41f102a0a9501b4491ea72c56c49` |
| Instalador NSIS x64 | `output/qa/rc1/` | `b53ff441f3326c23184b1a680cdce4fe845348abeec5094bf927c3e8a419db9c` |

Ambos llevan la versión `0.6.0-rc.1` y Authenticode indica `NotSigned`. Para ejecutar la variante portable, conserva la carpeta `app` con `WebView2Loader.dll` y los avisos de terceros. Los modos QA nativo y fixture se identifican en la barra y usan el perfil `%APPDATA%\dev.duovra.studio.rc1.qa` o sus subperfiles aislados. La variante nativa usa las CLIs seleccionadas. Actualizaciones y reportes están desactivados en ambos modos.

Commits de código `fa60e80` (SQLite y permisos), `bfbc2c5` (borradores y compositor), `baa189c` (widgets y colores forzados), `750985f` (política y diagnósticos) y `9c200ab` (edición RC1 y QA).

## I. Veredicto

**Lista para pruebas de lanzamiento.** Los P0 y P1 identificados pasaron su regresión. La aprobación depende de la comprobación del instalador firmado y de la actualización desde una instalación aislada de 0.5.1. La candidata queda en la rama local y no se publicó.

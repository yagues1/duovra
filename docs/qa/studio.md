# QA local de Duovra 0.6.0

La build de revisión utiliza un perfil de QA y muestra conversaciones de prueba con los mismos tipos de eventos que consume la aplicación.

## Reproducir

Desde el worktree de Duovra, instala las dependencias con npm ci y ejecuta npm run typecheck, npm test y npm run build. El build normal excluye el transporte de fixtures.

Para compilar el ejecutable aislado en PowerShell:

    $env:VITE_DUOVRA_QA = '1'
    node scripts/tauri.mjs build --no-bundle --config scripts/qa/studio-tauri.json
    Remove-Item Env:VITE_DUOVRA_QA

Para comprobar el WebView y su base de datos de revisión:

    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9355'
    & '.\src-tauri\target\release\duovra.exe'
    $env:STUDIO_QA_CDP = 'http://127.0.0.1:9355'
    $env:STUDIO_QA_VIDEO = '1'
    node scripts/qa/studio-persistencia.mjs output/qa/studio/compositor-final
    # Cierra y abre de nuevo el mismo ejecutable QA.
    node scripts/qa/studio-persistencia.mjs output/qa/studio/compositor-final --reinicio
    node scripts/qa/studio.mjs output/qa/studio/compositor-final/qa-webview2

El vídeo usa FFmpeg. La prueba de persistencia comprueba el identificador de la base aislada antes de tocar SQLite. Usa un App Server local en stdin/stdout para comprobar el envío, la cancelación y el historial mediante los comandos nativos. Restaura el ajuste de ruta de la CLI al finalizar. La ruta `?persistencia=1` abre la interfaz con los datos nativos y mantiene las consultas de catálogo simuladas.

La comprobación visual cubre inicio, conversación mixta, texto largo, código, diff, herramientas, permiso, pregunta Markdown, error, finalización, Workbench, navegación estrecha y movimiento reducido. Las pruebas de permiso reciben las opciones del evento. La pregunta estructurada en el protocolo de un proveedor necesitaría un contrato nativo adicional. Aquí se ejercita la presentación Markdown existente.

## Refinamiento del compositor

La comparación a 1440 × 900 está en `output/qa/studio/compositor-final/comparativa.html`. Incluye el prototipo B, el integrado de `8132f36` y la build final en WebView2. En reposo, prototipo y final miden 756 × 95 px. El integrado anterior medía 756 × 89 px. La distancia al borde inferior final es de 28 px, comparable con los 29 px del prototipo por encima de su laboratorio. Cada versión usa el historial de su propia demostración.

El selector manual conserva el proveedor del siguiente envío mientras el turno y la autorización muestran su propio agente. El catálogo se sigue leyendo por proveedor, con familias y más modelos. El esfuerzo usa las posiciones admitidas por el modelo. Se comprobó que el teclado enfoca la selección, cambia el nivel y devuelve el foco al cerrar el panel.

## Títulos y persistencia

- El fixture de la fase 3 mantenía «Conversación vacía» incluso después del primer envío. Ahora aplica el título en ese mismo flujo.
- En SQLite, la condición del primer mensaje dejaba el título predeterminado si solo había adjuntos. Ahora se usa la primera línea de texto o el nombre del primer adjunto. La escritura del título automático comprueba en la propia actualización si sigue pendiente. Un nombre manual desactiva esa posibilidad aunque coincida con «Nueva conversación».
- La migración interpreta el título heredado «Nueva conversación» sin texto previo del usuario como pendiente. SQLite antiguo carece de un indicador para distinguir un nombre manual idéntico en ese caso.
- El ejecutable QA guardó el título y los mensajes a través de comandos Tauri y restauró el historial, el borrador multilínea y las preferencias tras reiniciar el proceso. Se verificó también el título manual con el literal predeterminado.

## Cobertura

La cifra de 114 corresponde al estado previo a los cuatro casos de coherencia de actividad añadidos en `4775984`. Se ejecutó la suite de ese commit desde una copia de lectura y dio 118 pruebas. La fase 3 retiró 37.

| Suite retirada | Casos |
| --- | ---: |
| `aurora.test.ts` | 6 |
| `dotflow.test.ts` | 21 |
| `glass/floatLens.test.ts` | 3 |
| `glass/shader.test.ts` | 2 |
| `background.test.ts` | 5 |

De los cinco casos de `background.test.ts`, cuatro trataban la elección y migración de los motores anteriores. El quinto cubría la pausa ambiental. La cobertura equivalente del Field actual se comprueba en Edge y WebView2 para reposo, movimiento reducido, fondo apagado, fallback y minimización de la ventana. Las verificaciones de matiz, identidad de las mascotas y coherencia de actividad se mantuvieron adaptadas. En este refinamiento, el guion de interfaz añade escenarios de selección durante un turno, cancelación con permiso pendiente, cambio de hilo, títulos, edición multilineal y adjuntos. Rust añade un caso de regresión para la protección del título manual.

## Alcance de la comprobación

La QA de interfaz usa eventos simulados. La QA nativa emplea SQLite y una CLI local simulada. Quedan pendientes las pruebas con Claude Code y Codex reales, la comprobación con lector de pantalla y la validación de instalación o actualización firmada. Se verificó por diff la configuración de identidad, actualización, manifiestos y workflows de producción. El ejecutable de revisión se entrega sin firma y con el identificador aislado `dev.duovra.studio.qa`.

El panel de esfuerzo se ajusta al contenido y mantiene las etiquetas en una sola línea. En QA se comprueban los cinco niveles de Luna y el foco al usar Inicio, Fin, las flechas y Escape.

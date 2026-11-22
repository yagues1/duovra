# Duovra 0.6.0 · Fase 4D

## Selección del compositor

La carga inicial del historial y de los catálogos podía dejar la conversación sin un registro de preferencias. Durante esa ventana, la acción de cambio salía al encontrar el registro vacío. Un efecto del compositor inicializaba después el agente a partir de la conversación o de sus ajustes predeterminados. Durante una actualización también podían superponerse dos lecturas del catálogo de un proveedor.

La selección se crea en el store al activar la conversación, de forma síncrona. El store conserva la elección explícita en SQLite incluso si el catálogo aún no confirma un modelo. Cada proveedor tiene un identificador de lectura vigente. Al terminar esa lectura, el store valida solo las conversaciones que tienen seleccionado ese proveedor. Valida el mismo contrato al habilitar Enviar y al despachar o encolar. El almacenamiento de preferencias se ordena por conversación y el despacho directo conserva la configuración que tenía al iniciarse. Cada entrada de la cola conserva su configuración congelada.

## Renderizadores y límites

| Formato | Entrada y representación | Límites de la vista |
| --- | --- | --- |
| Mermaid | Cerca Markdown. Carga al acercarse al viewport tras el cierre de la cerca o al finalizar el bloque. El motor procesa un diagrama cada vez. | 16.000 caracteres, 260 líneas y 220 aristas en los tipos que aplican ese límite. |
| HTML | Bloque Markdown, archivo del proyecto, referencia @ o salida compatible. parse5 sanea y serializa en memoria. El documento se abre en un iframe de origen opaco, con sandbox vacío, política de no referencia y CSP de denegación por defecto. | 192.000 caracteres, 4.000 elementos y 60 niveles. CSS inline e imágenes raster incrustadas. La búsqueda de recursos, navegación y envío de formularios están bloqueados. |
| SVG | Bloque Markdown, archivo o adjunto del proyecto y salida de herramienta con SVG textual. Se analiza como XML y se muestra mediante una URL de datos en un elemento img. | 192.000 caracteres y 5.000 elementos. Referencias por fragmento en el mismo SVG, como degradados y marcadores. |

WebView2 ejecuta las inicializaciones de Wry en los subframes. Duovra retira el transporte chrome.webview de esos documentos y la política connect-src none bloquea la vía HTTP de IPC en la vista. La separación de origen y el sandbox siguen limitando el documento aunque WebView2 inyecte el objeto interno de Tauri.

Mermaid mide el diagrama en su iframe auxiliar. Duovra restringe recursos con una CSP durante el cálculo, descarta las directivas de configuración de la entrada y presenta el SVG saneado como imagen. En el código de los mensajes se conservan las directivas, las etiquetas y las acciones originales. Los archivos pasan por workspace_read y por la validación de rutas canónicas del proyecto, con su límite existente de lectura de 1 MiB.

El visor ofrece fuente y vista, copia, ampliación y los controles propios de cada formato. Para HTML se puede elegir el ancho disponible, 390 px o 1024 px. Los gráficos se pueden ajustar o inspeccionar con zoom. Los archivos grandes y los errores de análisis conservan disponible el código. Las páginas HTML con JS se muestran estáticas, con aviso. La vista previa carece de consola y de resolución de hojas de estilo, fuentes o imágenes externas, incluso cuando el HTML reside dentro del proyecto.

Las vistas cargan de forma diferida, se representan de forma secuencial y se pueden abrir desde los bloques de código. Los avisos de licencia están en [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Reproducción de QA en Windows

Ejecuta los comandos desde la raíz de Duovra con WebView2, Node, Rust y ffmpeg disponibles.

~~~powershell
npm run typecheck
npm test
node scripts/qa/execution-queue-build.mjs --visual-previews
node scripts/qa/execution-queue-webview.mjs --visual-previews
node scripts/qa/execution-queue-webview.mjs --visual-previews --regression-queue --agent-insights
~~~

La variante usa el identificador dev.duovra.visualpreviews.qa, con un perfil de WebView2 separado para cada ejecución de QA y el actualizador desactivado. Los fixtures simulan los protocolos de ambas CLIs. La prueba usa el WebView2 del ejecutable, IPC de Tauri y SQLite; las solicitudes de catálogo se liberan por barreras reproducibles. El ejecutable y la evidencia se generan bajo output/qa/visual-previews. El zip es portable y requiere el runtime de WebView2.

Para comparar arranque, genera el dist de 61329c0 con Vite en una carpeta aparte. Pasa las dos rutas a scripts/qa/visual-previews-bundle.mjs. El script suma JavaScript y CSS enlazados por index.html, incluyendo modulepreload. Se excluyen fuentes, iconos, worker y los renderizadores solicitados durante el uso.

| JavaScript y CSS iniciales | Base 61329c0 | Fase 4D | Diferencia |
| --- | ---: | ---: | ---: |
| Minificados | 1.151.227 B | 1.163.609 B | +12.382 B |
| gzip | 353.916 B | 358.134 B | +4.218 B |

El paquete incluye el motor Mermaid completo con módulos diferidos para cada tipo de diagrama. El tamaño del paquete completo aumenta. El motor, parse5 y el visor se cargan durante el uso.



## Resultados de la fase

- Typecheck, 101 pruebas Vitest, 27 pruebas Rust y build Tauri portable completados.
- WebView2 real 157.0.4341.60. Ocho escenarios pasaron con los protocolos simulados de Claude Code y Codex. Incluyen los dos cambios en frío, la cerca Mermaid incompleta y su cierre durante el turno, los controles visuales, la vuelta al chat, la cola y Steer.
- El HTML aislado tuvo origen opaco, sin acceso al documento padre ni al transporte nativo. El CSP bloqueó el IPC HTTP y los recursos remotos. Las pruebas observaron cero peticiones hacia el dominio de prueba. Los casos SVG y Mermaid conservaron el código original y bloquearon contenido activo y enlaces externos. El lector del Workbench rechazó el archivo de prueba fuera del proyecto.
- Las 16 comprobaciones de regresión de la cola e Insights pasaron en la misma build, incluidas reanudación, SQLite, métricas y navegación por teclado.
- La build portable, los archivos de ejemplo, las capturas, el vídeo y los informes JSON quedaron en output/qa/visual-previews.

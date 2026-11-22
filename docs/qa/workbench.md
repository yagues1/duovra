# Duovra 0.6.0 · Fase 4A

## Uso

- **Workbench** se abre desde la barra superior o desde la paleta. **Archivos** carga cada carpeta al expandirla. Los archivos abiertos tienen pestaña, numeración de líneas, resaltado de los lenguajes compatibles y botones para recargar y copiar. El archivo abierto comprueba cada 2,5 s si han cambiado su tamaño o su fecha de modificación.
- **Git** muestra la rama y separa cambios preparados, sin preparar y sin seguimiento. Un archivo con cambios en el índice y en el working tree aparece en ambos grupos, con un diff propio. **Turno** conserva las operaciones y diffs que informó el agente. El botón de actualización de Archivos también actualiza las marcas Git.
- **Ctrl+F** dentro de la conversación abre la búsqueda. **Intro** avanza, **Mayús+Intro** retrocede y **Esc** restaura el foco y la posición anterior cuando sigue abierta la misma conversación. El resultado activo revela su bloque plegado. El recorte bajo el buscador muestra contexto incluso si el resultado está en un campo de herramienta que no tiene una representación literal en la conversación.
- **Ctrl+Mayús+P** abre la paleta. **↑/↓** navega, **Intro** ejecuta y **Esc** cierra. Busca acciones, proyectos, títulos y texto persistido de mensajes. La búsqueda de mensajes devuelve el resultado más reciente de hasta 24 conversaciones, con un fragmento que abre la búsqueda dentro del chat.
- **@** abre el selector por nombre o ruta. Por ejemplo, se puede insertar **@"src/lib/configuración local.ts"**. El borrador conserva la referencia en texto y el mensaje enviado ofrece un acceso para abrirla en Workbench. Al enviar, Rust comprueba que el archivo existe y pertenece al proyecto de esa conversación. Se guarda y se envía como adjunto de ruta relativa, con el contenido sin incrustar incluso para imágenes. El proveedor decide si lo lee con sus herramientas y permisos habituales.
- **/** al inicio de una entrada abre **Acciones de Duovra**. **/archivos**, **/git**, **/buscar** y **/workbench** ejecutan una acción local con Intro. Un comando aislado se reserva para la interfaz. Para hablar de un comando con el agente se puede escribir una frase como «Explica /git».

## Límites y procedencia

El explorador lista hasta 2.000 entradas por carpeta y el catálogo de menciones recorre hasta 25.000 entradas bajo demanda. Este catálogo omite directorios habituales de dependencias y salida, como node_modules, target y dist. El visor lee hasta 1 MiB y muestra hasta 6.000 líneas. Omite los enlaces y puntos de montaje internos durante la enumeración. Las referencias absolutas procedentes del chat se admiten después de resolverlas y comprobar que pertenecen al proyecto registrado. En Windows se valida además la ruta final del descriptor antes de leer.

Git usa el ejecutable disponible en PATH. Desactiva escrituras opcionales del índice, fsmonitor, filtros de contenido, diff externo, textconv y la solicitud implícita de objetos remotos. Las consultas se acotan con un tiempo de espera y un máximo de salida. Los repositorios y subproyectos se consultan desde la carpeta registrada. Los renombrados se presentan como altas y bajas. Los submódulos se omiten en la vista Git. Un proyecto sin Git conserva el acceso a sus archivos.

La búsqueda global usa SQLite en lectura y el esquema existente. Consulta el texto persistido de mensajes de usuario y agente con la comparación de mayúsculas de SQLite, que distingue mayúsculas en parte de Unicode. La búsqueda local sí compara sin distinguir mayúsculas Unicode e incluye actividad y herramientas. El resaltado de la conversación busca sobre los nodos de texto que coinciden con la consulta. El fragmento permite consultar coincidencias en Markdown fuente o metadatos que la vista transforma.

Workbench usa las primitivas y contratos de Duovra para la búsqueda, el ranking aproximado y el índice ascendente de cambios. [Avisos de licencia](../../THIRD_PARTY_NOTICES.md).

## Observaciones de la QA previa

**Franja fucsia.** En la captura de referencia de la vista de comandos de Workbench, la salida y el comando se renderizan en elementos de texto preformateado. La vista no llama al resaltador de sintaxis ni interpreta códigos de color. No se reprodujo una franja fucsia en esa captura de referencia. La causa de la observación original queda sin confirmar.

**Tokens.** Codex calcula el consumo del turno a partir de la diferencia entre dos contadores del hilo. Si se reanuda sin una base en memoria, usa la diferencia entre total y último reporte para estimar la base del primer evento recibido. El tamaño de contexto del último reporte se guarda por separado. Claude Code suma entrada fresca, lecturas de caché y creación de caché del resultado de la ejecución. En esa CLI el coste en USD se informa acumulado por sesión y Duovra calcula la diferencia si conoce el total anterior. Durante una ejecución pueden acumularse varias solicitudes con contexto o caché. El tope de 36.000 caracteres se aplica al historial compartido que Duovra prepara entre agentes. La etiqueta de entrada indica que es del turno. Los eventos originales de 95k y 156k serían necesarios para desglosar esas cifras.

## Compilación y pruebas

    npm run typecheck
    npm test
    npm run build
    cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
    node scripts/qa/workbench-build.mjs
    node scripts/qa/workbench.mjs

La build portable queda en **output/qa/workbench/app**. Usa la identidad **dev.duovra.workbench.qa**. El guion controla WebView2 por un puerto local, usa un perfil WebView2 independiente, prepara un repositorio temporal real y ejecuta fixtures locales de las CLIs. Las capturas, el vídeo y los resultados quedan en **output/qa/workbench/evidencia**.

# Duovra

La propuesta B aprobada el 17 de noviembre de 2026 define la interfaz de Duovra 0.6.0. La columna de lectura ocupa el centro, con la navegación a la izquierda y Workbench bajo demanda a la derecha.

## Sistema visual

| Rol | Base | Uso |
| --- | --- | --- |
| Ventana | #14151a | Apertura y fondo sólido |
| Hoja | #15161b | Conversación y barra superior |
| Navegación | #18191f | Barra lateral y Workbench |
| Panel | #1b1d24 | Compositor, menús y diálogos |
| Control | #20222a | Botones, tarjetas y burbujas |
| Elevado | #272a34 | Hover y superficies destacadas |
| Texto | #eeeff1, #d4d7df, #a9afbd, #929aaa | Títulos, lectura, texto secundario y datos |
| Semántica | #a2d5af, #e5bb80, #f39ca7 | Éxito, permiso y error |

- Los tokens viven en src/styles/tokens.css. Geist y Geist Mono cubren interfaz y código. Lucide cubre iconos de interacción.
- El matiz seleccionado colorea foco, selección y parte del campo. Claude Code y Codex conservan sus colores. La preferencia histórica de contraste se lee como respaldo si aún falta ui.contrast.
- La columna normal mide 756 px antes de márgenes adaptables. La barra lateral mide 242 px desplegada. El riel y el Workbench superpuesto permiten usar una ventana estrecha.
- La escala de interfaz usa el zoom de WebView2, limitado por el tamaño lógico mínimo. La densidad y el ancho de lectura se ajustan independientemente.
- Los componentes comparten superficies, controles y foco en controls.css. Cada área tiene sus reglas en una hoja. La entrada y selección emplean transiciones cortas de opacidad y desplazamiento.

## Conversación, actividad y permisos

La interfaz consume Message, RunView y TimelineItem. El contenido de streaming pasa por la misma suscripción y el mismo store. El historial previo que solo tiene content conserva su respuesta. Los pasos operativos se pliegan al cerrar el turno y admiten inspección. Los errores de operaciones permanecen visibles.

La sesión y la autoría las determina el turno. El compositor conserva sus preferencias por agente y conversación. El control horizontal de esfuerzo se genera con los niveles que informa el modelo. Las autorizaciones usan exclusivamente las opciones del backend y anuncian qué agente solicita qué acción.

Expressive Studio se utiliza junto al compositor. Minimal Vector se usa en navegación, selección y cabeceras. Las poses proceden de la actividad observada. La escritura de código dentro de una respuesta cuenta como escritura y las lecturas de archivo se identifican a partir de herramientas conocidas.

## Campo de luz

El host monta un solo canvas cerca del compositor. En inicio el campo es más alto y de intensidad baja. En conversación la máscara concentra la textura en la banda inferior. Los pulsos responden a envío, inicio y cambios de actividad. La autorización usa ámbar y deriva a una escena en reposo. La finalización y el error producen una reacción breve.

El renderer usa Canvas 2D con OffscreenCanvas en un worker. El host cancela el bucle al terminar cada reacción y al ocultar o desenfocar la ventana. El motor conserva el gobernador de calidad, que cambia cadencia y resolución bajo carga. Se libera el worker con la vista. Si el worker falla, la aplicación crea otro canvas y ejecuta FieldEngine en el hilo principal. Si falla Canvas 2D, se mantiene el fondo sólido.

Los valores históricos de appearance.backdrop que identificaban Aurora y Dot Matrix se interpretan como el campo de luz. El ajuste de animación del fondo se conserva. Apagado evita montar el lienzo. Movimiento reducido muestra el campo fijo.

## Workbench

Workbench abre en Contexto cuando aún no hay pestañas. Lee archivos modificados, operaciones y datos del proyecto y conversación activos. Desde el chat se pueden abrir vistas de archivo, diff y salida. Las vistas estrechas usan un diálogo modal con cierre por Escape y devolución de foco. Las pestañas se recorren con flechas e Inicio/Fin.

La procedencia y la licencia de FieldEngine están en [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Para ejecutar la revisión local, consulta [la guía de QA](qa/studio.md).

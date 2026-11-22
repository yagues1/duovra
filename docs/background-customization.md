# Fondos de Duovra

En Duovra 1.0.0, **Ajustes** se abre como un diálogo sobre la pantalla actual. En **Apariencia → Fondo**, cada cambio se pinta al instante en la conversación real que queda detrás del diálogo. El velo de Ajustes se aclara en esta sección para ver mejor el fondo. Si mantienes pulsado **Mirar el fondo**, el diálogo se aparta mientras dure la pulsación.

## Qué se puede elegir

- **Patrones**: ocho presets (`Quiet`, `Streaks`, `Corner`, `ASCII`, `Halftone`, `Still`, `Mono` y `Vivid`). Cada miniatura es un fotograma del motor real, no una imagen.
- **Duovra**: *Duovra Original* (la banda de luz detrás del compositor), *Minimalista* e *Imagen*.
- **Mis fondos**: los presets personales, incluidos los guardados con el editor anterior.

Para un patrón, la primera vista muestra **Patrón** (Streaks, Tubes, Tiles, Aurora), **Tratamiento** (Dither, ASCII, Halftone, Soft), **Intensidad**, **Movimiento**, **Extensión** y **Color** (Agente, Mono o Propio, con matiz y saturación). En **Ajustes avanzados** se encuentran el detalle de celda, la dirección (Streaks y Tubes), el foco horizontal y vertical y la reacción al puntero y a la actividad.

Con **Color · Agente**, el fondo toma el color del agente elegido en el compositor: cálido para Claude Code y cian para Codex. Mientras un agente trabaja, la deriva se acelera y el fondo responde con pulsos. Cuando espera una autorización, se vuelve ámbar y se detiene. Tras 30 segundos sin uso ni ejecuciones, el patrón se asienta en un fotograma quieto.

## Aplicar, Cancelar y salidas del diálogo

Hay una sola semántica: **la vista previa no se guarda hasta pulsar Aplicar**.

- **Aplicar** guarda el fondo en SQLite (`appearance.background.v1`).
- **Cancelar** descarta la prueba y la conversación vuelve al fondo guardado.
- Si hay cambios sin aplicar, Duovra pide confirmación al **cerrar Ajustes**, ya sea con Escape, el botón Cerrar o un clic fuera. También la pide al **cambiar de sección**, al **cambiar de conversación** y al **cerrar Duovra**. Al confirmar se descarta la prueba; si cancelas, puedes seguir editando.
- Arrastrar un deslizador solo actualiza el estado en memoria. No escribe en SQLite.

Los presets personales se guardan con **Guardar como preset** y se pueden renombrar, actualizar o eliminar. Eliminar el preset activo no cambia el fondo de la conversación.

## Compatibilidad

- Se conservan los fondos y presets de la beta anterior (*Ondas*, *Partículas* y *Ambiental*). Se leen y se pintan con su motor de siempre. **Editar como patrón** los convierte en un borrador de patrón. El original no se modifica hasta que pulses Aplicar, y el preset guardado conserva su versión anterior.
- Una configuración sin preferencias nuevas sigue mostrando *Duovra Original*. Las preferencias de fondos se leen sin reescribirlas.
- Las imágenes siguen la validación existente: PNG, JPEG y WebP de hasta 8 MB, 4096 px por lado y 12 megapíxeles. Duovra guarda una copia WebP dentro del perfil y la libera cuando deja de usarse. Puedes ajustar el encuadre, el oscurecimiento, la opacidad, el desenfoque y el tinte.

## Legibilidad

Un patrón ocupa toda la conversación. Un velo con la superficie de Duovra protege la columna de mensajes y se hace más denso cuanto mayor es la intensidad. Hacia el compositor se abre para que la luz se vea a través del cristal.

## Rendimiento

Un único worker dibuja todos los campos: la conversación, la vista previa sin conversación detrás y las ocho miniaturas. Las miniaturas pintan un fotograma por cambio y no tienen bucle. Con Ajustes abierto, el fondo de detrás se queda quieto. En Apariencia redibuja al instante cada cambio, se anima durante 4 segundos para mostrar su movimiento y vuelve a detenerse; mientras mantienes *Mirar el fondo* se anima sin límite. Las mascotas de la conversación también se pausan detrás del diálogo. Se conservan el gobernador de calidad (en los niveles bajos, el cristal deja de desenfocar), las pausas al minimizar en WebView2, el movimiento reducido y el fallback en el hilo principal si no hay `OffscreenCanvas`.

## Revisión local

Ejecuta `node scripts/qa/pattern-build.mjs` y `node scripts/qa/pattern-webview.mjs` para validar la galería en WebView2, con un perfil desechable y adaptadores locales de ambos proveedores. La opción `--baseline-old` usa el ejecutable anterior de QA de fondos.

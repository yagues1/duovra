# Changelog

All notable changes to Duovra are documented here. Older entries keep their original language.

## 1.0.10

### Español

- **Apoyar Duovra.** Nuevo botón con un corazón en la parte inferior de la barra lateral, encima de Ajustes (solo el icono, con descripción, cuando la barra está contraída). Abre en el navegador predeterminado el apartado de apoyo de la web oficial en el idioma de la aplicación. Duovra no procesa pagos, no muestra recordatorios ni comprueba aportaciones: el apoyo es voluntario y todas las funciones siguen siendo gratuitas.
- **Web oficial.** Nueva sección de apoyo con Ko-fi (PayPal), Giveth (criptomonedas) y la opción gratuita de dar una estrella en GitHub.
- **Actualización desde 1.0.9.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Support Duovra.** A new heart button at the bottom of the sidebar, above Settings (icon only, with a tooltip, when the sidebar is collapsed). It opens the support section of the official website in your default browser, in the app's language. Duovra does not process payments, show reminders or check contributions: support is voluntary and every feature stays free.
- **Official website.** A new support section with Ko-fi (PayPal), Giveth (cryptocurrency) and the free option of starring the project on GitHub.
- **Updating from 1.0.9.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.9

### Español

- **Git Worktrees.** Crea o importa worktrees reales de Git desde la barra lateral y trabaja en varias ramas del mismo repositorio en paralelo. Cada conversación pertenece a un espacio (el directorio principal o un worktree): Claude Code, Codex, los adjuntos, Workbench y la cola trabajan siempre en ese directorio. La eliminación es segura: Duovra retira el worktree, borra la carpeta o la rama como acciones separadas y lo impide si hay cambios sin commit, archivos ignorados que no se pueden regenerar (como `.env`), ejecuciones activas o commits exclusivos. Duovra no hace commit, merge ni push por ti.
- **Live Preview.** Un navegador integrado en Workbench para la aplicación web del espacio activo: inspector visual de elementos, capturas del área visible o de un elemento, consola, red, tamaños de pantalla con emulación táctil y gestión del servidor de desarrollo. Lo que eliges (un elemento, una captura, un error de consola o una petición fallida) llega al compositor como contexto para Claude Code o Codex. Se puede ampliar o abrir en una ventana independiente.
- **Aislamiento de Live Preview.** La página se carga en una WebView separada con perfil InPrivate y sin acceso a los comandos de Duovra. Los sitios externos, las ventanas nuevas, las descargas y los permisos del navegador requieren confirmación. La red no registra cabeceras, cookies ni cuerpos, y el contexto que recibe el agente se sanea y se marca como datos, no como instrucciones.
- **Conversaciones provisionales.** «Nueva conversación» ya no acumula chats vacíos: el chat aparece en la barra lateral al usarlo y se descarta si lo abandonas sin contenido. Los borradores y adjuntos de cada conversación se conservan al cambiar de chat o reiniciar.
- **Compositor rediseñado.** Agente, modelo, razonamiento y permisos en una sola fila, un selector compacto de velocidad y un botón multifunción que envía, cancela o encola según el momento. La intervención en Codex pasa a `Alt+Enter`.
- **Permisos rápidos.** Ajusta los permisos de Claude Code y de Codex por conversación y por agente desde el compositor. Reducir protecciones pide confirmación.
- **Barra superior con cápsula central.** Muestra el proyecto, el worktree y la conversación activos, con acceso compacto a Workbench.
- **Workbench más estable.** Las pestañas se adaptan al ancho disponible y se corrigen errores de estabilidad de Workbench y Live Preview.
- **Actualización desde 1.0.8.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Git Worktrees.** Create or import real Git worktrees from the sidebar and work on several branches of the same repository in parallel. Each conversation belongs to one space (the main folder or a worktree): Claude Code, Codex, attachments, Workbench and the queue always work in that folder. Removal is safe: Duovra retires the worktree, deletes the folder or deletes the branch as separate actions, and blocks them when there are uncommitted changes, ignored files that cannot be regenerated (such as `.env`), active runs or commits found on no other branch or remote. Duovra never commits, merges or pushes for you.
- **Live Preview.** A browser built into Workbench for the active space's web app: visual element inspector, captures of the visible area or of an element, console, network, screen sizes with touch emulation and development server management. What you pick (an element, a capture, a console error or a failed request) reaches the composer as context for Claude Code or Codex. It can be expanded or opened in its own window.
- **Live Preview isolation.** The page loads in a separate WebView with an InPrivate profile and no access to Duovra's commands. External sites, new windows, downloads and browser permissions require confirmation. The network view never records headers, cookies or bodies, and the context sent to the agent is sanitized and marked as data, not instructions.
- **Provisional conversations.** New conversation no longer piles up empty chats: a chat appears in the sidebar once you use it and is discarded if you leave it empty. Each conversation keeps its draft and attachments when you switch chats or restart.
- **Redesigned composer.** Agent, model, reasoning and permissions in a single row, a compact speed picker and one multi-purpose button that sends, cancels or queues depending on the moment. Steering a Codex turn now uses `Alt+Enter`.
- **Quick permissions.** Adjust Claude Code and Codex permissions per conversation and per agent from the composer. Lowering protections asks for confirmation.
- **Top bar with a central capsule.** Shows the active project, worktree and conversation, with compact access to Workbench.
- **A steadier Workbench.** Tabs adapt to the available width, and stability issues in Workbench and Live Preview are fixed.
- **Updating from 1.0.8.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.8

### Español

- Las respuestas en curso actualizan el turno activo sin volver a renderizar el historial. El Markdown largo se procesa en intervalos breves y el resaltado de código se aplica al cerrarse cada bloque.
- Los fondos animados se pausan al minimizar la ventana o tras un periodo de inactividad. Duovra Original redibuja solo los puntos que cambian. Aura y Flujo reutilizan el dibujo vectorial de las poses fijas.
- Workbench consulta los archivos y cambios de Git al abrir sus pestañas. Ajustes y los catálogos de modelos se cargan cuando se necesitan.

### English

- Streaming responses update the active turn without re-rendering the chat history. Long Markdown updates are processed in short batches, and code highlighting is applied when each block closes.
- Animated backgrounds pause when the window is minimized or after a period of inactivity. Duovra Original redraws only the dots that change. Aura and Flujo reuse vector artwork for static poses.
- Workbench queries files and Git changes when their tabs open. Settings and model catalogs load as needed.

## 1.0.7

### Español

- **Mascotas 2.0.** Aura (Claude Code) y Flujo (Codex) sustituyen a las mascotas anteriores. Son personajes de contorno vivo que respiran, parpadean, miran alrededor, siguen el cursor y reaccionan al acercarlo o al hacer clic. Aura lleva una chispa que flota sobre su cabeza; Flujo, un giroscopio que gira más rápido cuando ejecuta comandos.
- **Reaccionan a lo que pasa de verdad.** Cambian de gesto al pensar, leer archivos, editar, ejecutar comandos, escribir la respuesta, terminar o fallar, siempre a partir de los eventos reales del turno. Un permiso pendiente o un error siempre se distinguen: ninguna reacción al cursor los tapa.
- **Más protagonismo.** En una conversación vacía la mascota preside el centro. Al enviar el primer mensaje viaja a su escenario, a la derecha del compositor, y cuenta lo que hace en un bocadillo (por ejemplo, el archivo que está leyendo). Si no hay sitio, por ejemplo con Workbench abierto, se posa en el borde del compositor. Mientras escribes, te escucha.
- **Ligeras.** Una sola animación viva por conversación, sin trabajo de React por fotograma; se detiene fuera de pantalla, sin foco o con Ajustes abierto. Respeta **Animaciones de las mascotas**, la intensidad reducida y el movimiento reducido de Windows. Los iconos pequeños usan una pose fija.
- **Actualización desde 1.0.6.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Mascots 2.0.** Aura (Claude Code) and Flujo (Codex) replace the previous mascots. They are living-outline characters that breathe, blink, look around, follow the cursor and react when it comes close or when you click. Aura has a spark floating above its head; Flujo has a gyroscope that spins faster while it runs commands.
- **They react to what really happens.** Their expression changes while thinking, reading files, editing, running commands, writing the answer, finishing or failing, always from the turn's real events. A pending permission or an error always stands out: no cursor reaction hides them.
- **More presence.** In an empty conversation the mascot takes the centre. When you send the first message it travels to its stage, to the right of the composer, and tells you what it is doing in a speech bubble (for example, the file it is reading). When there is no room, such as with Workbench open, it perches on the composer's edge. While you type, it listens.
- **Lightweight.** A single live animation per conversation, with no per-frame React work; it stops off-screen, when the window loses focus or while Settings is open. It respects **Mascot animations**, reduced intensity and Windows reduced motion. Small icons use a fixed pose.
- **Updating from 1.0.6.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.6

### Español

- **Workbench renovado.** Las pestañas Actividad, Archivos y Cambios forman un control segmentado con una pastilla que se desliza a la activa. Cambios muestra cuántos archivos tocó el último turno.
- **Cambios con el diff integrado.** La pestaña lista los archivos del último turno y muestra debajo el diff del seleccionado, con números de línea y las líneas añadidas y eliminadas. Se puede abrir en una pestaña propia.
- **Actividad más visual.** Muestra solo el último turno de la conversación activa, sin selector de turnos: una tarjeta con el agente, el estado, la hora, la duración, las operaciones y las incidencias; una barra que reparte el trabajo por tipo (comandos, lecturas, búsquedas, ediciones); los archivos cambiados con su balance de líneas; y una línea de tiempo con las duraciones y las flechas alineadas.
- **Archivos** muestra la ruta del proyecto bajo el título.
- **Actualización desde 1.0.5.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Renewed Workbench.** The Activity, Files and Changes tabs form a segmented control with a pill that slides to the active one. Changes shows how many files the latest turn touched.
- **Changes with an inline diff.** The tab lists the files from the latest turn and shows the selected file's diff below, with line numbers and the added and removed lines. It can be opened in its own tab.
- **A more visual Activity.** It shows only the latest turn of the active conversation, with no turn picker: a card with the agent, status, start time, duration, operations and issues; a bar that splits the work by type (commands, reads, searches, edits); the changed files with their line balance; and a timeline with durations and arrows aligned.
- **Files** shows the project path under its title.
- **Updating from 1.0.5.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.5

### Español

- **Fondo Duovra Original renovado.** Los puntos luminosos del horizonte se dibujan nítidos, redondos y a la resolución real de la pantalla, con más brillo y profundidad. Mantienen su definición en todas las fases del chat, también mientras el agente trabaja. El fondo ya no reacciona al ratón.
- **El color de acento llega a todos los fondos.** Los patrones, Ondas, Partículas, Ambiental y Minimalista toman el color de acento elegido en Ajustes. Mientras un agente trabaja, los fondos que reaccionan pasan a su color. Mono, los colores personalizados y las imágenes conservan los suyos. Las miniaturas de la galería muestran el color elegido.
- **Selector de color desplegable.** El color de acento se elige en un único desplegable con muestra y nombre de cada color. Se puede usar con el teclado.
- **Actualización desde 1.0.4.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Renewed Duovra Original background.** The points of light on the horizon are drawn sharp, round and at the screen's real resolution, with more brightness and depth. They keep their definition in every phase of the chat, including while the agent works. The background no longer reacts to the mouse.
- **The accent color reaches every background.** Patterns, Waves, Particles, Ambient and Minimal take the accent color chosen in Settings. While an agent works, the backgrounds that react switch to its color. Mono, custom colors and images keep their own. Gallery thumbnails show the chosen color.
- **Color dropdown.** The accent color is chosen from a single dropdown that shows each color's swatch and name. It works with the keyboard.
- **Updating from 1.0.4.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.4

### Español

- **Conversación más clara.** Los mensajes de progreso que escriben Claude Code y Codex aparecen directamente en el chat. Los comandos, las lecturas, los cambios de archivos y las herramientas se agrupan entre esos mensajes en desplegables compactos («3 archivos consultados», «2 archivos modificados · 1 comando ejecutado»), en el orden real. Las conversaciones guardadas se muestran igual.
- **Copiar respuesta.** Un icono bajo cada respuesta, a la izquierda, copia solo la respuesta final con su Markdown y su código.
- **Un único botón en el compositor.** Envía el mensaje, cancela la ejecución si el compositor está vacío o añade el borrador a la cola mientras el agente trabaja. Enter nunca cancela y un doble clic no envía ni encola dos veces.
- **Actualización desde 1.0.3.** En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Clearer conversation.** Progress messages written by Claude Code and Codex now appear directly in the chat. Commands, file reads, file changes and tools are grouped between those messages in compact sections ("3 files read", "2 files changed · 1 command run"), in their real order. Saved conversations display the same way.
- **Copy response.** An icon below each response, on the left, copies only the final response with its Markdown and code.
- **One composer button.** It sends the message, cancels the run when the composer is empty or adds the draft to the queue while the agent works. Enter never cancels and a double click never sends or queues twice.
- **Updating from 1.0.3.** Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.3

### Español

- **Graphite Glass.** La conversación, el compositor, los paneles, Workbench y Ajustes adoptan superficies negras y grafito con acentos en verde lima. Los estados y controles comparten el mismo lenguaje visual.
- **Identidad Dominó.** El nuevo logo V2 aparece en la aplicación y en los iconos del ejecutable, el instalador y los accesos directos de Windows.
- **Interfaz en español e inglés.** Duovra sigue inicialmente el idioma de Windows. Puedes cambiarlo en Ajustes sin reiniciar y la elección se conserva. Las fechas, los números y los avisos se adaptan al idioma.
- **Correcciones de localización.** Se traducen mensajes adicionales del actualizador, los avisos, Workbench y la cola, incluidos mensajes con datos de contexto.
- **Actualización desde 1.0.2.** El instalador reutiliza el perfil de Windows. En una instalación existente, busca la actualización firmada en Ajustes. Si usas el ZIP portátil, descarga y extrae el nuevo ZIP.

### English

- **Graphite Glass.** The conversation, composer, panels, Workbench and Settings now use black and graphite surfaces with lime accents. Controls and states share a consistent appearance.
- **Domino identity.** The new V2 logo appears in the app and in the icons for the executable, installer and Windows shortcuts.
- **Spanish and English interface.** Duovra initially follows the Windows language. Change it in Settings without restarting and Duovra remembers your choice. Dates, numbers and notifications follow the selected language.
- **Localization fixes.** Additional messages from the updater, notifications, Workbench and the queue are translated, including messages with contextual details.
- **Updating from 1.0.2.** The installer reuses the Windows profile. Check Settings for the signed update in an existing installation. If you use the portable ZIP, download and extract the new ZIP.

## 1.0.2

- **Exportar conversación.** Desde el menú de cada conversación de la barra lateral guardas un archivo Markdown con el título, la fecha de cada mensaje, las respuestas completas de Claude Code y Codex, su agente y modelo cuando se conocen, los bloques de código y las referencias a archivos adjuntos. Se lee de los datos guardados y la exportación es local.
- **Notificaciones de Windows.** Recibes un aviso del sistema cuando un agente termina, falla o necesita tu autorización mientras miras otra conversación. Pulsar el aviso abre esa conversación. Puedes desactivarlas en Ajustes → Actualizaciones y avisos. Los avisos no muestran prompts ni respuestas.
- **Copias de seguridad.** En Ajustes → Datos y diagnóstico puedes crear un archivo `.duovra` con proyectos, conversaciones, mensajes, borradores, preferencias y fondos personalizados, y restaurarlo después de validarlo y confirmarlo. Duovra guarda antes una copia del estado actual y se reinicia para aplicar la restauración. Las carpetas de código y las credenciales de Claude Code y Codex no se incluyen.

## 1.0.1

- Envía reportes de errores desde Duovra con consentimiento explícito y una captura opcional. El texto se registra en un repositorio privado y las capturas se guardan en almacenamiento privado.
- Activa las actualizaciones firmadas desde GitHub Releases. Puedes ver las notas y confirmar la instalación. Duovra espera a que terminen las tareas activas antes de instalar.
- Si usas Duovra 1.0.0, descarga e instala 1.0.1 manualmente desde GitHub Releases. El instalador conserva el mismo perfil de Windows. Las futuras actualizaciones se podrán instalar desde Duovra.

## 1.0.0

**Duovra — First Stable Release**

- Switch between Claude Code and OpenAI Codex in the same conversation, with a per-message model and reasoning selector, streamed activity and inline permissions.
- Queue work while a turn runs, review interrupted tasks after restarting and steer supported Codex turns.
- Use Workbench for project files, Git changes and diffs, static HTML and SVG previews, Mermaid and supported widgets.
- Customize background patterns and presets or import a local image. Hybrid mascots react to the state of each turn.
- Install on Windows x64 with NSIS or extract the portable ZIP. Both packages share the existing Duovra prerelease profile. Older SQLite schemas receive a backup before migration.
- The 1.0.0 downloads are unsigned and use manual updates through GitHub Releases.

## 0.6.0

**Duovra 0.6.0.** Nueva dirección visual de superficies oscuras estables, conversación central y Workbench bajo demanda.

- **Campo de luz.** Campo dither localizado con reacciones a la actividad de los agentes, pausa entre eventos, fallback a Canvas 2D y opción de apagarlo.
- **Conversación.** Autoría visible en hilos compartidos, actividad agrupada y permisos diferenciados por proveedor. Archivos, diffs y salidas se consultan en Workbench.
- **Compositor.** Selección manual de agente, catálogo por proveedor y niveles de razonamiento en un control segmentado.
- **Mascotas.** Expressive Studio cerca del compositor y Minimal Vector en cabeceras, lista y selector.
- **Apertura.** Logotipo original de Duovra, textura de puntos y entrada breve con opción de omitirla.
- **Superficies.** Se retiran las lentes SVG, el material refractivo, los fondos anteriores y los ajustes ópticos. El matiz, la densidad, la escala y el contraste se aplican al sistema visual de Duovra.
- **Workbench.** Explorador, cambios Git staged y unstaged, diffs del turno, búsqueda local y global, paleta de comandos, referencias `@` y acciones `/`.
- **Cola por conversación.** Captura la cuenta, el modelo y el esfuerzo. Tras un cierre inesperado, los encargos se revisan antes de reanudar. Los turnos compatibles de Codex admiten Steer.
- **Actividad y vistas.** Planes, subagentes, contexto y estadísticas por turno. Workbench admite HTML y SVG aislados, diagramas Mermaid y widgets declarativos con controles locales.
- **Actualización desde 0.5.1.** Se guarda un respaldo de SQLite antes de migrar. Se endurece la asociación de los permisos de Codex con su turno y se estabilizan el guardado de borradores y las referencias durante la búsqueda.

## 0.5.1

**Duovra 0.5.1 — Dark Liquid Glass + Dot Matrix Flow.** A visual release on top of the 0.5.0 performance work: a new background that answers your clicks, glass that really refracts what is behind it, and a configurable accent hue.

- **Dot Matrix Flow background (default for new installs).** A dark, regular matrix of small white dots that stays still at rest (nothing is drawn). Each click sends a wave in your accent hue: it opens from a small burst into a ring, expands, curls into ribbons and arcs, pushes the dots aside and fades, leaving a soft grey halftone wake. Several clicks overlap naturally. Moving the mouse does not create waves or trails. Updating from 0.5.0 keeps Aurora; you can switch in *Settings → Appearance → Background*.
- **Optical Liquid Glass.** The sidebar, composer, context panel, settings and selection pills are now drawn by the background renderer itself: their curved edges bend and compress the dots behind them, with light dispersion on the rim, Fresnel reflections that pick up nearby waves, a specular highlight that leans toward the cursor and a soft contact shadow. Inside, the glass is clear and dark, so the background stays visible but crisp and quiet behind the text. Moving pills stretch like a liquid while they travel. Menus and dialogs refract what is behind them with an SVG displacement lens. Works with both Dot Matrix Flow and Aurora.
- **Accent hue.** Cold white, Soft cyan (default), Ice blue, Soft violet, Lavender or Mint. It tints the click waves, glass highlights, your message bubble, selections, pills, switches, focus rings and the send button. Reading text, code, diffs and agent colours do not change.
- **Settings.** *Appearance* gains *Background* (Dot Matrix Flow / Aurora), *Click wave* (Subtle / Medium / Vivid), *Interactive background* and *Accent hue*. With reduced motion or the interactive background off, Dot Matrix Flow shows a still image.
- **Dependencies.** Vaso is no longer used: the composer's refraction is now part of the shared glass optics.

Performance figures for 0.5.1 are preliminary (few runs on one machine): see [docs/performance.md](https://github.com/yagues1/duovra/blob/main/docs/performance.md#051-dot-matrix-flow-y-liquid-glass-óptico-mediciones-preliminares).

Updates from 0.5.0 install automatically from the signed channel, with the installer's basic interface.

## 0.5.0

**Duovra 0.5.0 — Performance Update.** A performance release: every feature, the layout and the approved 0.4.0 look stay the same, while streaming, the aurora and the glass cost less.

- **Smoother streaming.** Only the active answer follows each streamed token; the history is a memoized list, and the composer, sidebar and conversation rows subscribe only to the values they show. With *Full* intensity, frames above 50 ms while streaming dropped from 8.5 to 0 (median) and the frame p99 from 53 ms to 19 ms.
- **Less GPU for the aurora.** The noise terms that depend only on the horizontal position and time are computed once per column in a small floating-point texture instead of for every pixel, with pixel-identical output (verified in WebGL 2 and WebGL 1). Without renderable float textures the aurora keeps the per-pixel path. GPU use is 8–12 points lower than in 0.4.0 at idle, while scrolling and while streaming in *Balanced*.
- **Cheaper light sampling.** Ambient light for the glass is read back asynchronously (PBO + fence in WebGL 2), and the CSS light variables are only written when they change.
- **Background recovers after GPU resets.** If Windows or the driver resets the WebGL context, the aurora now rebuilds its resources and keeps animating instead of leaving a black background.
- **Lighter typing and storage.** Drafts are kept in memory and saved after a short pause, so typing no longer re-renders the app; database and file commands no longer block the main thread. Repeated code blocks reuse their syntax highlighting from a bounded cache.
- **Background and glass decoupled.** The background renderer and the Liquid Glass material now meet through a small contract (`src/lib/background.ts`), so other backgrounds can be added later. Aurora 2.0 is unchanged.

Measured in WebView2 release builds on one machine against 0.4.0, with simulated agents: see [docs/performance.md](https://github.com/yagues1/duovra/blob/main/docs/performance.md).

Updates from 0.3.x and 0.4.0 install automatically from the signed channel, with the installer's basic interface.

## 0.4.0

**Duovra 0.4.0 — Visual Experience.** A visual release: the layout, navigation and every feature of 0.3.1 stay exactly the same, while the materials, light and motion of the whole app are rebuilt.

- **Liquid Glass 2.0.** One material system in three levels. Premium glass for the sidebar, composer, contextual panel, settings, menus and dialogs; interactive glass for buttons, pills, selectors, switches and segmented controls; reading glass for messages, code, diffs and terminal output. Fresnel rims, specular highlights, a visible bevel and soft caustics.
- **Real refraction.** Besides the composer lens, the sidebar, contextual panel and settings now have optical edges: the background visibly bends along their borders, like thick glass. It is drawn by the aurora shader itself, with no extra SVG filters, and follows the *Glass refraction* setting.
- **Glass that reacts to its surroundings.** Rims, caustics and controls take the tint of the light behind each surface, sampled from the background a few times per second.
- **Aurora 2.0.** A more cinematic background with real depth: a slow, distant nebula, folded light curtains shaded by their slope, an electric-blue veil and two silk-like light sheets, with slow colour drift and a very subtle response to the cursor. The reading column behind the conversation stays calm and comfortable.
- **Smoother motion.** Shared spring animations for agent switching, conversation and settings selection, panel tabs and segmented controls. Transitions are interruptible and never scale text.
- **Polished screens.** Refined title bar, buttons and inputs, sidebar hover and selection, chat bubbles, code blocks and changed-files cards, a reading plate under code and diffs in the side panel with calmer diff colours, settings navigation, cards, separators and switches, dialogs and empty states.
- **Refined identity.** The Duovra mark keeps its two glass shapes and gains a glass rim and an inner caustic, with regenerated app icons. Empty states show it on a glass tile.
- **Performance.** Measured in WebView2 against 0.3.1 on the same machine: identical idle frame rate and comparable frame rates while interacting. Optical edges read their geometry from a cache instead of every frame. *Reduced* intensity, the refraction switch and Windows' reduced-motion and transparency preferences still turn the heavier effects off, and *Automatic* lowers the intensity if performance drops.
- **Fix.** The "jump to end" button no longer appears in an empty conversation after leaving a long one.

Updates from 0.3.x install automatically from the signed channel, with the installer's basic interface.

## 0.3.1

- **Stable model picker.** The model menu no longer morphs from the button. It opens and closes with a short fade and slide, never distorts text, keeps its position and height, and works reliably when opened and closed quickly or right after switching between Claude Code and Codex.
- **Liquid Glass dropdowns.** Every settings dropdown and the report category use a new glass Select (built on Radix Select) instead of the operating system menu: keyboard navigation, focus return, collision handling and scrolling included.
- **Liquid Glass sliders.** Appearance sliders use a new glass Slider (built on Radix Slider) with mouse, touch and keyboard support. Dragging previews the change live and saves once on release.
- **Redesigned bug report form.** Compact layout with a fixed header and actions, discreet version and platform, custom attachment area, styled consent, sending indicator, confirmation and error states. It fits small windows without horizontal scrolling.
- **Calmer aurora.** Highlight peaks are compressed, light filaments fade across the reading column and a soft shade sits behind conversations and the welcome screen. Movement, palette and all aurora settings still apply.
- **Cleaner composer.** The keyboard hints next to Send are gone; Enter and Shift+Enter (or Ctrl+Enter) work as before.
- **Updater.** Windows updates keep the installer's basic interface (`basicUi`), which avoided the Microsoft Defender block seen with the passive mode.

## 0.3.0

- **Redesigned Settings.** Opening Settings collapses the project sidebar into a compact icon rail, shows a grouped category list and gives the content the rest of the window. Returning to the chat restores the sidebar as it was. At 760 × 520 the categories become a scrollable strip.
- **Much more personalisation.** Liquid Glass opacity, reflections, compositor refraction and high-contrast material; aurora on/off, palette (Duovra, Glaciar, Nebulosa, Abisal), brightness and speed; density, text size (WebView zoom, capped so the window stays usable), conversation width and code size; Enter or Ctrl+Enter to send; start-up screen and conversation restore. Everything applies instantly and persists.
- **New update experience.** A discreet sidebar indicator opens the release notes. "Update now" shows a full-screen Liquid Glass progress screen with real byte progress, signature verification, a safe wait for running agents and saved drafts, then hands over to the Windows installer, which shows its progress and reopens Duovra. On reopening, Duovra confirms the installed version.
- **Production update channel.** Builds now trust the permanent Duovra signing key and read signed releases from GitHub Releases over HTTPS.
- **In-app bug reports.** The report form no longer opens GitHub or a browser. It shows exactly what will be sent, keeps the draft across restarts and retries, and sends over HTTPS to the Duovra report service (private intake repository). Builds without the service configured say so instead of pretending to send.
- **Task notifications.** Optional in-app notice and taskbar highlight when an agent finishes in the background.
- **Installer.** NSIS installer in Spanish, with the desktop shortcut option on the finish page; updates keep existing shortcuts.

## 0.2.0

- **Duovra.** Duovra introduces its own logo and Windows icon. Existing projects, conversations, drafts and settings keep working: the internal application identifier and data folder are unchanged.
- **Dynamic aurora background.** A WebGL aurora replaces the static background. It runs at a capped frame rate, pauses when the window is hidden and renders one still frame in reduced intensity or with reduced motion.
- **Liquid Glass across the app.** Settings navigation and cards, project and change cards, and approval requests now share the glass material, with specular rims and depth.
- **Settings layout fix.** Content no longer scrolls past the bottom edge of the settings panel. The glass shell stays fixed and only its content scrolls. Wide tables scroll horizontally.
- **Agent identity.** Claude Code and Codex use consistent glass badges with neutral glyphs and text names. Third-party logos were removed.
- **Open source.** MIT license, contribution guide, security policy, issue templates and CI for pull requests.

## 0.1.1

- Reportes de errores desde la barra lateral, con vista previa de la captura y consentimiento cuando hay un servicio configurado.
- Actualizaciones de Windows verificadas con Tauri. La instalación se inicia desde la aplicación y espera a que terminen las tareas de los agentes.
- Identificación de Claude Code y Codex en el selector, los mensajes y Ajustes.
- Compilación Windows en GitHub Actions y preparación manual de versiones firmadas.

## 0.1.0

- Primera versión funcional de escritorio con historial local y selector de agente y modelo por mensaje.

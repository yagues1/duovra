# Changelog

All notable changes to Duovra are documented here. Older entries keep their original language.

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

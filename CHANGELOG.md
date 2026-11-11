# Changelog

All notable changes to Duovra are documented here. Older entries are kept in their original language (Spanish).

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

- **Duovra.** The project formerly called Claude-Codex-Studio is now Duovra, with its own logo and Windows icon. Existing projects, conversations, drafts and settings keep working: the internal application identifier and data folder are unchanged.
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

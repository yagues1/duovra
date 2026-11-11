# Changelog

All notable changes to Duovra are documented here. Older entries are kept in their original language (Spanish).

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

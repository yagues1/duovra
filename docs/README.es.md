# Duovra

Duovra reúne **Claude Code** y **OpenAI Codex** en una aplicación de escritorio para Windows. Añade una carpeta como proyecto y elige el agente, el modelo y el esfuerzo en cada mensaje. Los dos agentes pueden continuar la misma conversación.

La versión **1.0.0** incluye respuestas en streaming, permisos en el hilo, cola por conversación, Workbench con archivos y cambios Git, fondos de patrón configurables y mascotas que reaccionan al estado del turno.

## Instalar y empezar

1. En Windows 11 x64, asegúrate de tener WebView2 Evergreen y al menos una de las dos CLI oficiales instaladas e iniciadas con tu cuenta. [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) · [Claude Code](https://code.claude.com/docs/en/setup) · [Codex](https://developers.openai.com/codex/cli)
2. Descarga `Duovra-1.0.0-windows-x64-setup.exe` de la versión 1.0.0. El instalador y el ZIP portable carecen de firma Authenticode. [GitHub Releases](https://github.com/yagues1/duovra/releases)
3. Abre **Ajustes → Agentes y modelos** para comprobar que se detectan las CLI. Añade una carpeta como proyecto, pulsa `Ctrl+N` y selecciona un agente en el compositor.

Si venías de una Beta de Duovra, ciérrala y copia `%APPDATA%\dev.duovra.studio.beta` antes de instalar. La versión estable abrirá ese mismo perfil. Al desinstalar una Beta, conserva los datos de la aplicación.

[README y capturas](../README.md) · [Compilación, instalación y privacidad](distribution.md) · [Cambios](../CHANGELOG.md) · [Licencia MIT](../LICENSE)

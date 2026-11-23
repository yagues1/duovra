# Duovra

Duovra reúne **Claude Code** y **OpenAI Codex** en una aplicación de escritorio para Windows. Añade una carpeta como proyecto y elige el agente, el modelo y el esfuerzo en cada mensaje. Los dos agentes pueden continuar la misma conversación.

La versión **1.0.3** incorpora Graphite Glass, el logo Dominó y la interfaz en español e inglés. Duovra sigue inicialmente el idioma de Windows. Puedes cambiarlo desde Ajustes sin reiniciar.

## Instalar y empezar

1. En Windows 11 x64, asegúrate de tener WebView2 Evergreen y al menos una de las dos CLI oficiales instaladas e iniciadas con tu cuenta. [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) · [Claude Code](https://code.claude.com/docs/en/setup) · [Codex](https://developers.openai.com/codex/cli)
2. Descarga el instalador o extrae el ZIP portátil completo. Si ya tienes 1.0.2 instalada, puedes buscar la actualización firmada en **Ajustes → Actualizaciones y avisos**. El ejecutable y el instalador carecen de firma Authenticode. [Última versión en GitHub](https://github.com/yagues1/duovra/releases/latest)
3. Abre **Ajustes → Agentes y modelos** para comprobar que se detectan las CLI. Añade una carpeta como proyecto, pulsa `Ctrl+N` y selecciona un agente en el compositor.

Si venías de una Beta de Duovra, ciérrala y copia `%APPDATA%\dev.duovra.studio.beta` antes de instalar. La versión estable abrirá ese mismo perfil. Al desinstalar una Beta, conserva los datos de la aplicación.

[README](../README.md) · [Compilación, instalación y privacidad](distribution.md) · [Cambios](../CHANGELOG.md) · [Licencia MIT](../LICENSE)

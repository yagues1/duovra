# Duovra

Duovra reúne **Claude Code** y **OpenAI Codex** en una aplicación de escritorio para Windows. Añade una carpeta como proyecto y elige el agente, el modelo y el esfuerzo en cada mensaje. Los dos agentes pueden continuar la misma conversación.

La versión **1.0.10** añade un botón para apoyar el proyecto desde la barra lateral, que abre el apartado de apoyo de la web oficial; Duovra sigue siendo gratuito y open-source. La 1.0.9 añadió Git Worktrees para trabajar en varias ramas en paralelo y Live Preview, un navegador integrado en Workbench con inspector, capturas, consola, red y simulación de tamaños que envía contexto al agente. También renueva el compositor, los permisos rápidos y la barra superior, y evita acumular conversaciones vacías. [Registro de cambios](../CHANGELOG.md)

## Instalar y empezar

1. En Windows 11 x64, asegúrate de tener WebView2 Evergreen y al menos una de las dos CLI oficiales instaladas e iniciadas con tu cuenta. [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) · [Claude Code](https://code.claude.com/docs/en/setup) · [Codex](https://developers.openai.com/codex/cli)
2. Descarga el instalador o extrae el ZIP portátil completo. Si ya tienes 1.0.9 instalada, puedes buscar la actualización firmada en **Ajustes → Actualizaciones y avisos**. El ejecutable y el instalador carecen de firma Authenticode. [Última versión en GitHub](https://github.com/yagues1/duovra/releases/latest)
3. Abre **Ajustes → Agentes y modelos** para comprobar que se detectan las CLI. Añade una carpeta como proyecto, pulsa `Ctrl+N` y selecciona un agente en el compositor.

Si venías de una Beta de Duovra, ciérrala y copia `%APPDATA%\dev.duovra.studio.beta` antes de instalar. La versión estable abrirá ese mismo perfil. Al desinstalar una Beta, conserva los datos de la aplicación.

## Apoyar Duovra

Duovra es gratuito y open-source con licencia MIT, y seguirá siéndolo: sin funciones de pago, sin límites y sin ventajas para quien aporte. Si quieres ayudar a mantenerlo, puedes contribuir desde una de estas plataformas; los pagos se gestionan íntegramente en ellas. [Apartado de apoyo](https://duovra.vercel.app/#support)

<a href="https://ko-fi.com/duovra"><img src="https://img.shields.io/badge/Ko--fi-Inv%C3%ADtame%20a%20un%20caf%C3%A9-c4f25a?logo=ko-fi&logoColor=white&labelColor=1c1e21" alt="Apoyar Duovra en Ko-fi"></a> <a href="https://giveth.io/project/duovra"><img src="https://img.shields.io/badge/Giveth-Donar%20con%20cripto-c4f25a?labelColor=1c1e21" alt="Apoyar Duovra en Giveth"></a> <a href="https://github.com/yagues1/duovra"><img src="https://img.shields.io/github/stars/yagues1/duovra?style=flat&color=c4f25a&labelColor=1c1e21&logo=github" alt="Dar una estrella a Duovra en GitHub"></a>

- **Ko-fi:** una aportación a través de PayPal.
- **Giveth:** una aportación en criptomonedas.
- **Gratis:** una estrella en GitHub también marca la diferencia.

[README](../README.md) · [Compilación, instalación y privacidad](distribution.md) · [Cambios](../CHANGELOG.md) · [Licencia MIT](../LICENSE)

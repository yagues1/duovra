<h1 align="center">Duovra</h1>

<p align="center">
  <strong>Claude Code y OpenAI Codex en un mismo espacio de trabajo para Windows.</strong><br>
  Abre un proyecto y elige quién responde a cada mensaje en la misma conversación.
</p>

<p align="center">
  <a href="https://github.com/yagues1/duovra/releases/latest"><strong>Descargar para Windows</strong></a> ·
  <a href="https://duovra.vercel.app/">Web oficial</a> ·
  <a href="../README.md" lang="en">English</a>
</p>

<p align="center">
  <a href="https://github.com/yagues1/duovra/releases/latest"><img src="https://img.shields.io/github/v/release/yagues1/duovra?display_name=tag&amp;label=versi%C3%B3n&amp;color=526829" alt="Última versión"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/github/license/yagues1/duovra?label=licencia&amp;color=526829" alt="Licencia MIT"></a>
  <a href="#descargar-y-empezar"><img src="https://img.shields.io/badge/plataforma-Windows%2011%20x64-526829" alt="Windows 11 x64"></a>
  <a href="https://github.com/yagues1/duovra/releases"><img src="https://img.shields.io/github/downloads/yagues1/duovra/total?label=descargas&amp;color=526829" alt="Descargas totales de archivos de releases en GitHub"></a>
</p>

<p align="center">
  <a href="screenshots/1.0.10/conversation.webp"><img src="screenshots/1.0.10/duovra-hero.webp" width="1280" height="700" alt="Abre la captura a tamaño completo de Duovra, con Claude Code y Codex en una conversación junto a un diff de Git. Aura y Flujo enmarcan la ventana."></a>
</p>

Duovra es una aplicación de escritorio gratuita y de código abierto para las CLI oficiales de Claude Code y Codex. Elige agente, modelo y esfuerzo en el compositor. Duovra pasa el contexto reciente cuando cambias de agente y guarda tus proyectos, borradores e historial de conversaciones en tu equipo.

## Claude Code y Codex

Cambia de agente en mitad de una conversación. Sigue las respuestas y la actividad de herramientas en directo, revisa las solicitudes de aprobación, detén una ejecución o pon el próximo mensaje en cola.

<p><a href="screenshots/1.0.10/conversation.webp"><img src="screenshots/1.0.10/agents.webp" width="760" alt="Mensajes de Claude Code y Codex en una conversación, con un aviso de contexto compartido entre turnos."></a></p>

<details>
<summary>Ver el cambio de Claude Code a Codex</summary>

![El compositor abre el selector, cambia de Claude Code a Codex y muestra a Flujo sin salir de la conversación.](screenshots/1.0.10/switch-agent.gif)

[Abrir el GIF del cambio de agente](screenshots/1.0.10/switch-agent.gif)

</details>

## Git Worktrees

Crea o importa worktrees de Git y vincula las conversaciones, los archivos, los cambios y las vistas previas a la carpeta de cada rama.

<p><img src="screenshots/1.0.10/worktrees.webp" width="605" alt="El menú de Fieldnotes muestra las opciones para crear o importar un worktree junto a la rama Trail theme."></p>

## Live Preview

Abre un servidor de desarrollo local dentro de Workbench. Inspecciona elementos, consulta la consola y la actividad de red, simula tamaños de pantalla o adjunta capturas al siguiente mensaje.

<p><img src="screenshots/1.0.10/live-preview.webp" width="760" alt="El proyecto de ejemplo Fieldnotes en Live Preview ampliado, con sus controles de navegación e inspección."></p>

<details>
<summary>Ver el inspector de Live Preview</summary>

![Live Preview selecciona el encabezado de Fieldnotes y abre el panel del elemento con su selector y las acciones disponibles.](screenshots/1.0.10/live-inspector.gif)

[Abrir el GIF del inspector](screenshots/1.0.10/live-inspector.gif)

</details>

## Workbench

Explora archivos, revisa cambios y diffs de Git, y abre diagramas, vistas estáticas y widgets compatibles. Usa la búsqueda de conversaciones, la paleta de comandos y las referencias a archivos para moverte por tu espacio. Duovra muestra el uso y los límites cuando las CLI los proporcionan.

<p><img src="screenshots/1.0.10/workbench.webp" width="760" alt="Workbench muestra los archivos del worktree Trail theme junto a la conversación."></p>

## Personalización

Personaliza Graphite Glass con patrones incluidos o una imagen local, ajusta el movimiento y cambia entre inglés y español desde Ajustes.

<p><img src="screenshots/1.0.10/appearance.webp" width="760" alt="Ajustes de apariencia con el idioma, los fondos disponibles y Duovra Original seleccionado."></p>

Las imágenes y demos muestran Duovra 1.0.10 con un proyecto y una conversación de ejemplo.

## Descargar y empezar

Duovra funciona en **Windows 11 x64** y requiere [WebView2 Evergreen](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

1. Descarga el instalador por usuario o extrae el ZIP portátil completo desde la [última versión](https://github.com/yagues1/duovra/releases/latest).
2. Instala al menos una de las CLI oficiales e inicia sesión. Usa `claude auth login` para [Claude Code](https://code.claude.com/docs/en/setup) o `codex login` para [Codex](https://developers.openai.com/codex/cli). Instala ambas para alternarlas durante una conversación. El acceso a modelos y la facturación dependen de tu cuenta con cada proveedor.
3. Abre **Ajustes → Agentes y modelos** para comprobar que Duovra detecta las CLI. Elige **Añadir carpeta como proyecto**, pulsa `Ctrl+N` y selecciona agente, modelo y esfuerzo en el compositor.

Windows SmartScreen puede aparecer porque el ejecutable y el instalador carecen de firma Authenticode. Para buscar actualizaciones firmadas desde la app, abre **Ajustes → Actualizaciones y avisos**. Si vienes de la beta, haz primero una copia de tu perfil. [Guía de distribución para Windows](distribution.md)

## Privacidad y permisos

Duovra guarda los datos del espacio de trabajo en SQLite, en tu equipo. Las CLI se encargan de la autenticación y pueden enviar al proveedor el mensaje, contexto de la conversación, adjuntos o información del proyecto durante un turno. Revisa los comandos y cambios de archivos antes de aprobarlos. [Datos locales y privacidad](distribution.md#reportes-y-privacidad) · [Reportar un problema de seguridad](../SECURITY.md)

## Apoyar Duovra

Duovra es gratuito y de código abierto. Todas las funciones están disponibles para todo el mundo. Puedes ayudar abriendo un issue, dando una estrella al repositorio o aportando en una de estas plataformas, donde se gestionan los pagos. [Apartado oficial de apoyo](https://duovra.vercel.app/#support)

<p>
  <a href="https://ko-fi.com/duovra"><img src="https://img.shields.io/badge/Ko--fi-Apoyar%20Duovra-526829?logo=ko-fi&amp;logoColor=white" alt="Apoyar Duovra en Ko-fi"></a>
  <a href="https://giveth.io/project/duovra"><img src="https://img.shields.io/badge/Giveth-Donar%20con%20cripto-526829" alt="Apoyar Duovra en Giveth"></a>
</p>

## Compilar y contribuir

Duovra usa Tauri 2, React, TypeScript, Rust y SQLite. [Compilar desde el código fuente](distribution.md#compilar-y-preparar-una-release) · [Arquitectura](architecture.md) · [Integración con agentes](agent-integration.md) · [Contribuir](../CONTRIBUTING.md) · [Registro de cambios](../CHANGELOG.md)

## Licencia

[MIT](../LICENSE). Los componentes de terceros conservan sus propias condiciones. Consulta los [avisos de terceros](../THIRD_PARTY_NOTICES.md).

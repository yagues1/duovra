# Herramientas disponibles

Inventario del entorno en el momento de la preparación (2026-11-06). Nada de esto se ha cambiado en configuraciones globales.

## Instaladas en el equipo

| Herramienta | Ruta detectada | Uso previsto |
|---|---|---|
| Git | `C:\Program Files\Git\cmd\git.exe` | Control de versiones (repositorio inicializado en rama `chore/project-setup`) |
| Node.js | `C:\Program Files\nodejs\node.exe` | Stack React/TypeScript (aún no instalado el proyecto) |
| npm | `C:\Program Files\nodejs\npm.ps1` | Gestor de paquetes; no se ha instalado ninguna dependencia |
| Claude Code CLI | `%USERPROFILE%\.local\bin\claude.exe` | Agente 1 de la aplicación |
| Codex CLI | `%USERPROFILE%\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` | Agente 2 de la aplicación |
| Rust 1.99.1 (rustup, `x86_64-pc-windows-gnu`) | `%USERPROFILE%\.cargo\bin` (instalado el 2026-11-07 sin modificar el PATH global) | Backend Tauri |

## MCP y herramientas de la sesión de Claude

| Herramienta | Estado | Uso previsto en el proyecto |
|---|---|---|
| Playwright (MCP `mcp__playwright__*`) | Conectado en esta sesión | Inspección visual y pruebas de interfaz |
| Skill `playwright-cli` (en el proyecto) | Instalada, sin CLI instalada | Alternativa documentada y local al MCP |
| Claude in Chrome | Disponible | Navegación en la web del usuario; no es necesario para el proyecto |
| Navegador integrado de Claude | Disponible | Previsualizar páginas locales cuando existan |
| Computer use | Disponible | Solo para apps nativas; no se usa en el desarrollo normal |

## Decisiones

- **No se ha añadido ningún MCP al proyecto** (`.mcp.json` no existe). Playwright ya está disponible en la sesión; la skill `playwright-cli` cubre el uso local. Si se quiere fijar un MCP en el proyecto, debe decidirse explícitamente.
- **No se instala ningún MCP ni servicio de coordinación entre Claude y Codex**, según lo acordado.
- Stack instalado como dependencias del proyecto (`package.json`, `src-tauri/Cargo.toml`). Nada global salvo rustup en el perfil del usuario.
- Pruebas de interfaz contra la app real: WebView2 admite depuración remota (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`) y `playwright-core` se conecta por CDP (`chromium.connectOverCDP`). Así se verificaron los flujos con el backend real.
- **`npm install -g @playwright/cli`** no se ha ejecutado.

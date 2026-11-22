<div align="center">
  <img src="assets/brand/duovra-icon.svg" width="104" height="104" alt="">
  <h1>Duovra</h1>
  <p><strong>One Windows workspace for Claude Code and OpenAI Codex.</strong></p>
  <p><a href="https://github.com/yagues1/duovra/releases">Download</a> · <a href="#quick-start">Quick start</a> · <a href="docs/distribution.md">Build from source</a> · <a href="docs/README.es.md">Español</a></p>
  <p><a href="https://github.com/yagues1/duovra/actions/workflows/ci.yml"><img src="https://github.com/yagues1/duovra/actions/workflows/ci.yml/badge.svg" alt="CI status"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7b8cff.svg" alt="MIT license"></a> <img src="https://img.shields.io/badge/platform-Windows%20x64-6f7bff.svg" alt="Windows x64"></p>
</div>

Duovra lets you ask Claude Code to work on a project and hand the conversation to Codex for the next message. You choose the agent, model and reasoning effort in the composer. The app runs the official CLIs with your existing accounts and passes recent conversation context when you switch agents.

![Duovra on Windows showing a shared conversation with Codex and Claude Code over the Vivid background](docs/screenshots/1.0.0/conversation.png)

<sub>Duovra 1.0.0 running in WebView2 with example data. <a href="docs/screenshots/1.0.0/appearance.png">See the background gallery in Settings.</a></sub>

## Features

| | |
| --- | --- |
| Shared conversations | Open local folders as projects, switch agents within a conversation, and return to your history and drafts. |
| Live execution | Follow streamed responses and tool activity, review approval requests inline, and stop runs from the composer. |
| Task queue | Queue the next message while an agent is working. Review interrupted tasks after a restart. Supported Codex turns can also accept steering. |
| Workbench | Browse project files, inspect Git changes and diffs, and preview Mermaid diagrams, static HTML and SVG, and supported declarative widgets. |
| Search and usage | Search conversations, use the command palette and file references, and inspect activity, usage and provider limits when reported by the CLIs. |
| Appearance | Tune patterned backgrounds, import a local image, and adjust animation or switch it off. Agent mascots respond to the state of a turn. |

## Installation

**Version 1.0.0** is the first stable Duovra release. The tested platform is Windows 11 x64. Install the Microsoft Edge WebView2 Evergreen Runtime if it is missing. [Microsoft WebView2 downloads](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

Install at least one native Windows CLI and sign in. Install both to switch between providers in the same thread. Model access and billing follow your own provider plan.

- **Claude Code** uses the `claude` executable. Sign in from the CLI with `claude auth login`. [Claude Code setup](https://code.claude.com/docs/en/setup)
- **OpenAI Codex** uses the `codex` executable. Sign in with `codex login`. [Codex CLI setup](https://developers.openai.com/codex/cli)

From the **v1.0.0** release, download `Duovra-1.0.0-windows-x64-setup.exe` and run the per-user installer. The portable ZIP runs after extraction and uses the same Windows user profile as the installer. The packages are unsigned and Windows may show a SmartScreen warning. For checksum verification, update instructions and the location of previous profiles, see the [Windows distribution guide](docs/distribution.md). [GitHub Releases](https://github.com/yagues1/duovra/releases)

## Quick start

1. Launch **Duovra** and open **Settings → Agents and models** (*Ajustes → Agentes y modelos*). Confirm the app detects the CLIs or set a custom executable path.
2. Choose **Add folder as project** (*Añadir carpeta como proyecto*). Create a conversation with `Ctrl+N`.
3. Select the agent, model and reasoning effort in the composer. Send a message and review approvals as they appear.
4. Open Workbench to see activity, files or changes. Use **Settings → Appearance** (*Apariencia*) to select a background or adjust motion.

The desktop interface is in Spanish.

## Privacy and permissions

Duovra stores projects, conversations, drafts, settings, local background images and execution records in SQLite under your Windows user profile. The CLIs manage authentication. When you send a message, your chosen CLI may transmit its prompt, shared context, attachments or project information under the provider's policies and your CLI permissions. Review the permissions before approving commands or file changes. [Privacy and data locations](docs/distribution.md#privacy-and-local-data) · [Security reporting](SECURITY.md)

## Development and contributing

Duovra uses Tauri 2 and WebView2, React 19 and TypeScript, Rust with Tokio, and SQLite. Start with the [Windows build instructions](docs/distribution.md#build-from-source), [architecture](docs/architecture.md) or [agent integration notes](docs/agent-integration.md). See [Contributing](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

Duovra's own code is distributed under the [MIT License](LICENSE). Third-party components retain their own terms. [Third-party notices](THIRD_PARTY_NOTICES.md)

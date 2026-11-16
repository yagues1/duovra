<div align="center">

<img src="assets/brand/duovra-icon.svg" width="112" height="112" alt="Duovra logo: two overlapping glass shapes">

# Duovra

**One workspace. Your coding agents.**

An open-source desktop workspace for **Claude Code** and **OpenAI Codex**:<br>
one shared conversation, local projects, and you choose the agent for every message.

[![CI](https://github.com/yagues1/duovra/actions/workflows/ci.yml/badge.svg)](https://github.com/yagues1/duovra/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/yagues1/duovra?color=5fd4ff&label=release)](https://github.com/yagues1/duovra/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-7b8cff.svg)](LICENSE)
![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-6f7bff.svg)
![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24c8db.svg)

[**Download**](https://github.com/yagues1/duovra/releases/latest) · [Features](#features) · [Screenshots](#screenshots) · [Installation](#installation) · [Documentation](#documentation) · [Contributing](#contributing) · [Español](docs/README.es.md)

<br>

<img src="docs/screenshots/0.5.1/duovra-main.jpg" alt="Duovra 0.5.1: Claude Code edits a file and Codex reviews it in the same conversation, with a cyan click wave crossing the Dot Matrix Flow background behind the glass sidebar and composer" width="920">

<sub><b>Duovra 0.5.1 — Dark Liquid Glass + Dot Matrix Flow.</b> <a href="https://github.com/yagues1/duovra/releases/latest">Download the latest release</a> · <a href="CHANGELOG.md">What's new</a></sub>

</div>

---

## Why Duovra

Claude Code and Codex each have their own strengths. Duovra puts them side by side in one native Windows app, so you can **ask Claude Code to build something and Codex to review it, in the same thread**. Both agents see the shared history; your projects, conversations and drafts never leave your machine.

Duovra doesn't replace either tool and doesn't route or chain agents automatically. It drives the **official CLIs already installed on your computer**, with your own sign-in, plan and configuration.

## Features

| | |
|---|---|
| **Two agents, one conversation** | Switch between Claude Code and Codex message by message. The other agent receives the recent history, so it continues the same thread. |
| **Per-message model and reasoning** | Pick from the models each CLI reports for your account and the reasoning levels it supports. Each conversation remembers its choice per agent. |
| **Local projects** | Any folder can be a project, with its own conversations and restored drafts. |
| **Live timeline and cancellation** | Responses, reasoning, commands and file edits stream into a collapsible timeline. Stop a run at any moment and keep typing meanwhile. |
| **Permissions in the conversation** | Tool approvals appear inline: allow once, for the session, or deny. Sandbox and approval policies are configurable per CLI. |
| **Files, diffs and terminal output** | A contextual side panel, opened on demand, shows touched files, syntax-highlighted diffs and command output. |
| **Persistent local history** | Conversations, settings and usage records live in SQLite on your computer. There are no Duovra servers for your data. |
| **Usage at a glance** | Codex rate-limit windows as Codex reports them, plus the token counts each agent reports per message. |
| **Signed updates** | Releases are signed and published on GitHub Releases; the app checks the signed channel and installs with the Windows installer. |
| **In-app bug reports** | Report a bug from the sidebar with an explicit preview of what will be sent. No conversations, code or paths are included. |

### The visual experience

Duovra is built to be comfortable for hours of work and pleasant to look at:

- **Dot Matrix Flow.** The default background for new installs: a dark matrix of small dots that stays still at rest and answers every click with a wave in your accent hue, which opens into a ring, curls into ribbons, pushes the dots aside and fades.
- **Optical Liquid Glass.** The background renderer draws the glass itself: the sidebar, composer, panel, settings and selection pills bend the background along their curved edges, with light dispersion on the rim, Fresnel reflections and a specular highlight that leans toward the cursor. Menus and dialogs refract what is behind them through an SVG displacement filter.
- **Aurora.** The WebGL aurora of 0.5.0 is still available, with the same glass. Updating from 0.5.0 keeps it.
- **Accent hue.** Cold white, Soft cyan, Ice blue, Soft violet, Lavender or Mint for waves, highlights, selections, switches and your message bubble. Reading text, code and agent colours don't change.
- **Fluid motion.** Interruptible spring animations for agent switching, selection pills, menus, panels and settings, with no scaled text and no layout jumps.
- **Yours to tune.** Visual intensity (automatic, reduced, balanced, full), glass opacity, reflections, refraction, high contrast, background (Dot Matrix Flow or Aurora), click wave, accent hue, aurora palette, brightness and speed, density, text and code size. Windows' reduced-motion and transparency preferences are always respected.

## Screenshots

Real captures of Duovra 0.5.1 with fictitious demo data, so no real conversations or accounts appear. Screenshots of earlier designs are in [docs/screenshots/0.4.0](docs/screenshots/0.4.0) and [docs/screenshots/0.3.1](docs/screenshots/0.3.1).

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/0.5.1/duovra-violet.jpg" alt="Soft violet accent: two click waves cross behind the glass sidebar and the conversation over Dot Matrix Flow"></td>
    <td width="50%"><img src="docs/screenshots/0.5.1/duovra-composer.jpg" alt="The floating glass composer with the agent switch and the model and reasoning menu open over the dot matrix"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Dot Matrix Flow.</b> Click waves in the Soft violet hue.</sub></td>
    <td align="center"><sub><b>Composer.</b> Agent, model and reasoning per message.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/0.5.1/duovra-panel.jpg" alt="The contextual side panel showing a syntax-highlighted diff on a reading plate"></td>
    <td width="50%"><img src="docs/screenshots/0.5.1/duovra-settings.jpg" alt="Appearance settings: click wave, interactive background and the six accent hues"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Contextual panel.</b> Files, diffs and terminal output.</sub></td>
    <td align="center"><sub><b>Appearance.</b> Background, click wave and accent hue.</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/0.5.1/duovra-aurora.jpg" alt="The same conversation over the Aurora background, with the same optical glass"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>Aurora.</b> The 0.5.0 background, still available, with the same optical glass.</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/0.5.1/duovra-dotflow.webp" alt="Short animation: clicks send cyan waves through the dot matrix behind the glass while switching between Claude Code and Codex" width="640"><br>
  <sub><b>In motion.</b> Click waves behind the glass while switching agents (8 s, reduced frame rate).</sub>
</p>

## Installation

**Download:** get the latest Windows installer (`Duovra_<version>_x64-setup.exe`) from **[Releases](https://github.com/yagues1/duovra/releases)**. Installed versions from 0.3.0 onwards update themselves from the signed channel.

**Requirements**

- Windows 11 x64 (developed and tested there). Windows 10 with the Microsoft Edge WebView2 Runtime should work but hasn't been tested.
- At least one agent CLI, installed and signed in with your own account:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code/overview): `claude` on your `PATH`, then sign in with `claude` or `claude auth login`.
  - [OpenAI Codex CLI](https://developers.openai.com/codex/cli): `codex` on your `PATH`, then sign in with `codex login`.
- Model access, limits and billing are those of your own Anthropic or OpenAI plan. Duovra doesn't provide model access.

> [!NOTE]
> The installer isn't signed with an Authenticode certificate yet, so Windows SmartScreen may show a warning. Only install builds from this repository's Releases page.

## Quick start

1. Install Duovra and check that `claude` and/or `codex` work in a terminal.
2. Open **Settings → Agents** to confirm Duovra detected each CLI (you can set a custom path there).
3. **Add a project** from the project capsule in the title bar.
4. Start a conversation with **New conversation** or `Ctrl+N`.
5. In the composer, choose **Claude Code** or **Codex**, a model and a reasoning level, and send.

Shortcuts: `Ctrl+N` new conversation · `Ctrl+B` toggle sidebar · `Ctrl+,` settings · `Esc` close panel.

## How it works

```
┌──────────────────────── Duovra (Tauri 2) ────────────────────────┐
│  React + TypeScript UI  ──IPC──▶  Rust backend  ──▶  SQLite       │
│                                      │                            │
│                       ┌──────────────┴──────────────┐             │
│                       ▼                             ▼             │
│         claude  (stream-json, stdio)    codex app-server (JSON-RPC) │
└───────────────────────────────────────────────────────────────────┘
```

- Duovra launches the official CLIs as child processes. It never reads or stores your tokens.
- **You** pick the agent for each message; nothing is orchestrated automatically.
- When you switch agents, the recent conversation is passed as context. Each provider also keeps its own session and resumes where it left off.

| Layer | Stack |
|---|---|
| Shell | [Tauri 2](https://tauri.app) on WebView2 |
| UI | [React 19](https://react.dev), TypeScript, [Tailwind CSS 4](https://tailwindcss.com), [Motion](https://motion.dev), [Zustand](https://zustand.docs.pmnd.rs) |
| Materials | Liquid Glass optics drawn by the WebGL background (refraction, Fresnel, specular, dispersion), SVG displacement for floating glass, CSS fallback |
| Backend | Rust, Tokio, [rusqlite](https://github.com/rusqlite/rusqlite) (bundled SQLite) |

## Development

**Prerequisites:** Node.js 22.12+, Rust stable (MSVC toolchain recommended), Visual Studio C++ build tools, Windows 11.

```powershell
git clone https://github.com/yagues1/duovra.git
cd duovra
npm ci
npm run tauri dev     # run the app with hot reload
npm run tauri build   # release executable + NSIS installer
```

```powershell
npm run typecheck
npm test                                                  # Vitest (frontend logic)
cargo test --manifest-path src-tauri/Cargo.toml --lib     # Rust backend
```

`npm run dev` serves the UI in a browser with a mocked backend (`src/dev/mockTauri.ts`) for UI work without the agents. `node scripts/qa/visual-scenes.mjs` captures the same demo scenes in Microsoft Edge for visual comparisons.

```
src/                 React UI (components, state, styles, materials)
src/lib/aurora.ts    WebGL aurora background and optical edges
src/lib/background.ts Contract between background renderers and the glass material
src/lib/optics.ts    Lenses and ambient light shared by the aurora and the glass
src-tauri/src/       Rust backend: commands, SQLite, agent adapters
services/            Bug-report relay (Cloudflare Worker)
docs/                Architecture, agent integration, design system
assets/brand/        Logo and icon sources (generated by scripts/brand.mjs)
```

## Documentation

- [Architecture](docs/architecture.md) · [Agent integration](docs/agent-integration.md)
- [Design system and materials](docs/design-system.md) · [Design references](docs/design-references.md)
- [Distribution, updates and bug reports](docs/distribution.md) · [Compatibility](docs/compatibility.md) · [Performance](docs/performance.md)
- [Changelog](CHANGELOG.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Technical documentation is written in Spanish; this README and the changelog are in English.

## Roadmap

Goals, not promises:

- [x] Signed public release with an active update channel (0.3.x)
- [x] In-app bug reports (0.3.x)
- [x] Liquid Glass 2.0 and Aurora 2.0 (0.4.0)
- [x] Performance Update: smoother streaming, lighter aurora and glass (0.5.0)
- [x] Dot Matrix Flow, optical Liquid Glass and accent hues (0.5.1)
- [ ] English UI (the interface is currently in Spanish) and localization support
- [ ] Authenticode-signed installer
- [ ] macOS and Linux builds (Tauri supports them; the agent adapters need testing there)
- [ ] Search across conversations
- [ ] Richer diff review (accept or reject individual hunks)

## Contributing

Contributions are welcome: bug reports, fixes, documentation and focused UI improvements. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Duovra is released under the [MIT License](LICENSE). Third-party components keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

Duovra is an independent open-source project. It isn't affiliated with, endorsed by or sponsored by Anthropic or OpenAI. *Claude* and *Claude Code* are trademarks of Anthropic, PBC. *OpenAI* and *Codex* are trademarks of OpenAI. They're used only to identify the tools Duovra works with. Duovra doesn't include either company's logos.

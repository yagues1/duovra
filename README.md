<h1 align="center">Duovra</h1>

<p align="center">
  <strong>Claude Code and OpenAI Codex in one Windows workspace.</strong><br>
  Open a project and choose who handles each message in the same conversation.
</p>

<p align="center">
  <a href="https://github.com/yagues1/duovra/releases/latest"><strong>Download for Windows</strong></a> ·
  <a href="https://duovra.vercel.app/en">Official website</a> ·
  <a href="docs/README.es.md" lang="es">Español</a>
</p>

<p align="center">
  <a href="https://github.com/yagues1/duovra/releases/latest"><img src="https://img.shields.io/github/v/release/yagues1/duovra?display_name=tag&amp;label=release&amp;color=526829" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/yagues1/duovra?color=526829" alt="MIT license"></a>
  <a href="#download-and-get-started"><img src="https://img.shields.io/badge/platform-Windows%2011%20x64-526829" alt="Windows 11 x64"></a>
  <a href="https://github.com/yagues1/duovra/releases"><img src="https://img.shields.io/github/downloads/yagues1/duovra/total?label=downloads&amp;color=526829" alt="Total GitHub release asset downloads"></a>
</p>

<p align="center">
  <a href="docs/screenshots/1.0.10/conversation.webp"><img src="docs/screenshots/1.0.10/duovra-hero.webp" width="1280" height="700" alt="Open the full-size screenshot of Duovra, where Claude Code and Codex share a conversation beside a Git diff. Aura and Flujo frame the window."></a>
</p>

Duovra is a free, open-source desktop app for the official Claude Code and Codex CLIs. Choose the agent, model and reasoning effort in the composer. Duovra passes recent context when you switch agents and stores your projects, drafts and conversation history locally.

## Claude Code and Codex

Switch agents mid-conversation. Follow streamed responses and tool activity, review approvals inline, stop a run or queue the next message.

<p><a href="docs/screenshots/1.0.10/conversation.webp"><img src="docs/screenshots/1.0.10/agents.webp" width="760" alt="Claude Code and Codex messages in a shared conversation, with a shared-context note between turns."></a></p>

<details>
<summary>Watch Claude Code switch to Codex</summary>

![The composer opens the agent selector, switches from Claude Code to Codex and shows Flujo while the same conversation stays open.](docs/screenshots/1.0.10/switch-agent.gif)

[Open the agent-switch GIF](docs/screenshots/1.0.10/switch-agent.gif)

</details>

## Git Worktrees

Create or import Git worktrees and keep conversations, files, changes and previews tied to their branch folders.

<p><img src="docs/screenshots/1.0.10/worktrees.webp" width="605" alt="The Fieldnotes project menu shows options to create or import a Git worktree beside the Trail theme branch."></p>

## Live Preview

Open a local dev server in Workbench. Inspect elements, check console and network activity, simulate screen sizes or attach captures to your next prompt.

<p><img src="docs/screenshots/1.0.10/live-preview.webp" width="760" alt="The Fieldnotes demo running in Duovra’s expanded Live Preview with browser and inspection controls."></p>

<details>
<summary>Watch the Live Preview inspector</summary>

![Live Preview selects the Fieldnotes heading and opens the element panel with its selector and actions.](docs/screenshots/1.0.10/live-inspector.gif)

[Open the inspector GIF](docs/screenshots/1.0.10/live-inspector.gif)

</details>

## Workbench

Browse project files, inspect Git changes and diffs, and open diagrams, static previews and supported widgets. Use conversation search, the command palette and file references to move around your workspace. Usage and provider limits appear when the CLIs report them.

<p><img src="docs/screenshots/1.0.10/workbench.webp" width="760" alt="Workbench shows files in the selected Trail theme worktree alongside the conversation."></p>

## Personalization

Customize Graphite Glass with built-in patterns or a local image, adjust motion and switch between English and Spanish from Settings.

<p><img src="docs/screenshots/1.0.10/appearance.webp" width="760" alt="Appearance settings with the language selector, background presets and the selected Duovra Original background."></p>

The images and demos show Duovra 1.0.10 with a sample project and conversation.

## Download and get started

Duovra runs on **Windows 11 x64** and needs [WebView2 Evergreen](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

1. Get the per-user installer or extract the full portable ZIP from the [latest release](https://github.com/yagues1/duovra/releases/latest).
2. Install and sign in to at least one official CLI. Use `claude auth login` for [Claude Code](https://code.claude.com/docs/en/setup) or `codex login` for [Codex](https://developers.openai.com/codex/cli). Install both to switch between them in the same conversation. Model access and billing follow your provider account.
3. Open **Settings → Agents and models** to confirm Duovra detects the CLIs. Choose **Add folder as project**, press `Ctrl+N`, and select an agent, model and reasoning effort in the composer.

Windows SmartScreen may appear because the installer and executable lack an Authenticode signature. For signed in-app updates, open **Settings → Updates and notifications**. If you are migrating from the beta, back up your profile first. [Windows distribution guide](docs/distribution.md)

## Privacy and permissions

Duovra keeps its workspace data locally in SQLite. The CLIs handle authentication and may send prompts, conversation context, attachments or project information to their providers during a turn. Review commands and file changes before approving them. [Local data and privacy](docs/distribution.md#reportes-y-privacidad) · [Report a security issue](SECURITY.md)

## Support Duovra

Duovra is free and open source. Everyone gets the same features. You can help by reporting an issue, starring the repository or contributing through the links below. Payments are handled by those platforms. [Official support page](https://duovra.vercel.app/en#support)

<p>
  <a href="https://ko-fi.com/duovra"><img src="https://img.shields.io/badge/Ko--fi-Support%20Duovra-526829?logo=ko-fi&amp;logoColor=white" alt="Support Duovra on Ko-fi"></a>
  <a href="https://giveth.io/project/duovra"><img src="https://img.shields.io/badge/Giveth-Donate%20with%20crypto-526829" alt="Support Duovra on Giveth"></a>
</p>

## Build and contribute

Duovra uses Tauri 2, React, TypeScript, Rust and SQLite. [Build from source](CONTRIBUTING.md#set-up-the-environment) · [Architecture](docs/architecture.md) · [Agent integration](docs/agent-integration.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE). Third-party components retain their own terms. See the [third-party notices](THIRD_PARTY_NOTICES.md).

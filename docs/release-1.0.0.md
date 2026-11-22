# Duovra v1.0.0 — First Stable Release

Duovra brings Claude Code and OpenAI Codex into one Windows workspace. Open a local project, choose an agent for each message and continue the same conversation when you switch.

- **One composer for both agents.** Choose the model and reasoning effort the selected CLI offers. Follow streamed responses and tool activity, handle approval requests inline, and queue the next message while a turn is running.
- **Workbench.** Browse files, review Git changes and diffs, and open Mermaid diagrams, static HTML and SVG, and supported widgets alongside your conversation.
- **Local history.** Reopen projects, conversations, drafts and queued tasks. Use search and usage views to find earlier work.
- **Appearance.** Choose a background pattern or import your own image. Hybrid mascots reflect the agent's activity, with motion controls in Settings.

## Download

| File | Purpose |
| --- | --- |
| `Duovra-1.0.0-windows-x64-setup.exe` | Recommended per-user Windows installer. |
| `Duovra-1.0.0-windows-x64-portable.zip` | Extract the entire archive and run `duovra.exe`. The app still uses your Windows profile. |
| `SHA256SUMS.txt` | Verify the integrity of either download. |

Use Windows 11 x64 with the Microsoft Edge WebView2 Evergreen Runtime. Install and sign in to Claude Code or the OpenAI Codex CLI separately. Each provider controls model access and billing. [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) · [Claude Code](https://code.claude.com/docs/en/setup) · [Codex CLI](https://developers.openai.com/codex/cli)

The Windows packages are unsigned and SmartScreen may show a warning. Update manually from GitHub Releases.

**Upgrading from Beta 2?** Close it and back up `%APPDATA%\dev.duovra.studio.beta`. Duovra 1.0.0 reuses that profile when opened under the same Windows account. If you remove the prerelease, keep app data in the uninstaller. [Installation, profile migration and privacy](https://github.com/yagues1/duovra/blob/v1.0.0/docs/distribution.md)

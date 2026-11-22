# Windows distribution

## Install or run from ZIP

Duovra 1.0.0 targets Windows 11 x64. The Microsoft Edge WebView2 Evergreen Runtime is a system prerequisite. Install it separately if it is missing. [Microsoft WebView2 downloads](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

| Package | Use |
| --- | --- |
| `Duovra-1.0.0-windows-x64-setup.exe` | Per-user NSIS installer. The default program folder is `%LOCALAPPDATA%\Duovra`. |
| `Duovra-1.0.0-windows-x64-portable.zip` | Extract the full archive and run `duovra.exe`. Keep the bundled `WebView2Loader.dll` beside it. |
| `SHA256SUMS.txt` | Expected SHA-256 hashes of both downloads. |

The portable package requires WebView2 and uses the same Windows profile as the installed app. For agent runs, both packages use separately installed and signed-in provider CLIs. Git must be available for Git views in Workbench.

Run the following in the download directory and compare the result with the corresponding line in `SHA256SUMS.txt`.

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\Duovra-1.0.0-windows-x64-setup.exe
```

Windows may show SmartScreen warnings because the packages lack Authenticode signatures. Download future versions from GitHub Releases. This build ships with in-app updates and the optional bug-report relay disabled. [GitHub Releases](https://github.com/yagues1/duovra/releases)

## Upgrade and back up

**From Beta 2.** Close the prerelease and back up the entire `%APPDATA%\dev.duovra.studio.beta` directory. Install 1.0.0 and open **Duovra** from Start. It uses the existing database and settings under the same Windows account. Windows lists the prerelease separately. Use one edition at a time and leave the option to delete app data unchecked if you uninstall either edition, since both share the profile.

If the existing database predates the background image table, Duovra creates `studio.pre-1.0.0.sqlite3.bak` before adding the table. The snapshot includes committed WAL transactions. A failed backup stops database initialization so the schema change can be retried.

**From Duovra 0.5.1 or earlier.** The installer uses the existing Windows program registration. Duovra 1.0.0 uses a different profile directory and leaves the old profile at `%APPDATA%\dev.claudecodexstudio.app`. To bring over its history, close Duovra and back up the whole old profile. Copy `studio.sqlite3` and its matching `studio.sqlite3-wal` if present from the backup only when the 1.0.0 profile has no database. Open Duovra to migrate the copy. For a legacy schema, the app saves `studio.pre-0.6.0.sqlite3.bak` before migration. Keep both profiles if the 1.0.0 profile already has history. The app has no profile merge.

To restore a backup, close both editions, move the current profile to a separate location, then restore the saved profile. When restoring an SQLite snapshot, use a new profile directory for it so that no WAL from a different database is picked up.

## Privacy and local data

| Data | Location |
| --- | --- |
| Projects, history, drafts, settings, backgrounds, queue and usage records | `%APPDATA%\dev.duovra.studio.beta\studio.sqlite3` |
| WebView2 state and cache | `%LOCALAPPDATA%\dev.duovra.studio.beta` |
| Provider sign-in and provider session data | Each CLI's configuration location or the account directory selected in Duovra |

SQLite is local application storage. Treat the profile and its backups as private. Duovra starts the selected CLI in the project folder. Depending on your prompt, permissions and provider, the CLI can send conversation context, attachments and relevant workspace information to its service. Model access, billing and data treatment follow that provider. [Anthropic data usage](https://code.claude.com/docs/en/data-usage) · [Codex security](https://developers.openai.com/codex/security)

Workbench can display isolated static HTML and SVG previews. Keep CLI sandbox and approval settings appropriate for the project you open. Report vulnerabilities privately and redact personal paths, conversations and credentials from diagnostics. [Security policy](../SECURITY.md)

## Build from source

Use Windows x64, Node.js 22.12+ in the 22 LTS line, npm, Git, Rust stable for `x86_64-pc-windows-msvc`, the Visual Studio C++ build tools with a Windows SDK, and WebView2. Building the NSIS installer also uses Tauri's downloaded bundling tools. [Tauri build prerequisites](https://v2.tauri.app/start/prerequisites/)

```powershell
git clone https://github.com/yagues1/duovra.git
cd duovra
npm ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npm run build:windows
```

Find the installer, portable ZIP, hashes and source commit metadata under `output/distribution/Duovra-1.0.0/`. The Windows GitHub Actions job runs these checks and stores unsigned build artifacts. Creating a GitHub release is a separate maintainer action.

Run `npm run tauri dev` for native development or `npm run dev` for the browser UI with mocked IPC at `http://localhost:1420`. Browser development and the automated suites require no provider accounts. The provider test policy covers live agent verification. [Model test policy](qa/test-model-policy.md)

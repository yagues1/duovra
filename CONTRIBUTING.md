# Contributing to Duovra

Thanks for helping improve Duovra. Bug reports, fixes, documentation and focused UI improvements are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Duovra deliberately keeps **manual agent selection**. Proposals for automatic routing or orchestration between agents are out of scope.
- Keep changes focused. A pull request that fixes one thing is much easier to review than one that touches everything.

## Set up the environment

Requirements: Windows 11, Node.js 22.12+, Rust stable (MSVC toolchain recommended) and the Visual Studio C++ build tools.

```powershell
git clone https://github.com/yagues1/duovra.git
cd duovra
npm ci
npm run tauri dev
```

For UI-only work you can run `npm run dev` and open `http://localhost:1420`. It uses a mocked backend, so no agent CLIs are needed.

## Make a change

1. Create a branch from `main`: `git checkout -b fix/short-description`.
2. Make your change. Follow the existing style: TypeScript strict, small components and design tokens instead of hard-coded colors (`src/styles/tokens.css`).
3. Run the checks:

   ```powershell
   npm run typecheck
   npm test
   cargo test --manifest-path src-tauri/Cargo.toml --lib
   ```

4. For visual changes, attach before and after screenshots to the pull request.

## Pull requests

- Describe **what** changed and **why**, and how you tested it.
- Use clear commit messages (Conventional Commits such as `fix:` or `feat(ui):` are appreciated).
- CI must pass. Maintainers may ask for changes. It's a normal part of the process.

## Tests that call real agents

Automated tests use mocks and never call model providers. If you validate a change against a real agent, use short prompts in a temporary folder, and never paste tokens, credentials or private conversations into issues or pull requests.

## Design guidelines

Duovra's interface follows one Liquid Glass material system (see [`docs/design-system.md`](docs/design-system.md)). New surfaces should use the existing materials (`mat-primary`, `mat-float`, `mat-control`, `mat-reading`) rather than ad-hoc styles. They should also respect the visual-intensity setting and `prefers-reduced-motion`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

# Security policy

## Reporting a vulnerability

**Please don't report security issues in public issues, discussions or pull requests.**

Use GitHub's private vulnerability reporting instead: **[Report a vulnerability](https://github.com/yagues1/duovra/security/advisories/new)** (Security tab → *Report a vulnerability*).

Include a description of the issue, the affected version and the steps to reproduce it. Don't include real credentials, tokens or private conversations. If you need to show sensitive data, use placeholders.

You'll get an acknowledgement as soon as possible. Once a fix is available, the advisory will be published with credit, unless you prefer to stay anonymous.

## Scope

Relevant areas include:

- How Duovra launches the agent CLIs and passes arguments, environment variables and paths to them.
- The permission and approval flow for agent tool calls.
- Local data storage (SQLite in the user's application data folder).
- The update mechanism (signature verification, download URLs).
- The optional bug-report relay in `services/bug-reports`.

Vulnerabilities in Claude Code, the Codex CLI or the model providers should be reported to Anthropic or OpenAI directly.

## Supported versions

Only the latest released version receives security fixes.

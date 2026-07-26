---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${ZCODE_PLUGIN_ROOT}/plugins/codex/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is missing and npm is available:
- Use `AskUserQuestion` exactly once to ask the user whether ZCode should install Codex globally.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- Only if the user confirms by choosing install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${ZCODE_PLUGIN_ROOT}/plugins/codex/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable, do not offer installation.

Present the final setup output to the user. If installation was declined, present the original setup output. If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.

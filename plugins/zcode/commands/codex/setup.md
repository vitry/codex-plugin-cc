---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: mcp__codex__companion, AskUserQuestion, Bash
---

Raw slash-command arguments:
`$ARGUMENTS`

Call `mcp__codex__companion` with this input:

```json
{"command": "setup", "arguments": "--json $ARGUMENTS"}
```

If the result says Codex is missing and npm is available, use ZCode's normal user question capability exactly once before any global installation. Put `Install Codex (Recommended)` first and `Skip for now` second.

Only after the user gives explicit confirmation, use ZCode's normal shell tool to install the `@openai/codex` package globally with npm. Then repeat the same companion setup call with `--json` plus the original arguments. The command Markdown itself must not invoke npm.

If installation is declined, present the original setup output. If Codex is already installed or npm is unavailable, do not offer installation. Present the final setup output without discarding details. If Codex is installed but not authenticated, preserve the guidance to run `codex login`.

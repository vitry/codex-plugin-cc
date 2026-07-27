---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--cwd <path>]'
allowed-tools: mcp__codex__companion, AskUserQuestion, Read, Glob, Grep, Bash
---

Run a read-only Codex review through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Target and argument rules:
- Preserve the user's arguments exactly.
- Support `--wait`, `--background`, `--base <ref>`, `--scope auto|working-tree|branch`, and `--cwd <path>`.
- Resolve the path relative to the ZCode workspace. Without it, the companion automatically selects a single nested Git repository; multiple nested repositories require an explicit `--cwd`.
- Working-tree review includes staged, unstaged, and untracked changes.
- Branch review and `--base <ref>` use the selected base through the companion runtime.
- This command does not support staged-only or unstaged-only review and does not accept extra focus text. Direct custom instructions belong in adversarial review.

Execution mode:
- With `--wait`, do not ask; run in the foreground.
- With `--background`, do not ask; start the companion review in background mode.
- With neither flag, use ZCode's normal read-only workspace and version-control inspection capabilities to estimate the review size. Treat untracked files as reviewable work. Recommend waiting only for a clearly tiny review of roughly one or two files; otherwise, including when unclear, recommend background.
- Ask exactly one user question with `Wait for results` and `Run in background`, putting the recommended option first and adding `(Recommended)` to its label.
- Add the selected execution flag without rewriting any original argument.

Call `mcp__codex__companion` exactly once with the final arguments:

```json
{"command": "review", "arguments": "$ARGUMENTS"}
```

This command is review-only. Do not fix, edit, modify, or apply anything, and do not suggest that changes are about to be made. Return the companion text verbatim with no summary or commentary.

If the MCP call fails, return its error verbatim. Do not invoke raw `codex` or run an alternative review command. Do not redirect output to a temporary file as a fallback.

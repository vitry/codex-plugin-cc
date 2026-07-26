---
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
allowed-tools: mcp__codex__companion, AskUserQuestion, Read, Glob, Grep, Bash
---

Run a read-only adversarial Codex review that challenges the implementation approach, design choices, tradeoffs, and assumptions rather than merely looking harder for implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Target and argument rules:
- Preserve the user's arguments and focus text exactly.
- Support `--wait`, `--background`, `--base <ref>`, and `--scope auto|working-tree|branch`.
- Use the same working-tree, branch, and base target selection as the standard review command.
- Working-tree review includes staged, unstaged, and untracked changes.
- Do not accept `--scope staged` or `--scope unstaged`.
- Preserve any focus text after the flags without weakening or rewriting it.

Execution mode:
- With `--wait`, do not ask; run in the foreground.
- With `--background`, do not ask; start the companion review in background mode.
- With neither flag, use ZCode's normal read-only workspace and version-control inspection capabilities to estimate the review size. Treat untracked files as reviewable work. Recommend waiting only for a clearly tiny review of roughly one or two files; otherwise, including when unclear, recommend background.
- Ask exactly one user question with `Wait for results` and `Run in background`, putting the recommended option first and adding `(Recommended)` to its label.
- Add the selected execution flag without rewriting any original argument or focus text.

Call `mcp__codex__companion` exactly once with the final arguments:

```json
{"command": "adversarial-review", "arguments": "$ARGUMENTS"}
```

This command is review-only. Do not fix, edit, modify, or apply anything. Return the companion text verbatim with no summary or commentary.

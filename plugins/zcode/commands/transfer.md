---
description: Import an explicit Claude JSONL transcript into a resumable Codex thread
argument-hint: '[--source <claude-jsonl>]'
allowed-tools: mcp__codex__companion
---

Raw slash-command arguments:
`$ARGUMENTS`

Require and preserve `--source <claude-jsonl>` exactly. Call `mcp__codex__companion` exactly once:

```json
{"command": "transfer", "arguments": "$ARGUMENTS"}
```

Present the returned text exactly as returned, with no summary or commentary. Preserve the Codex session ID and the `codex resume <session-id>` command.

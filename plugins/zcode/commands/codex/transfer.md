---
description: Transfer the current ZCode session into a resumable Codex thread
argument-hint: '[--source <session-id|sqlite-path|sqlite-path#session-id>]'
allowed-tools: mcp__codex__companion
---

Raw slash-command arguments:
`$ARGUMENTS`

With no arguments, transfer the calling ZCode session from the configured ZCode session database.
Preserve an optional `--source` exactly:

- `sess_...` selects a session explicitly from the default database.
- A SQLite path selects the calling session from that database.
- `<sqlite-path>#<sess_...>` selects both an explicit database and session.

Call `mcp__codex__companion` exactly once:

```json
{"command": "transfer", "arguments": "$ARGUMENTS"}
```

Present the returned text exactly as returned, with no summary or commentary. Preserve the Codex session ID and the `codex resume <session-id>` command.

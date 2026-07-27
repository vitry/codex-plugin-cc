---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
allowed-tools: mcp__codex__companion
---

Raw slash-command arguments:
`$ARGUMENTS`

Call `mcp__codex__companion` exactly once:

```json
{"command": "cancel", "arguments": "$ARGUMENTS"}
```

Present the returned text verbatim. Do not summarize, rewrite, or add commentary.

---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
allowed-tools: mcp__codex__companion
---

Raw slash-command arguments:
`$ARGUMENTS`

Call `mcp__codex__companion` exactly once:

```json
{"command": "result", "arguments": "$ARGUMENTS"}
```

Present the returned text verbatim and in full. Do not summarize or condense it. Preserve the job ID and status, the complete result payload, verdict, summary, findings, details, artifacts, next steps, file paths, line numbers, errors, parse errors, and follow-up commands exactly as reported.

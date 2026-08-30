---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
allowed-tools: mcp__codex__companion
---

Raw slash-command arguments:
`$ARGUMENTS`

Preserve the optional job ID and all `--wait`, `--timeout-ms <ms>`, and `--all` arguments. Call `mcp__codex__companion` exactly once:

```json
{"command": "status", "arguments": "$ARGUMENTS"}
```

If the user did not pass a job ID, render the returned information as a single Markdown table with no extra prose. Preserve the actionable fields, including job ID, kind, status, phase, elapsed time or duration, summary, and follow-up commands.

If the user passed a job ID, present the full returned output verbatim. Do not summarize or condense it.

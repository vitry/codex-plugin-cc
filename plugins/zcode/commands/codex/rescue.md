---
description: Delegate investigation, an explicit fix request, or follow-up rescue work directly to Codex
argument-hint: '[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]'
allowed-tools: AskUserQuestion, mcp__codex__companion
---

Delegate the request directly through the companion MCP. Do not investigate or perform the task in this command.

Raw slash-command arguments:
`$ARGUMENTS`

Request rules:
- If no task text was supplied, ask what Codex should investigate or fix.
- Preserve `--background` so the companion runtime creates a detached, trackable job. Preserve `--wait` as an explicit foreground request.
- Preserve explicit `--resume` or `--fresh` routing, and do not ask about the routing choice when either is present.
- If neither routing flag is present, call `mcp__codex__companion` with command `task-resume-candidate` and arguments `--json`. If a resumable thread is available, use ZCode's normal user question capability exactly once with `Continue current Codex thread` and `Start a new Codex thread`. Recommend continue for a clear follow-up request; otherwise recommend a fresh thread. Forward the choice as `--resume` or `--fresh`. If no candidate is available, do not ask.
- Preserve `--model <model>` and `--effort <none|minimal|low|medium|high|xhigh>` as runtime controls. Leave both unset unless explicitly requested. Map model `spark` to `gpt-5.3-codex-spark`.
- Preserve the task text without rewriting it.

After optional resume-candidate discovery, call `mcp__codex__companion` exactly once for the task:

```json
{"command": "task", "arguments": "--write <forwarded arguments>"}
```

Replace `<forwarded arguments>` with the cleaned and routed arguments. Return the companion text verbatim. Do not summarize, rewrite, or add commentary.

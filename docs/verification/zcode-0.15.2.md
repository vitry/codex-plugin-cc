# ZCode 0.15.2 Installed Plugin Verification

## Scope

- Date: 2026-07-26
- Runtime source commit: `4afbd67`
- Branch and PR: `zcode-adapter`, `vitry/codex-plugin-cc#1`
- ZCode Desktop: 3.3.6
- ZCode CLI: 0.15.2
- Platform: macOS arm64
- Node.js: 24.14.0
- Codex CLI: 0.145.0
- Plugin: `codex@openai-codex` 1.1.0
- Installed root: `~/.zcode/cli/plugins/cache/openai-codex/codex/1.1.0`

Sensitive session, job, thread, account, and temporary path values are redacted
below. The installed `plugins/codex` and `plugins/zcode` trees were compared
against the source worktree before behavioral verification.

## Installation And Discovery

The local repository-root `marketplace.json` was registered as
`openai-codex`. Protocol calls `plugins/marketplace/update` and
`plugins/install` installed version 1.1.0 with no diagnostics.

Installed discovery results:

- `plugins/list`: enabled, zero diagnostics, one connected MCP server, three
  runnable hooks, three skills.
- `plugins/describe`: eight commands, three skills, three hooks, and one MCP
  server. No plugin agent is declared because ZCode 0.15.2 treats that
  component as diagnostic-only.
- `commands list --json`: `setup`, `review`, `adversarial-review`, `rescue`,
  `transfer`, `status`, `result`, and `cancel`.
- `mcp/list` with `mode: connect`: `plugin:codex:codex` connected over stdio
  with one tool.
- MCP initialization: protocol `2024-11-05`, server
  `codex-companion-zcode` 1.1.0.

For repeated development installs, the marketplace must be updated before
install. ZCode caches source by marketplace and version; uninstalling the
development plugin before reinstalling gives a deterministic refresh.

## Capability Matrix

| Capability | Installed-runtime evidence | Result |
| --- | --- | --- |
| Setup | Companion `setup --json` reported Node, npm, Codex app-server, and verified Codex auth ready. | Pass |
| Normal review | A working-tree review was queued in the background, reached `completed`, and returned its stored result and resumable Codex thread. | Pass |
| Adversarial review | A disposable repository's two-line artifact was reviewed with explicit focus and received `approve` with no material findings. | Pass |
| Rescue fresh | A write-capable `task --fresh` created only the requested file and exact first line in a disposable repository. | Pass |
| Rescue resume | A second `task --resume` continued the same host-scoped task and appended the exact requested second line without other edits. | Pass |
| Background status/result | The background review appeared in status, `--wait` reached completion, and result returned the final review output. | Pass |
| Cancel | A background rescue task was cancelled immediately; status persisted `cancelled` and phase `cancelled`. | Pass |
| Transfer | An existing four-message ZCode SQLite session was selected by `sess_...` ID and imported into a resumable Codex thread with visible turn history. | Pass |
| SessionStart | The installed hook recorded a redacted ZCode session ID under the workspace's `zcodeSessions` state. | Pass |
| PreToolUse | The installed hook injected the calling ZCode session ID into the companion tool input. | Pass |
| Stop disabled | The installed Stop hook returned success without blocking. | Pass |
| Stop enabled/block | After an edit introduced invalid JavaScript and the previous host response identified that edit, the hook emitted `decision: block` with the syntax defect. | Pass |
| Stop enabled/allow | After fixing the syntax defect, the hook emitted no block decision and exited successfully. | Pass |
| Shared broker | Review and rescue used the identity-bound shared broker; final lease release acknowledged shutdown, observed exit, and finalized state. | Pass |
| Slash-command dispatch | A headless `/codex:status --all` turn expanded the installed command, exposed the installed companion MCP tool to the model, executed the model's tool call, returned the tool result to the model, and completed the turn. | Pass |

## Automated Verification

Before installed-runtime verification:

- Full test suite: 193 tests, 189 passed, 4 Windows-only skipped, 0 failed.
- ZCode-focused suite after direct-rescue adaptation: 37 passed, 0 failed.
- `npm run build`: passed.
- `npm run check-version`: passed for 1.1.0.
- `git diff --check`: passed.
- Independent runtime-hardening reviews: `SPEC PASS` and `QUALITY PASS`.

The four local skips exercise Windows mutex ownership, crash reclamation,
same-process exclusion, and stale async context. GitHub Actions
[run 30203963619](https://github.com/vitry/codex-plugin-cc/actions/runs/30203963619)
verified the same commit on both platforms:

- Ubuntu: 193 tests, 189 passed, 4 Windows-only skipped, 0 failed; build passed.
- Windows: 16 lock/state tests, 15 passed, 1 Unix-only skipped, 0 failed.

## Baseline Capability Audit

Every user-facing capability in `docs/research/current-capabilities.md` has
both automated coverage and installed ZCode evidence:

- review and adversarial review: target selection/runtime tests plus both
  installed review modes;
- rescue and continuation: argument/resume tests plus installed fresh and
  resumed write-capable tasks;
- status, result, background work, and cancellation: runtime/process tests plus
  an installed queued review and cancelled task;
- transfer: SQLite export/import tests plus a real ZCode-to-Codex import;
- setup/auth: provider tests plus installed Codex readiness;
- SessionStart, PreToolUse, and Stop: hook tests plus direct execution of the
  installed hook scripts;
- shared app-server state: lock/broker tests plus installed broker startup,
  reuse, lease release, shutdown, and cleanup.

Claude Code packaging and commands remain covered by the original command,
runtime, and manifest tests.

## Model-Driven Command Verification

This machine's ZCode CLI has no explicit ZCode model provider in
`~/.zcode/cli/config.json`. The model-driven dispatcher was therefore verified
without changing account or user configuration: ZCode Protocol `session/create`
received an ephemeral OpenAI-compatible `runtimeModel` pointing to a loopback
test server with a non-secret placeholder key.

The test sent `/codex:status --all` through `session/send` and observed:

1. ZCode expanded the installed command body into the model request.
2. The request exposed 16 tools, including the installed plugin tool
   `mcp__plugin_codex_codex__companion`.
3. The test model called that tool with `{"command":"status","arguments":"--all"}`.
4. ZCode executed the plugin MCP call and included its tool result in the next
   model request.
5. The session emitted `turn.completed` with no last error.

This verifies command discovery, command expansion, model tool selection,
plugin MCP dispatch, tool-result delivery, and turn completion independently
of a user's Z.AI credentials.

## Known Host Limitation

ZCode 0.15.2 exposes no SessionEnd hook in this plugin integration. Broker
leases therefore rely on bounded broker idle shutdown and stale-lease
reclamation when a host session does not explicitly release them.

# ZCode 0.15.2 Installed Plugin Verification

## Scope

- Date: 2026-07-26
- Runtime source commit: `df1d88a`
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

Redacted aliases used below are `<zcode-session>`, `<review-job>`,
`<rescue-job>`, `<cancel-job>`, and `<codex-thread>`. Before test cleanup, job
records and logs were located at:

```text
~/.zcode/cli/plugins/data/codex@openai-codex/state/<workspace>-<hash>/state.json
~/.zcode/cli/plugins/data/codex@openai-codex/state/<workspace>-<hash>/jobs/<job-id>.json
~/.zcode/cli/plugins/data/codex@openai-codex/state/<workspace>-<hash>/jobs/<job-id>.log
```

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

- Full test suite: 196 tests, 192 passed, 4 Windows-only skipped, 0 failed.
- ZCode-focused suite after direct-rescue adaptation: 37 passed, 0 failed.
- `npm run build`: passed.
- `npm run check-version`: passed for 1.1.0.
- `git diff --check`: passed.
- Independent runtime-hardening reviews: `SPEC PASS` and `QUALITY PASS`.
- Final objective audit: `FINAL SPEC PASS`.
- Final complete-diff code review after the production tool-name and
  cross-platform SQLite fixes: `FINAL QUALITY PASS`.

The four local skips exercise Windows mutex ownership, crash reclamation,
same-process exclusion, and stale async context. GitHub Actions
[run 30204541169](https://github.com/vitry/codex-plugin-cc/actions/runs/30204541169)
verified commit `df1d88a` on both platforms:

- Ubuntu: 196 tests, 192 passed, 4 Windows-only skipped, 0 failed; build passed.
- Windows: 16 lock/state tests (15 passed, 1 Unix-only skipped) plus the
  no-system-`sqlite3` transfer test; 0 failed.

The built-in SQLite query helper was also executed directly with Node.js
22.5.1 and `--experimental-sqlite`, reading `SELECT 1` from the ZCode database
without the system `sqlite3` command.

## Installed E2E Command Record

The following commands were sent through the installed companion MCP tool in
a disposable repository. Values in angle brackets are the aliases defined
above:

```text
setup --json
review --background
status <review-job> --wait --json
result <review-job> --json
adversarial-review --wait inspect the deliberately changed lines
task --write --fresh create the requested first-line fixture
task --write --resume append the requested second-line fixture
task --background --write create a cancellable fixture
cancel <cancel-job> --json
status <cancel-job> --json
transfer --source <zcode-session> --json
```

The review and rescue records contained redacted persistent
`<codex-thread>` identifiers. `result` returned the stored review, cancellation
persisted `status: cancelled`, transfer returned a resumable thread, and the
disposable repository contained only the requested rescue edits.

The installed hook entrypoints were also invoked with redacted ZCode
SessionStart, PreToolUse, and Stop payloads. PreToolUse used the production
tool name `mcp__plugin_codex_codex__companion`; Stop was exercised with the
review gate disabled, with a syntax failure that returned `decision: block`,
and after repair with no block decision.

## Exact-Commit Reverification

After the final code-review fixes, ZCode Protocol refreshed the local
marketplace, removed the old cache, and installed commit `df1d88a` again.
Source/cache comparisons for `.zcode-plugin`, `plugins/zcode`,
`plugins/codex/scripts`, and `marketplace.json` had no differences.

The exact installed cache was then exercised again:

- discovery returned zero diagnostics, eight commands, three skills, three
  runnable hooks, and one connected MCP server;
- the registered PreToolUse matcher was
  `^mcp__(?:plugin_codex_)?codex__companion$`, and the installed hook injected
  the session into the production MCP tool name;
- transfer imported a real ZCode session through the built-in Node SQLite
  reader and returned a resumable Codex thread;
- setup reported Codex ready;
- a background working-tree review completed, appeared in status, and returned
  its stored result;
- a fresh write-capable rescue created only the requested file and content;
- a second background rescue was cancelled, persisted as `cancelled`, and did
  not create its delayed output;
- the enabled Stop gate blocked deliberately invalid JavaScript and emitted no
  block decision after repair; the gate was disabled again after the test;
- the model-driven `/codex:status --all` path made three model requests,
  expanded the command, called
  `mcp__plugin_codex_codex__companion`, delivered its result, and emitted
  `turn.completed` with no last error.

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

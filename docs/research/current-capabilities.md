# Codex Plugin Current Capabilities and Runtime Dependencies

## Scope and baseline

This inventory describes the repository at commit `4cb258a`. The checked-out
branch was `main`, but `main`, local `zcode-adapter`, `origin/main`, and
`origin/zcode-adapter` all pointed to that same commit when the research was
performed.

Primary evidence:

- Product surface: `README.md`, `.claude-plugin/marketplace.json`,
  `plugins/codex/.claude-plugin/plugin.json`.
- Claude Code integration: `plugins/codex/commands/*.md`,
  `plugins/codex/agents/codex-rescue.md`,
  `plugins/codex/hooks/hooks.json`.
- Runtime: `plugins/codex/scripts/codex-companion.mjs`,
  `plugins/codex/scripts/app-server-broker.mjs`, and
  `plugins/codex/scripts/lib/*.mjs`.
- Behavioral evidence: named tests in `tests/*.test.mjs`.

The marketplace contains one plugin, `codex`, version `1.0.6`, sourced from
`./plugins/codex`. The package requires Node.js `>=18.18.0`. User-facing setup
also requires a global `codex` CLI with `codex app-server` support; npm is only
needed for the optional guided install.

## Architecture summary

The plugin has three separable layers:

1. **Claude Code presentation and orchestration.** Slash-command Markdown,
   `AskUserQuestion`, `Agent`, background `Bash`, hook registration, and
   Claude-specific environment propagation decide how a command is presented
   and detached.
2. **Host-neutral companion CLI.** `codex-companion.mjs` implements setup,
   review, task, transfer, status, result, cancellation, state, and rendering.
   It can be invoked directly with Node.
3. **Codex runtime transport.** A lazily started workspace-scoped broker owns
   one `codex app-server`; clients speak newline-delimited JSON-RPC over a Unix
   socket or Windows named pipe. Busy or unavailable brokers can fall back to a
   direct per-command app-server.

The reusable center is layers 2 and 3. A zcode adapter primarily needs to
replace layer 1 and supply equivalent session lifecycle inputs.

## User capability matrix

| User command | Behavior and options | Runtime path | Claude Code-only dependency | Test evidence |
| --- | --- | --- | --- | --- |
| `/codex:review` | Read-only native Codex review. `auto` reviews a dirty working tree, otherwise the branch against the detected default; supports `--base`, `--scope auto\|working-tree\|branch`, `--wait`, `--background`. Rejects focus text and staged/unstaged-only scope. | `review` -> `review/start`; starts an ephemeral read-only source thread and stores a tracked review job. | Slash command, one `AskUserQuestion` when mode is omitted, and `Bash(..., run_in_background: true)` for detachment. The companion parses `--background` but does not detach review itself. | `review renders a no-findings result from app-server review/start`; `review accepts the quoted raw argument style for built-in base-branch review`; `review rejects focus text because it is native-review only`; `review rejects staged-only scope because it is native-review only`; `review accepts --background while still running as a tracked review job`. |
| `/codex:adversarial-review` | Read-only challenge review over the same targets; accepts trailing focus text. Small changes (at most 2 files and at most 256 KiB diff by default) are inlined; larger changes provide lightweight context and instruct Codex to inspect the diff. Produces schema-constrained JSON and rendered findings. | `adversarial-review` -> read-only `turn/start` with `review-output.schema.json`. | Same prompt-time mode selection and background Bash dependency as normal review. | `adversarial review renders structured findings over app-server turn/start`; `adversarial review accepts the same base-branch targeting as review`; `adversarial review asks Codex to inspect larger diffs itself`; `adversarial review rejects staged-only scope to match review target selection`; all `collectReviewContext ...` tests in `tests/git.test.mjs`. |
| `/codex:rescue` | Delegates investigation, implementation, continuation, diagnosis, or research. Supports `--background`, `--wait`, `--resume`, `--fresh`, `--model`, and `--effort`. Defaults to foreground at the command layer and to write-capable execution in the rescue agent unless the request is explicitly read-only. `spark` maps to `gpt-5.3-codex-spark`. | Claude invokes `codex:codex-rescue`, which makes exactly one `task` call. Task uses persistent app-server threads, `workspace-write` or `read-only` sandbox, and optional thread resume. | Strong dependency on the Claude `Agent` tool and registered subagent type. `--background` backgrounds the Claude Agent; it is stripped before `task`, so the task runs foreground inside that agent. Resume choice uses `AskUserQuestion`. | `rescue command absorbs continue semantics`; `task --resume acts like --resume-last without leaking the flag into the prompt`; `task --fresh is treated as routing control and does not leak into the prompt`; `task forwards model selection and reasoning effort to app-server turn/start`; task/subagent completion and logging tests in `tests/runtime.test.mjs`. |
| `/codex:status` | Without an ID, shows active, latest finished, and recent jobs for the current Claude session, plus review-gate and shared-runtime state. `--all` lifts the 8-job display cap but remains session-scoped. With an ID/prefix, shows full detail across sessions. `--wait` requires an ID and polls, defaulting to 240 seconds at 2-second intervals. | Reads the workspace state index and job logs; does not contact a running job. | Slash rendering contract requests a compact table. Session scoping depends on the Claude session environment variable. | `status shows phases, hints, and the latest finished job`; `status without a job id only shows jobs from the current Claude session`; `status preserves adversarial review kind labels`; `status --wait times out cleanly when a job is still active`; `status reports shared session runtime when a lazy broker is active`. |
| `/codex:result` | Returns stored final output for the latest finished job in the current session, or a named/prefix-matched finished job across sessions. Refuses active jobs. Includes the Codex thread ID and `codex resume <id>` when available. | Reads per-job JSON, preferring structured rendered review output, then raw task/review output, then stored rendering/error. | Only the slash-command presentation requirement is Claude-specific. Session-default selection uses the session environment variable. | `result returns the stored output for the latest finished job by default`; `result without a job id prefers the latest finished job from the current Claude session`; `result for a finished write-capable task returns the raw Codex final response`; render tests in `tests/render.test.mjs`. |
| `/codex:cancel` | Cancels one queued/running job. Without ID, only the current session is considered and ambiguity is rejected. An explicit ID/prefix may target another session. It first requests `turn/interrupt`, then terminates the worker process tree, appends a log entry, and stores `cancelled`. | `cancel` -> broker/direct `turn/interrupt` when thread and turn IDs are known -> OS process-group termination (`taskkill /T /F` on Windows). | Slash entrypoint and implicit session scoping only. | `cancel stops an active background job and marks it cancelled`; `cancel without a job id ignores active jobs from other Claude sessions`; `cancel with a job id can still target an active job from another Claude session`; `cancel sends turn interrupt to the shared app-server before killing a brokered task`; process tests in `tests/process.test.mjs`. |
| `/codex:transfer` | Imports the current Claude JSONL transcript into a persistent Codex thread and prints its ID and resume command. `--source` overrides the hook-provided path. The source must resolve to a `.jsonl` below `~/.claude/projects`. | Direct app-server only: `externalAgentConfig/import`; waits up to 2 minutes for `externalAgentConfig/import/completed`, then finds the imported thread in `$CODEX_HOME/external_agent_session_imports.json` by real path and content SHA-256. | Semantically Claude-specific: transcript format/location, SessionStart transcript input, import payload description, and Claude-to-Codex migration contract. It also depends on a relatively new Codex external-agent import API. | `transfer delegates the current Claude session directly to native import`; `transfer reports an actionable upgrade error when native import is unsupported`; `transfer fails visibly when native import completes without a ledger record`; `transfer rejects sources outside the Claude projects directory`. |
| `/codex:setup` | Reports Node, npm, Codex, auth/provider, runtime, and review-gate status. Can enable/disable the per-workspace stop gate. If Codex is missing and npm exists, the command can offer `npm install -g @openai/codex`; login guidance uses `!codex login`. | Availability probes `node --version`, `npm --version`, `codex --version`, and `codex app-server --help`; auth uses `account/read` and `config/read`, reusing an existing broker but not lazily creating one solely for setup. | Guided installation uses `AskUserQuestion`; `!` shell syntax and `/codex:setup` references are Claude UI conventions. Core probes and config mutation are reusable. | All six setup/auth tests at the start of `tests/runtime.test.mjs`; `setup reuses an existing shared app-server without starting another one`; `setup and status honor --cwd when reading shared session runtime`; `setup command can offer Codex install and still points users to codex login`. |

There is intentionally no user-facing `/codex:continue`. Continuation was
folded into rescue (`tests/commands.test.mjs`: `continue is not exposed as a
user-facing command` and `rescue command absorbs continue semantics`).

## Internal runtime commands

These are callable CLI capabilities but are not marketplace slash commands:

| Internal command | Purpose | Reuse status |
| --- | --- | --- |
| `task` | Run a read-only or write-capable Codex turn, optionally persistent/resumed, foreground or internally detached with `--background`. Accepts prompt text, piped stdin, or `--prompt-file`. | Directly reusable. Replace Claude-facing wording and session scoping as needed. |
| `task-worker` | Load a queued job request and execute it in a detached child process. | Directly reusable. |
| `task-resume-candidate` | Return the latest completed/failed task with a thread ID in the current host session. | Reusable after replacing the source of session identity. |

`task --background` is a genuine runtime-managed background mode: it writes a
queued record, spawns a detached and unreferenced Node `task-worker`, and returns
immediately. This path is covered by `task --background enqueues a detached
worker and exposes per-job status`. The current rescue slash command does not
use this mode; it backgrounds the Claude Agent instead.

## Hooks and lifecycle matrix

| Hook | Input/side effects | Failure and cleanup behavior | Porting classification |
| --- | --- | --- | --- |
| `SessionStart` | Reads Claude hook JSON from stdin. Appends shell exports for `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH`, and `CLAUDE_PLUGIN_DATA` to `CLAUDE_ENV_FILE`. | Hook timeout is 5 seconds. Empty values are not exported. | Claude-specific adapter required. The three resulting runtime variables can be preserved. |
| `SessionEnd` | Resolves the workspace, requests `broker/shutdown`, kills active jobs belonging to the ending session, removes every job/artifact for that session (including completed jobs), tears down socket/PID/log/temp directory, and clears `broker.json`. | Shutdown and process cleanup are mostly best effort; hook timeout is 5 seconds. Other sessions' job records remain. | Hook protocol is Claude-specific; cleanup functions are reusable. Lifecycle ownership needs redesign for hosts with overlapping sessions. |
| `Stop` | When gate is disabled, only warns on stderr about a running session job. When enabled and Codex exists, synchronously launches `task --json` with the previous Claude response embedded in a stop-gate prompt. `ALLOW:` permits stop; `BLOCK:` emits `{"decision":"block","reason":...}`. | Hook timeout is 900 seconds; child timeout is 15 minutes. Missing Codex is fail-open with setup guidance. Once run, timeout, execution failure, empty/invalid JSON, or unexpected output is fail-closed and blocks. | Entire trigger/decision protocol and `last_assistant_message` are Claude-specific. The review prompt and task execution are reusable. |

The stop review is a normal tracked task titled `Codex Stop Gate Review`, is
session-scoped when a session ID is available, and is resumable like other
persistent task threads. Evidence includes the five stop-hook tests in
`tests/runtime.test.mjs`, beginning with `stop hook runs a stop-time review task
and blocks on findings when the review gate is enabled`.

## Session and runtime environment

| Variable/input | Producer | Consumer and meaning | Portability |
| --- | --- | --- | --- |
| `CLAUDE_PLUGIN_ROOT` | Claude Code plugin loader | Command/agent Markdown locates `codex-companion.mjs`. | Claude-only; replace with adapter install-root discovery. |
| `CLAUDE_ENV_FILE` | Claude Code session hook runtime | SessionStart appends exported variables for subsequent commands. | Claude-only propagation mechanism. |
| `CLAUDE_PLUGIN_DATA` | Claude Code | State root becomes `$CLAUDE_PLUGIN_DATA/state`; SessionStart re-exports it. Without it, state falls back to `$TMPDIR/codex-companion`. | Claude-specific source, reusable storage concept. A stable zcode-owned data root is preferable to temp fallback. |
| `CLAUDE_PROJECT_DIR` | Claude Code | Stop hook cwd fallback. | Claude-only; replace with host workspace cwd. |
| Hook JSON `session_id` | Claude Code | Exported as `CODEX_COMPANION_SESSION_ID`; scopes default status/result/cancel/resume and SessionEnd cleanup. | Host adapter must provide an equivalent stable session ID. |
| Hook JSON `transcript_path` | Claude Code | Exported as `CODEX_COMPANION_TRANSCRIPT_PATH`; default source for transfer. | Claude-specific path and format. |
| Hook JSON `cwd` | Claude Code | Workspace for stop and end hooks. | Direct mapping to host workspace. |
| Hook JSON `last_assistant_message` | Claude Code | Included in stop-gate prompt to determine whether the previous turn edited code and whether it should block. | Host adapter must expose equivalent last-turn content. |
| `CODEX_COMPANION_SESSION_ID` | SessionStart or explicit child env | Persists on job records and drives session visibility/cleanup. | Reusable contract. |
| `CODEX_COMPANION_TRANSCRIPT_PATH` | SessionStart | Transfer source fallback. | Name reusable; payload remains Claude-specific today. |
| `CODEX_COMPANION_APP_SERVER_ENDPOINT` | Optional external/session configuration | Forces broker client transport and affects runtime status. | Reusable. Normal lazy startup persists endpoint in `broker.json` rather than exporting this variable. |
| `CODEX_COMPANION_APP_SERVER_PID_FILE` / `...LOG_FILE` | Optional external/session configuration | SessionEnd fallback metadata when no persisted broker session is found. | Reusable but not normally populated by SessionStart. |
| `CODEX_HOME` | User/Codex environment | Locates the external-agent import ledger; defaults to `~/.codex`. | Codex-specific, host-neutral. |
| `PATH`, Codex auth/config | Machine environment | Finds `node`, `npm`, `git`, and `codex`; app-server inherits normal Codex auth and `config.toml`. | Directly reusable. |

`session start hook exports the Claude session id, transcript path, and plugin
data dir` and `resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided`
verify the main propagation and storage contracts.

## Jobs, state, logs, status, and cancellation

### Persistence

- State is partitioned by canonical workspace root using
  `<basename>-<sha256-prefix>`.
- The index is `state.json`; detailed jobs are `jobs/<job-id>.json`; logs are
  `jobs/<job-id>.log`; broker metadata is `broker.json`.
- The index retains at most 50 jobs. Pruning also removes dropped per-job JSON
  and log files (`saveState prunes dropped job artifacts when indexed jobs
  exceed the cap`).
- Job IDs are timestamp/random IDs prefixed `review-` or `task-`.
- State transitions are `queued` -> `running` -> `completed|failed`, with
  `cancelled` as an explicit terminal state. Phases include `queued`,
  `starting`, `investigating`, `reviewing`, `editing`, `verifying`,
  `finalizing`, `done`, `failed`, and `cancelled`.

### Progress and logs

App-server notifications are converted into progress events for thread/turn
creation, review mode, shell commands, file changes, MCP/dynamic tools, web
search, collaboration subagents, reasoning summaries, assistant messages, and
turn completion. The job index receives phase/thread/turn updates; the log
receives timestamped lines and full blocks such as `Reasoning summary`,
`Assistant message`, `Subagent <id> message`, `Review output`, and `Final
output`.

Status previews use the last four timestamped progress lines and deliberately
exclude full output/reasoning blocks. Status displays log paths for running and
failed jobs, elapsed/duration, Codex thread IDs, resume commands, cancel/result
hints, and review hints after write-capable tasks.

### Scoping rules

- No-ID `status`, `result`, `cancel`, and rescue resume candidate prefer or
  restrict to `CODEX_COMPANION_SESSION_ID`.
- Explicit job IDs or unique prefixes can inspect/result/cancel jobs from other
  sessions in the same workspace.
- If no session ID exists, behavior falls back to workspace-global jobs. Resume
  may then query Codex `thread/list` for the latest named app-server task.
- A currently active task in the visible session prevents resume.

### Cancellation

Cancellation is cooperative first and forceful second:

1. Read stored `threadId` and `turnId`.
2. Connect to the existing broker if possible and send `turn/interrupt`.
3. Terminate the recorded worker process group/tree even if interrupt failed or
   was impossible.
4. Log and persist `cancelled`.

On SessionEnd, active session jobs are killed directly without first sending a
per-turn interrupt; all artifacts for that session are then removed.

## Shared app-server behavior

- The first review/task command calls `ensureBrokerSession`, creating a temp
  directory, Unix socket or Windows named pipe, PID file, broker log, detached
  broker process, and workspace `broker.json`.
- The broker owns one direct `codex app-server` initialized as client
  `Claude Code` / service `claude_code_codex_plugin`, then multiplexes local
  clients over JSONL.
- Commands reuse the persisted ready broker. Setup only reuses an existing
  broker. Transfer always bypasses the broker because import completion and
  ledger handling use a dedicated direct app-server.
- The broker permits one active request/stream owner. Other work receives RPC
  `-32001` (`Shared Codex broker is busy`). `withAppServer` retries busy,
  missing-socket, or refused-connection cases using a new direct app-server.
- A second socket may send `turn/interrupt` during an active stream, which is
  how cancellation remains responsive.
- Stream ownership is tracked for `turn/start`, `review/start`, and
  `thread/compact/start` until the matching `turn/completed`.
- Broker startup waits up to 2 seconds. If startup is not ready, runtime calls
  fall back to direct app-server startup.
- SessionEnd requests broker shutdown, then removes its runtime files and
  persisted workspace broker record.

Evidence: `commands lazily start and reuse one shared app-server after first
use`, `setup reuses an existing shared app-server without starting another
one`, `task using the shared broker still completes when Codex spawns
subagents`, and the endpoint tests for Unix sockets and Windows named pipes.

## Detailed behavior notes

### Review

- `auto` target selection is deterministic: dirty tree first, otherwise branch
  against `origin/HEAD`, then `main`, `master`, or `trunk`.
- Native review maps only to `uncommittedChanges` or `baseBranch`.
- Adversarial review captures staged, unstaged, and untracked text. Untracked
  directories, unreadable/broken symlinks, binary files, and files over 24 KiB
  are skipped or summarized safely.
- Native review uses `review/start`; adversarial review uses `turn/start` with
  a read-only sandbox and strict output schema. Both are tracked jobs.
- Review command output is contractually verbatim and review commands must not
  apply fixes.

### Rescue

- The Claude subagent is intentionally a thin forwarder with Bash only. It must
  make one `task` invocation and return stdout unchanged.
- New rescue threads are persistent and named `Codex Companion Task: ...`.
  Resume uses the latest finished task with a thread ID from the same Claude
  session; it does not resume queued/running or other-session tasks.
- The main parent thread determines final returned output. Later subagent
  messages do not replace it, while missing parent completion can be inferred
  after subagent completion. This behavior is covered by the task completion
  and subagent tests around lines 839-921 of `tests/runtime.test.mjs`.
- Runtime task execution deliberately skips auth preflight so Codex can refresh
  stale sessions and return the actual auth error when it cannot.

### Transfer

- Transfer is not a generic conversation export. It is hard-coded to Claude
  JSONL under `~/.claude/projects` and Codex's
  `externalAgentConfig/import` schema.
- Import requests include only the session path/cwd; plugins, MCP servers,
  hooks, subagents, and commands are empty arrays. Therefore transferred visible
  turns do not imply transferred Claude runtime capabilities.
- Successful RPC completion is insufficient: the plugin verifies Codex's
  external import ledger and reports failure if no matching imported thread was
  recorded.

### Setup and review gate

- `ready` requires Node, Codex app-server availability, and an auth/provider
  state that app-server considers usable. npm is not required when Codex is
  already present.
- ChatGPT account auth is verified; API-key auth is accepted but labeled
  unverified. Providers with `requiresOpenaiAuth: false`, including custom
  providers, are accepted.
- Gate configuration is persisted per workspace, not per Claude session.
- The gate reviews only the immediately previous Claude turn according to the
  prompt, and should immediately allow non-edit turns. Enforcement relies on
  Codex following the `ALLOW:`/`BLOCK:` first-line contract.

## Dependency and reuse matrix

| Component | Directly reusable | Adapter required | Claude Code-specific / replace |
| --- | --- | --- | --- |
| Argument parser, cwd resolution, Git target/context collection | Yes | UI flags may differ | No |
| Codex availability, provider/auth probes, config inheritance | Yes | Replace `!codex login` display syntax | No |
| App-server JSON-RPC client and generated protocol types | Yes | Update protocol types with Codex versions | Default client name/service currently says Claude Code |
| Broker endpoint/lifecycle and busy fallback | Yes | Define ownership for zcode sessions | Current teardown assumes Claude SessionEnd |
| Job model, per-workspace state, logs, renderers | Mostly | Supply stable data root and session ID; optionally replace slash-command hints | `CLAUDE_PLUGIN_DATA` source and `/codex:*` strings |
| Internal `task`, review, status, result, cancel CLI | Yes | Expose through zcode commands/actions | User copy references Claude/Codex plugin commands |
| Review prompts and schema | Yes | None beyond product naming | No |
| Slash-command Markdown frontmatter and tool permissions | No | Reimplement in zcode command format | `allowed-tools`, `disable-model-invocation`, `$ARGUMENTS`, shell interpolation |
| Foreground/background choice UX | Logic reusable | Reimplement prompt and detachment | `AskUserQuestion`, Claude background `Bash`, background `Agent` |
| Rescue subagent | Runtime task reusable | Replace with direct task dispatch or zcode agent | Claude `Agent`, `subagent_type`, agent/skill registration |
| SessionStart/SessionEnd/Stop hooks | Cleanup/review functions reusable | Map zcode lifecycle and last-turn data | Claude hook JSON, `CLAUDE_ENV_FILE`, block decision schema |
| Transfer | Import helper partly reusable | Define a zcode transcript converter/import source | Current validation and import are Claude-specific |
| Marketplace/plugin manifests | No | Create zcode packaging/manifest | `.claude-plugin`, Claude marketplace schema |

## High-risk migration points

1. **Background semantics are split across host and runtime.** Reviews rely on
   Claude background Bash; rescue relies on a background Claude Agent; only
   internal `task --background` owns a detached worker. Mapping every
   `--background` flag directly to the worker would change output, cancellation,
   and session-lifetime behavior.
2. **Broker ownership is workspace-scoped while cleanup is session-triggered.**
   `broker.json` is keyed by workspace, but any SessionEnd tears down that
   broker. Overlapping zcode sessions in one repository need reference counting,
   leases, or host-owned lifetime management.
3. **State updates are synchronous read-modify-write without locking or atomic
   rename.** Concurrent direct fallback runs, workers, cancellation, and hooks
   can update the same workspace index. A more concurrent host can expose lost
   updates or partial JSON more often.
4. **Session identity controls privacy and behavior.** Missing or unstable
   session IDs broaden status/result/resume/cancel to workspace scope; explicit
   job IDs intentionally cross sessions. The adapter must define whether that
   is acceptable.
5. **SessionEnd is destructive.** It removes completed results/logs as well as
   active jobs for the ending session. A host that expects durable history must
   decouple process cleanup from artifact retention.
6. **Transfer is Claude-specific end to end.** Path trust, JSONL shape, Codex
   import API, completion notification, and ledger verification cannot be
   relabeled as zcode transfer. A converter or a new Codex-supported external
   agent format is required.
7. **The stop gate mixes fail-open and fail-closed paths.** Missing Codex allows
   stop, while runtime errors/timeouts/malformed answers block it. zcode must
   preserve or deliberately redefine this policy and prevent unbounded
   edit-review loops.
8. **Shared broker concurrency is best effort, not a queue.** It serializes one
   active stream but busy clients fall back to separate app-server processes.
   Do not promise a single runtime or strict ordering under concurrent jobs.
9. **Protocol/version coupling is material.** `review/start`,
   `externalAgentConfig/import`, completion notifications, import ledger shape,
   and optional `thread/name/set` vary by Codex version. Transfer is especially
   sensitive and intentionally returns an upgrade error for `-32601`.
10. **User-visible strings encode Claude commands.** Setup, errors, status,
    cancellation, login, and review hints contain `/codex:*`, `${CLAUDE_PLUGIN_ROOT}`,
    or `!codex ...`; a functional adapter still needs a complete copy audit.

## Verification map

The repository's tests cover:

- command exposure and Claude orchestration contracts:
  `tests/commands.test.mjs`;
- review target selection and bounded context:
  `tests/git.test.mjs`;
- setup/auth, review/task/transfer, resume, background jobs, status/result,
  cancel, hooks, and shared broker:
  `tests/runtime.test.mjs`;
- state root and pruning:
  `tests/state.test.mjs`;
- Unix/Windows broker endpoints:
  `tests/broker-endpoint.test.mjs`;
- cross-platform process-tree termination:
  `tests/process.test.mjs`;
- malformed and stored result rendering:
  `tests/render.test.mjs`;
- marketplace/plugin/package version consistency:
  `tests/bump-version.test.mjs`.

Notably absent are stress tests for simultaneous state writers, overlapping
host sessions sharing one workspace broker, crash recovery from truncated
state/job files, and zcode lifecycle integration. Those gaps align with the
highest-risk migration points above.

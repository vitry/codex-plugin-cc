# ZCode Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship an independent ZCode plugin that preserves the existing Codex Companion user capabilities while replacing Claude Code with ZCode as the plugin host.

**Architecture:** ZCode installs the repository root as the plugin root. ZCode-specific commands, rescue agent, MCP bridge, and hooks live under `plugins/zcode`, while the Codex app-server client, broker, job store, review logic, and renderers remain in `plugins/codex/scripts`. Commands call the plugin MCP bridge instead of relying on unsupported dynamic shell; a host adapter supplies stable host identity, workspace/session/storage values, and transcript access without exposing ZCode protocol details to the companion runtime.

**Tech Stack:** Node.js ESM, Node test runner, Codex app-server JSON-RPC, ZCode plugin manifests/commands/hooks, built-in Node SQLite with SQLite CLI fallback for ZCode session extraction, GitHub CLI for Draft PR management.

---

### Task 1: Define the ZCode plugin package

**Files:**
- Create: `.zcode-plugin/plugin.json`
- Create: `marketplace.json`
- Create: `plugins/zcode/commands/setup.md`
- Create: `tests/zcode-plugin.test.mjs`
- Modify: `scripts/bump-version.mjs`
- Modify: `tests/bump-version.test.mjs`

- [x] **Step 1: Write the failing manifest tests**

Add tests that load `.zcode-plugin/plugin.json` and assert:

```js
assert.equal(plugin.name, "codex");
assert.equal(plugin.commands, "plugins/zcode/commands");
assert.equal(plugin.hooks, "plugins/zcode/hooks/hooks.json");
assert.equal(plugin.skills, "plugins/codex/skills");
assert.equal(plugin.version, packageJson.version);
```

Add a command-source test that rejects ZCode-incompatible inline shell:

```js
for (const file of commandFiles) {
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(source, /!`|```!/);
  assert.match(source, /\$\{ZCODE_PLUGIN_ROOT\}/);
}
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/zcode-plugin.test.mjs tests/bump-version.test.mjs`

Expected: FAIL because the ZCode manifests and command directory do not exist.

- [x] **Step 3: Add the minimal package and setup command**

Create `.zcode-plugin/plugin.json` with:

```json
{
  "name": "codex",
  "version": "1.0.6",
  "description": "Use Codex from ZCode to review code or delegate tasks.",
  "author": { "name": "OpenAI" },
  "license": "Apache-2.0",
  "commands": "plugins/zcode/commands",
  "skills": "plugins/codex/skills",
  "hooks": "plugins/zcode/hooks/hooks.json"
}
```

Create the root `marketplace.json` with one plugin sourced from `"."`, and create a static `setup.md` that instructs ZCode to call:

```bash
node "${ZCODE_PLUGIN_ROOT}/plugins/codex/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

The command body must ask through ZCode's normal user-input tool before a global npm install and must never use inline dynamic-shell Markdown.

- [x] **Step 4: Teach version tooling about both ZCode manifests**

Extend the release manifest list in `scripts/bump-version.mjs` so the package, Claude marketplace/plugin manifest, root ZCode marketplace, and ZCode plugin manifest stay on one version.

- [x] **Step 5: Run the focused tests and verify GREEN**

Run: `node --test tests/zcode-plugin.test.mjs tests/bump-version.test.mjs`

Expected: PASS.

- [x] **Step 6: Validate through the installed ZCode protocol**

Start `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server`, call `plugins/validate` with the absolute root `marketplace.json` path as source, and assert the result has no error diagnostics and lists `commands`, `skills`, and `hooks`. ZCode 0.15.2 only auto-discovers `.claude-plugin/marketplace.json` or a root `marketplace.json`; a marketplace nested under `.zcode-plugin` cannot reference the repository root because plugin source resolution rejects `..`.

- [x] **Step 7: Commit**

```bash
git add .zcode-plugin marketplace.json plugins/zcode/commands/setup.md scripts/bump-version.mjs tests/bump-version.test.mjs tests/zcode-plugin.test.mjs
git commit -m "feat: add ZCode plugin package"
```

### Task 2: Introduce the host adapter

**Files:**
- Create: `plugins/codex/scripts/lib/host.mjs`
- Create: `tests/host.test.mjs`
- Modify: `plugins/codex/scripts/lib/state.mjs`
- Modify: `plugins/codex/scripts/lib/app-server.mjs`
- Modify: `plugins/codex/scripts/lib/codex.mjs`
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs`

- [x] **Step 1: Write failing host-resolution tests**

Test this interface:

```js
resolveHost({
  ZCODE_PLUGIN_ROOT: "/plugin",
  ZCODE_PLUGIN_DATA: "/data",
  ZCODE_PROJECT_DIR: "/repo",
  ZCODE_SESSION_ID: "sess_z"
});
```

Expected value:

```js
{
  kind: "zcode",
  displayName: "ZCode",
  serviceName: "zcode_codex_plugin",
  pluginRoot: "/plugin",
  pluginDataDir: "/data",
  projectDir: "/repo",
  sessionId: "sess_z"
}
```

Also test Claude compatibility and the existing temp-state fallback.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/host.test.mjs tests/state.test.mjs`

Expected: FAIL because `host.mjs` does not exist.

- [x] **Step 3: Implement the small host interface**

Export `resolveHost(env, cwd)`, `resolveHostSessionId(env)`, and `resolveHostPluginDataDir(env)`. Prefer `ZCODE_*`, retain `CLAUDE_*`, and retain `CODEX_COMPANION_SESSION_ID` as the runtime override.

- [x] **Step 4: Route shared runtime metadata through the adapter**

Use the host adapter for state storage, stop-hook cwd, app-server client title/name, and Codex service name. Do not change command behavior.

- [x] **Step 5: Run focused and full tests**

Run: `node --test tests/host.test.mjs tests/state.test.mjs tests/runtime.test.mjs`

Expected: PASS, including all existing Claude compatibility tests.

- [x] **Step 6: Commit**

```bash
git add plugins/codex/scripts/lib/host.mjs plugins/codex/scripts/lib/state.mjs plugins/codex/scripts/lib/app-server.mjs plugins/codex/scripts/lib/codex.mjs plugins/codex/scripts/stop-review-gate-hook.mjs tests/host.test.mjs tests/state.test.mjs tests/runtime.test.mjs
git commit -m "refactor: isolate plugin host metadata"
```

### Task 3: Add the ZCode MCP runtime bridge

**Files:**
- Create: `plugins/zcode/scripts/mcp-server.mjs`
- Create: `plugins/zcode/scripts/lib/companion-runner.mjs`
- Create: `tests/zcode-mcp.test.mjs`
- Modify: `.zcode-plugin/plugin.json`
- Modify: `tests/zcode-plugin.test.mjs`

- [x] **Step 1: Write failing MCP interface tests**

Spawn the server over stdio and verify standard MCP `initialize`, `tools/list`, and `tools/call` messages. The server exposes one deep tool:

```json
{
  "name": "companion",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": {
        "enum": [
          "setup",
          "review",
          "adversarial-review",
          "task",
          "transfer",
          "status",
          "result",
          "task-resume-candidate",
          "cancel"
        ]
      },
      "arguments": { "type": "string" }
    },
    "required": ["command"]
  }
}
```

Assert an unknown command is rejected without spawning a process, `cwd` comes from `ZCODE_PROJECT_DIR`, and plugin data is mapped to the host adapter.

- [x] **Step 2: Run and verify RED**

Run: `node --test tests/zcode-mcp.test.mjs`

Expected: FAIL because the MCP server does not exist.

- [x] **Step 3: Implement the dependency-free MCP bridge**

Implement NDJSON JSON-RPC handling for `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` using Node built-ins. `companion-runner.mjs` parses the argument string with the existing argument parser, invokes:

```bash
node <plugin-root>/plugins/codex/scripts/codex-companion.mjs <allowed-command> <arguments>
```

Return stdout as MCP text content. Return stderr and a failed result when the child exits non-zero. Never accept an executable path or arbitrary subcommand from tool input.

- [x] **Step 4: Register the MCP server**

Add this manifest entry:

```json
{
  "mcpServers": {
    "codex": {
      "command": "node",
      "args": ["${ZCODE_PLUGIN_ROOT}/plugins/zcode/scripts/mcp-server.mjs"],
      "cwd": "${ZCODE_PROJECT_DIR}",
      "env": {
        "CODEX_COMPANION_HOST": "zcode",
        "CODEX_COMPANION_PLUGIN_ROOT": "${ZCODE_PLUGIN_ROOT}",
        "ZCODE_PLUGIN_DATA": "${ZCODE_PLUGIN_DATA}",
        "ZCODE_PROJECT_DIR": "${ZCODE_PROJECT_DIR}"
      }
    }
  }
}
```

- [x] **Step 5: Run tests and ZCode validation**

Run:

```bash
node --test tests/zcode-mcp.test.mjs tests/zcode-plugin.test.mjs
```

Expected: PASS. ZCode `plugins/validate` and `plugins/describe` must report the `codex` MCP server without error diagnostics.

- [x] **Step 6: Commit**

```bash
git add .zcode-plugin/plugin.json plugins/zcode/scripts tests/zcode-mcp.test.mjs tests/zcode-plugin.test.mjs
git commit -m "feat: bridge ZCode commands to Codex runtime"
```

### Task 4: Expose all commands in ZCode

**Files:**
- Create: `plugins/zcode/commands/review.md`
- Create: `plugins/zcode/commands/adversarial-review.md`
- Create: `plugins/zcode/commands/rescue.md`
- Create: `plugins/zcode/commands/transfer.md`
- Create: `plugins/zcode/commands/status.md`
- Create: `plugins/zcode/commands/result.md`
- Create: `plugins/zcode/commands/cancel.md`
- Create: `plugins/zcode/agents/codex-rescue.md`
- Modify: `plugins/zcode/commands/setup.md`
- Modify: `.zcode-plugin/plugin.json`
- Modify: `tests/zcode-plugin.test.mjs`

- [x] **Step 1: Extend the failing command-parity test**

Assert the normalized ZCode command set is exactly:

```js
[
  "adversarial-review",
  "cancel",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "transfer"
]
```

For every command, assert `$ARGUMENTS` is present, the `codex` MCP tool is named, and no direct shell/runtime path is embedded.

- [x] **Step 2: Run and verify RED**

Run: `node --test tests/zcode-plugin.test.mjs`

Expected: FAIL with seven missing commands.

- [x] **Step 3: Add static ZCode command prompts**

Translate each Claude command into static instructions using ZCode's recognized frontmatter. Route deterministic execution through `mcp__codex__companion`. Preserve all flags, verbatim-output rules, read-only review rules, resume choice, model/effort handling, and setup guidance.

For rescue, register `plugins/zcode/agents/codex-rescue.md`; the agent is a thin forwarder that makes one MCP call equivalent to:

```json
{ "command": "task", "arguments": "--write <forwarded arguments>" }
```

For review/status/result/cancel/transfer, call the matching allowlisted command through the same MCP tool.

- [x] **Step 4: Validate discovery using ZCode**

Call ZCode `plugins/validate` and `plugins/describe`; assert eight command items and no command diagnostics.

- [x] **Step 5: Run tests and commit**

Run: `node --test tests/zcode-plugin.test.mjs tests/commands.test.mjs`

Expected: PASS.

```bash
git add plugins/zcode/commands tests/zcode-plugin.test.mjs
git commit -m "feat: expose Codex commands in ZCode"
```

### Task 5: Create and publish the first runnable milestone

**Files:**
- Modify: `README.md`
- Create or update: GitHub Draft PR `zcode-adapter -> main`

- [x] **Step 1: Run the complete baseline**

Run: `npm test`

Expected: all existing and new tests pass.

- [x] **Step 2: Exercise setup and a read-only task from the ZCode package path**

Run:

```bash
node plugins/codex/scripts/codex-companion.mjs setup --json
node plugins/codex/scripts/codex-companion.mjs task "Reply with exactly ZCODE_CODEX_OK"
```

Expected: setup reports Codex ready and the task returns `ZCODE_CODEX_OK`.

- [x] **Step 3: Document local marketplace installation**

Add ZCode installation, enablement, command discovery, and removal instructions to `README.md`, keeping Claude Code instructions intact.

- [x] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs: add ZCode development install"
git push origin zcode-adapter
```

- [x] **Step 5: Create the Draft PR**

Create `zcode-adapter -> main` in `vitry/codex-plugin-cc`. The PR body must include the architecture decision, completed milestone checklist, exact test commands, remaining hooks/background/transfer work, and a statement that no PR will be sent to `openai`.

### Task 6: Make background review host-independent

**Files:**
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/tracked-jobs.mjs`
- Modify: `plugins/codex/scripts/lib/job-control.mjs`
- Modify: `tests/runtime.test.mjs`

- [x] **Step 1: Write failing detached-review tests**

Add a test that runs:

```bash
codex-companion.mjs review --background --scope working-tree
```

Assert the process returns a queued job promptly, a detached worker finishes it, `status --wait <id>` reaches `completed`, and `result <id>` returns the review.

- [x] **Step 2: Run and verify RED**

Run the named runtime test.

Expected: FAIL because `review --background` currently runs foreground.

- [x] **Step 3: Generalize detached worker requests**

Persist a discriminated request:

```js
{ type: "review", cwd, base, scope, model, focusText, reviewName }
```

Dispatch `task-worker` and `review-worker` through one internal job-worker entrypoint. Keep foreground behavior unchanged.

- [x] **Step 4: Run focused and full tests**

Run: `node --test tests/runtime.test.mjs`

Expected: PASS for task and review background flows.

- [x] **Step 5: Commit and update the Draft PR**

```bash
git add plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/tracked-jobs.mjs plugins/codex/scripts/lib/job-control.mjs tests/runtime.test.mjs
git commit -m "feat: detach background reviews in runtime"
git push origin zcode-adapter
```

Update the PR checklist and test evidence.

### Task 7: Adapt ZCode lifecycle and review gate hooks

**Files:**
- Create: `plugins/zcode/hooks/hooks.json`
- Create: `plugins/zcode/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/zcode/scripts/stop-review-gate-hook.mjs`
- Modify: `plugins/codex/scripts/session-lifecycle-hook.mjs`
- Modify: `plugins/codex/scripts/stop-review-gate-hook.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/zcode-plugin.test.mjs`

- [x] **Step 1: Write failing ZCode hook contract tests**

Assert only the required ZCode events are registered:

```js
assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "SessionStart", "Stop"]);
```

Assert hooks use `type: "process"`, `${ZCODE_PLUGIN_ROOT}`, millisecond timeouts, and no `SessionEnd`.
`PreToolUse` must match only `mcp__codex__companion`.

Add stdin fixture tests for ZCode `SessionStart` and `Stop` payloads, including strict Stop output:

```json
{ "decision": "block", "reason": "..." }
```

- [x] **Step 2: Run and verify RED**

Run: `node --test tests/zcode-plugin.test.mjs tests/runtime.test.mjs`

Expected: FAIL because ZCode hooks do not exist and host payload aliases are unsupported.

- [x] **Step 3: Add thin ZCode hook wrappers**

Map ZCode session/workspace/response fields to the existing runtime hook functions. Persist lifecycle session identity in workspace state instead of relying on `CLAUDE_ENV_FILE`. Because MCP configuration is resolved before a runtime session exists, use `PreToolUse.updatedInput` to inject the calling `sessionId` into each companion tool call; the MCP runner maps that value to `CODEX_COMPANION_SESSION_ID` for only that invocation. Keep Stop fail-open for unavailable Codex and fail-closed after an actual review starts.

Because ZCode has no `SessionEnd`, retain completed artifacts and use stale broker detection plus process exit handling instead of deleting session history at Stop.

- [x] **Step 4: Validate hook registration and run tests**

Use ZCode `plugins/validate`/`plugins/describe`, then run:

```bash
node --test tests/zcode-plugin.test.mjs tests/runtime.test.mjs
```

Expected: PASS.

- [x] **Step 5: Commit and update the Draft PR**

```bash
git add plugins/zcode/hooks plugins/zcode/scripts plugins/codex/scripts/session-lifecycle-hook.mjs plugins/codex/scripts/stop-review-gate-hook.mjs tests/runtime.test.mjs tests/zcode-plugin.test.mjs
git commit -m "feat: adapt lifecycle hooks for ZCode"
git push origin zcode-adapter
```

### Task 8: Transfer ZCode sessions into Codex

**Files:**
- Create: `plugins/codex/scripts/lib/zcode-session-transfer.mjs`
- Create: `tests/zcode-session-transfer.test.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`
- Modify: `plugins/codex/scripts/lib/codex.mjs`
- Modify: `tests/fake-codex-fixture.mjs`
- Modify: `tests/runtime.test.mjs`

- [x] **Step 1: Write failing SQLite session-reader tests**

Create a temporary SQLite database with `session`, `message`, and `part` rows matching ZCode 0.15.x. Assert the reader selects the explicit/current session, orders visible user/assistant text, excludes reasoning/tool internals, and rejects a session from another workspace unless explicitly selected.

- [x] **Step 2: Run and verify RED**

Run: `node --test tests/zcode-session-transfer.test.mjs`

Expected: FAIL because the reader does not exist.

- [x] **Step 3: Implement the ZCode session reader and Claude-import projection**

Read `~/.zcode/cli/db/db.sqlite` through Node.js 22.5+'s built-in read-only SQLite API, with the installed `sqlite3` command as an older-Node fallback. Project visible messages into a deterministic Claude-compatible JSONL file inside the plugin data directory with stable UUIDs, session ID, cwd, timestamps, and `message.role/content`.

The converter interface is:

```js
export function exportZCodeSession(cwd, {
  sessionId,
  databasePath,
  outputDir
}) {
  return { sourcePath, sessionId, messageCount };
}
```

- [x] **Step 4: Verify the projection against real Codex import**

Use a disposable projected transcript and Codex `externalAgentConfig/import`. Confirm the completion notification and import ledger identify a persistent Codex thread. Do not alter or delete the source ZCode database.

- [x] **Step 5: Route transfer by host**

Claude continues using `resolveClaudeSessionPath`. ZCode defaults to the current `ZCODE_SESSION_ID` and database path, while `--source` accepts an explicit ZCode session ID or database path according to documented syntax. Render “Transferred the ZCode session”.

- [x] **Step 6: Run focused and full tests**

Run:

```bash
node --test tests/zcode-session-transfer.test.mjs tests/runtime.test.mjs
npm test
```

Expected: PASS.

- [x] **Step 7: Commit and update the Draft PR**

```bash
git add plugins/codex/scripts/lib/zcode-session-transfer.mjs plugins/codex/scripts/codex-companion.mjs plugins/codex/scripts/lib/codex.mjs tests/zcode-session-transfer.test.mjs tests/fake-codex-fixture.mjs tests/runtime.test.mjs
git commit -m "feat: transfer ZCode sessions to Codex"
git push origin zcode-adapter
```

### Task 9: Harden shared state and broker lifecycle

**Files:**
- Modify: `plugins/codex/scripts/lib/state.mjs`
- Modify: `plugins/codex/scripts/lib/broker-lifecycle.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/runtime.test.mjs`

- [x] **Step 1: Write failing concurrency and stale-broker tests**

Test atomic state replacement under concurrent writers, recovery from a stale broker PID/socket, and preservation of completed ZCode session artifacts across Stop.

- [x] **Step 2: Run and verify RED**

Run: `node --test tests/state.test.mjs tests/runtime.test.mjs`

Expected: FAIL on lost updates or stale broker metadata.

- [x] **Step 3: Implement lock-and-rename persistence**

Write state to a same-directory temporary file, fsync/close, then rename over `state.json`. Serialize read-modify-write mutations with a bounded lock file and remove abandoned locks only after validating owner PID and age.

- [x] **Step 4: Reclaim stale broker sessions**

Before reuse, verify PID liveness and endpoint connectivity. Clear stale metadata and runtime files, then start a fresh broker.

- [x] **Step 5: Run focused and full tests**

Run: `node --test tests/state.test.mjs tests/runtime.test.mjs && npm test`

Expected: PASS.

- [x] **Step 6: Commit and update the Draft PR**

Commit with `fix: harden shared companion state`, push, and update risk/test notes in the PR.

### Task 10: Install and verify in the local ZCode application

**Files:**
- Modify: `README.md`
- Modify: `plugins/codex/CHANGELOG.md`
- Create: `docs/verification/zcode-0.15.2.md`

- [x] **Step 1: Install the local marketplace**

Add the worktree's absolute root `marketplace.json` file as a local ZCode marketplace through ZCode Protocol `plugins/marketplace/add`, install `codex`, enable it, and record the installed plugin root. Preserve the user's existing enabled plugins and settings.

- [x] **Step 2: Verify discovery**

Check `plugins/list`, `plugins/describe`, and `commands list --json`. Confirm all eight commands, three shared skills, and three hooks are visible with no diagnostics.

- [x] **Step 3: Run the end-to-end capability matrix**

In a disposable Git repository and ZCode session, verify:

1. setup reports the actual Codex provider/auth state;
2. review and adversarial review return read-only findings;
3. rescue performs a write-capable delegated change and can resume/fresh-route;
4. background review/task appear in status, return result, and can be cancelled;
5. transfer creates a resumable Codex thread with visible ZCode conversation history;
6. Stop gate allows clean output and blocks a deliberately failing fixture;
7. original Claude-focused automated tests remain green.

- [x] **Step 4: Record exact evidence**

Write ZCode version, plugin source/root, commands executed, job IDs/thread IDs with sensitive values redacted, expected/actual outcomes, and log locations to `docs/verification/zcode-0.15.2.md`.

- [x] **Step 5: Update user documentation and changelog**

Document supported commands, ZCode version tested, local/marketplace installation, Codex prerequisite, state location, transfer behavior, and lifecycle limitations.

- [x] **Step 6: Commit, push, and update PR**

Commit with `docs: record ZCode end-to-end verification`, push, and update the Draft PR with the completed verification matrix.

 Final review and PR readiness

**Files:**
- Review all files changed from `origin/main...zcode-adapter`
- Update the existing GitHub PR

- [x] **Step 1: Run release verification**

Run:

```bash
npm install
npm run check-version
npm run build
npm test
```

Expected: all commands succeed with no failed tests.

- [x] **Step 2: Run ZCode manifest/runtime verification again**

Re-run `plugins/validate`, `plugins/describe`, command discovery, setup, one review, one rescue, status/result/cancel, transfer, and Stop gate checks against the exact pushed commit.

- [x] **Step 3: Perform two-stage review**

Dispatch one reviewer for objective/spec compliance and a separate reviewer for code quality. Fix every confirmed issue with a failing regression test and re-run both reviews.

- [x] **Step 4: Audit the objective**

Map every existing command/hook/runtime capability in `docs/research/current-capabilities.md` to an automated test and ZCode verification result. Treat missing evidence as incomplete work.

- [x] **Step 5: Push and mark Ready**

Push the reviewed commit, replace provisional PR notes with final evidence, and convert the Draft PR to Ready for review. Do not create or target an upstream OpenAI PR.

# ZCode Nested Repository Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ZCode review commands reliably select a unique nested Git repository and expose an explicit `--cwd` override.

**Architecture:** Add bounded nested-repository discovery to the shared Git module, but activate automatic discovery only in the ZCode review command path. Keep explicit working-directory selection authoritative and strengthen ZCode command templates so failures remain inside the plugin transport.

**Tech Stack:** Node.js ESM, synchronous filesystem APIs, Git CLI, Node test runner, ZCode plugin Markdown commands.

---

### Task 1: Repository Resolution

**Files:**
- Modify: `tests/git.test.mjs`
- Modify: `plugins/codex/scripts/lib/git.mjs`

- [x] **Step 1: Write failing repository-resolution tests**

Add tests importing `resolveReviewCwd` that create temporary parent directories containing zero,
one, and two nested repositories. Assert that an existing repository is preserved, one nested
repository is returned, multiple repositories report relative candidates and `--cwd`, and zero
repositories retain the existing error.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/git.test.mjs`

Expected: FAIL because `resolveReviewCwd` is not exported.

- [x] **Step 3: Implement bounded nested-repository discovery**

Add `resolveReviewCwd(cwd, { discoverNested })` to `git.mjs`. First test `cwd` itself, then scan
descendants for `.git` directories or files when discovery is enabled. Skip `.git`, `.claude`,
`.zcode`, `node_modules`, common build outputs, and paths deeper than four directory levels.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/git.test.mjs`

Expected: all Git tests pass.

### Task 2: Review Runtime Integration

**Files:**
- Modify: `tests/runtime.test.mjs`
- Modify: `plugins/codex/scripts/codex-companion.mjs`

- [x] **Step 1: Write failing ZCode runtime tests**

Run the companion from a non-repository parent containing one nested dirty repository and assert a
foreground review succeeds against that repository. Add a two-repository case that asserts the
error lists both candidates and recommends `--cwd`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/runtime.test.mjs`

Expected: the nested repository case fails with "This command must run inside a Git repository."

- [x] **Step 3: Integrate repository resolution**

In `handleReviewCommand`, resolve the host and requested directory before workspace and target
resolution. Enable discovery only when the host is ZCode and `--cwd` was not supplied. Use the
resolved repository directory for job metadata, background requests, and foreground execution.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/runtime.test.mjs`

Expected: all runtime tests pass.

### Task 3: Public Command Contract

**Files:**
- Modify: `tests/zcode-plugin.test.mjs`
- Modify: `tests/commands.test.mjs`
- Modify: `plugins/zcode/commands/codex/review.md`
- Modify: `plugins/zcode/commands/codex/adversarial-review.md`
- Modify: `plugins/codex/commands/review.md`
- Modify: `plugins/codex/commands/adversarial-review.md`
- Modify: `README.md`

- [x] **Step 1: Write failing command-contract tests**

Assert both hosts advertise `--cwd <path>`. For ZCode, assert both review templates prohibit raw
Codex execution, shell redirection, and temporary-file fallback after an MCP error.

- [x] **Step 2: Run command tests and verify RED**

Run: `node --test tests/commands.test.mjs tests/zcode-plugin.test.mjs`

Expected: assertions for `--cwd` and fallback constraints fail.

- [x] **Step 3: Update commands and documentation**

Add `--cwd <path>` to argument hints and handling rules. Tell ZCode to return MCP failures verbatim
and never invoke raw Codex or redirect output. Document automatic unique-repository selection and
the explicit override in the README.

- [x] **Step 4: Run command tests and verify GREEN**

Run: `node --test tests/commands.test.mjs tests/zcode-plugin.test.mjs`

Expected: all command-contract tests pass.

### Task 4: Release And Install

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `plugins/codex/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.zcode-plugin/plugin.json`
- Modify: `marketplace.json`
- Modify: `docs/verification/zcode-0.15.2.md`

- [x] **Step 1: Run full verification**

Run: `npm test && npm run build && npm run check-version`

Expected: all supported-platform tests pass, Windows-only tests skip on macOS, build and version
checks succeed.

- [x] **Step 2: Bump the plugin version**

Run: `npm run bump-version -- 1.1.1`

Expected: all package and marketplace manifests change to `1.1.1`.

- [x] **Step 3: Commit and push**

Commit the tested implementation and version change, push `zcode-adapter`, and confirm PR checks
start for the new head.

- [x] **Step 4: Reinstall through ZCode Protocol**

Refresh `openai-codex`, uninstall the current plugin, install `codex` version `1.1.1`, and enable
`codex@openai-codex`.

- [x] **Step 5: Verify the installed package**

Run ZCode plugin and command discovery, compare the installed cache with the tracked source, and
invoke the installed MCP against a temporary parent with one nested Git repository.

- [x] **Step 6: Record evidence**

Append the installed version, source commit, discovery result, nested-repository invocation result,
and full test counts to `docs/verification/zcode-0.15.2.md`.

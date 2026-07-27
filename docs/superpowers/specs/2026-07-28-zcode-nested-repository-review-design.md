# ZCode Nested Repository Review Design

## Problem

ZCode starts the plugin MCP server in `ZCODE_PROJECT_DIR`. When that directory is a workspace
containing a nested Git repository rather than a repository itself, `/codex:review` and
`/codex:adversarial-review` fail before Codex starts. ZCode may then improvise a raw
`codex exec review` call and redirect its output to a temporary file, bypassing the plugin's job,
output, and safety contracts.

The companion runtime already parses `--cwd` and `-C`, but the review command documentation does
not expose those options.

## Behavior

Review repository resolution follows these rules:

1. An explicit `--cwd <path>` or `-C <path>` is resolved relative to the ZCode project directory
   and used exactly. It is never replaced by automatic discovery.
2. If the default project directory is already inside a Git repository, preserve current behavior.
3. If the default ZCode project directory is not a Git repository, search its descendants for Git
   repositories while skipping dependency, VCS, plugin-state, and build-output directories.
4. If exactly one repository is found, review it automatically.
5. If multiple repositories are found, fail with their relative paths and instruct the user to
   rerun with `--cwd <path>`.
6. If none are found, retain the existing "must run inside a Git repository" error.

Automatic discovery is enabled only for ZCode review commands. Claude Code keeps its existing
working-directory behavior, while both hosts document the already-supported explicit `--cwd`
option.

## Command Contract

The ZCode command templates must:

- advertise `--cwd <path>` in `argument-hint`;
- preserve and forward it through `$ARGUMENTS`;
- state that MCP errors must be returned verbatim;
- prohibit fallback to raw `codex`, shell redirection, or temporary output files.

Foreground MCP output remains the normal result channel. Background reviews continue to use the
tracked-job store and `/codex:status` or `/codex:result`.

## Implementation

Add a focused repository resolver to `plugins/codex/scripts/lib/git.mjs`. The review command
handler invokes it before target and workspace resolution. The selected repository path then flows
unchanged through foreground review and ZCode background job requests.

Repository discovery is bounded by ignored directory names and a maximum traversal depth. A `.git`
directory or `.git` file identifies a repository, which supports regular repositories and
worktrees.

## Verification

Automated tests cover:

- an existing repository remaining selected;
- one nested repository being selected;
- multiple repositories producing an actionable error;
- no repository preserving the existing error;
- explicit `--cwd` remaining authoritative;
- ZCode command templates exposing `--cwd` and forbidding raw fallback.

After the full test suite and build pass, bump the package to `1.1.1`, refresh the local
marketplace, reinstall the plugin, and verify ZCode discovers the new command text and runtime.

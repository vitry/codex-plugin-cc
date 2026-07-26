# Package the ZCode plugin from the repository root

The ZCode plugin is an independent product whose installation root is this repository, with ZCode-specific commands and hooks under `plugins/zcode` and the existing Codex companion runtime reused from `plugins/codex/scripts`. This avoids copying a large, stateful runtime while keeping the existing Claude Code plugin package intact; the cost is that the ZCode installation contains repository files that are not runtime components.

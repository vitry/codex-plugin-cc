# Changelog

## 1.1.0

- Add an independent ZCode 0.15.2 plugin surface with eight commands, three shared skills, MCP
  transport, and ZCode lifecycle hooks.
- Preserve the Codex execution engine while adapting host identity, background jobs, setup,
  review, rescue, status, result, cancellation, and stop-gate behavior for ZCode.
- Transfer visible ZCode SQLite session history into resumable native Codex threads.
- Harden shared state and broker lifecycle with cross-process locks, instance identity, session
  leases, bounded shutdown, crash cleanup, and Windows lock coverage.
- Run ZCode rescue directly through the companion MCP instead of unsupported plugin agents.
- Namespace every ZCode slash command as `/codex:*` without unprefixed aliases.

## 1.0.0

- Initial version of the Codex plugin for Claude Code

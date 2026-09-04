# Changelog

## 1.1.2

- Recycle long-lived shared brokers after a codex account switch: sessions record a login
  identity (workspace account id plus id token user id), and a changed login gracefully
  shuts the broker down and rebuilds it so the app-server reads fresh credentials. Token
  refreshes and auth.json rewrites no longer recycle healthy brokers.
- Reuse shared brokers for auth-status lookups only while their login matches, through a
  dedicated freshness-filtered connect option; turn interrupts keep the unfiltered reuse
  path so in-flight turns stay cancellable across a switch.
- Pin the claude host environment in runtime host tests, add an integration test for
  login-switch setup behavior, and verify the suite across ubuntu/macOS with Node 18/20/22
  plus targeted Windows coverage with per-command exit codes.

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

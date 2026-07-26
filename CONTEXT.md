# Codex Companion for ZCode

This context defines the product boundary and shared language for exposing Codex as a companion inside ZCode.

## Language

**ZCode plugin**:
A standalone plugin loaded by ZCode that exposes Codex companion capabilities. ZCode replaces Claude Code as the plugin host; it does not replace Codex as the execution engine.
_Avoid_: ZCode backend, ZCode-powered Codex

**Plugin host**:
The coding agent that loads the plugin and presents its commands and lifecycle. ZCode is the target plugin host; Claude Code is the host used by the existing plugin.
_Avoid_: Model provider, execution engine

**Execution engine**:
The external coding agent that performs delegated tasks for the plugin host. Codex remains the execution engine for the ZCode plugin.
_Avoid_: Plugin host

**Capability parity**:
The ZCode plugin supports the complete user-facing behavior of the existing Claude Code plugin, translated to ZCode's plugin and lifecycle model.
_Avoid_: Core-only port, minimal adapter

**Host adapter**:
The module that translates plugin-host identity, workspace, session, storage, transcript, and lifecycle data into the host-neutral companion runtime.
_Avoid_: ZCode backend, protocol replacement

#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { updateState } from "../../codex/scripts/lib/state.mjs";
import { resolveWorkspaceRoot } from "../../codex/scripts/lib/workspace.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? input.hookEventName ?? "";
  if (eventName !== "SessionStart") {
    return;
  }

  const cwd = firstText(
    input.cwd,
    input.workspacePath,
    input.workspace?.workspacePath,
    process.env.ZCODE_PROJECT_DIR
  );
  const sessionId = firstText(
    input.session_id,
    input.sessionId,
    process.env.ZCODE_SESSION_ID,
    process.env.CLAUDE_SESSION_ID
  );
  if (!cwd || !sessionId) {
    return;
  }

  updateState(resolveWorkspaceRoot(cwd), (state) => {
    const sessions = {
      ...(state.config.zcodeSessions ?? {}),
      [sessionId]: {
        startedAt: new Date().toISOString()
      }
    };
    state.config.zcodeSessions = Object.fromEntries(
      Object.entries(sessions)
        .sort(([, left], [, right]) =>
          String(right.startedAt).localeCompare(String(left.startedAt))
        )
        .slice(0, 50)
    );
  });
}

try {
  main();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHARED_HOOK = path.resolve(
  SCRIPT_DIR,
  "../../codex/scripts/stop-review-gate-hook.mjs"
);
const WRAPPER_TIMEOUT_MS = 930000;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

function main() {
  const input = readHookInput();
  const cwd = firstText(
    input.cwd,
    input.workspacePath,
    input.workspace?.workspacePath,
    process.env.ZCODE_PROJECT_DIR,
    process.cwd()
  );
  const sessionId = firstText(
    input.session_id,
    input.sessionId,
    process.env.ZCODE_SESSION_ID,
    process.env.CLAUDE_SESSION_ID
  );
  const normalized = {
    ...input,
    cwd,
    ...(sessionId ? { session_id: sessionId } : {}),
    last_assistant_message: firstText(
      input.last_assistant_message,
      input.lastAssistantMessage,
      input.response,
      input.responsePreview
    ) ?? ""
  };
  const result = spawnSync(process.execPath, [SHARED_HOOK], {
    cwd,
    env: {
      ...process.env,
      CODEX_COMPANION_HOST: "zcode",
      ZCODE_PROJECT_DIR: cwd,
      ...(sessionId ? { CODEX_COMPANION_SESSION_ID: sessionId } : {})
    },
    input: JSON.stringify(normalized),
    encoding: "utf8",
    timeout: WRAPPER_TIMEOUT_MS
  });

  if (result.error) {
    throw result.error;
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

try {
  main();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

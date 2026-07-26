#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function main() {
  const input = readHookInput();
  if (
    input.hookEventName !== "PreToolUse" ||
    input.toolName !== "mcp__codex__companion" ||
    typeof input.sessionId !== "string" ||
    !input.sessionId.trim() ||
    input.toolInput == null ||
    typeof input.toolInput !== "object" ||
    Array.isArray(input.toolInput)
  ) {
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...input.toolInput,
          sessionId: input.sessionId.trim()
        }
      }
    })}\n`
  );
}

try {
  main();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

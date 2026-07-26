import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { splitRawArgumentString } from "../../../codex/scripts/lib/args.mjs";
import { resolveHost } from "../../../codex/scripts/lib/host.mjs";

export const DEFAULT_COMPANION_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_COMPANION_OUTPUT_BYTES = 8 * 1024 * 1024;

export const COMPANION_COMMANDS = Object.freeze([
  "setup",
  "review",
  "adversarial-review",
  "task",
  "transfer",
  "status",
  "result",
  "task-resume-candidate",
  "cancel"
]);

const ALLOWED_COMMANDS = new Set(COMPANION_COMMANDS);
const DEFAULT_TERMINATION_GRACE_MS = 1000;

function validateInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Companion input must be an object.");
  }
  if (typeof input.command !== "string" || !input.command) {
    throw new Error("Companion command is required.");
  }
  if (!ALLOWED_COMMANDS.has(input.command)) {
    throw new Error(`Unsupported companion command: ${input.command}`);
  }
  if (input.arguments !== undefined && typeof input.arguments !== "string") {
    throw new Error("Companion arguments must be a string.");
  }
  if (input.sessionId !== undefined && typeof input.sessionId !== "string") {
    throw new Error("Companion sessionId must be a string.");
  }
}

export function runCompanion(input, options = {}) {
  validateInput(input);

  const baseEnv = options.env ?? process.env;
  const sessionId = input.sessionId?.trim();
  const env = sessionId
    ? {
        ...baseEnv,
        CODEX_COMPANION_SESSION_ID: sessionId
      }
    : baseEnv;
  const host = resolveHost(env, options.cwd ?? process.cwd());
  if (!host.pluginRoot) {
    throw new Error("Codex companion plugin root is not configured.");
  }

  const scriptPath = path.join(
    host.pluginRoot,
    "plugins",
    "codex",
    "scripts",
    "codex-companion.mjs"
  );
  const args = [
    scriptPath,
    input.command,
    ...splitRawArgumentString(input.arguments ?? "")
  ];
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Companion command cancelled."
    });
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, args, {
    cwd: host.projectDir,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMPANION_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? MAX_COMPANION_OUTPUT_BYTES;
    const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let terminationReason;
    let settled = false;
    let forceKillTimer;

    function cleanup() {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
    }

    function finish(code) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const capturedStderr = Buffer.concat(stderrChunks).toString("utf8");
      const stderr = terminationReason
        ? `${capturedStderr}${capturedStderr && !capturedStderr.endsWith("\n") ? "\n" : ""}${terminationReason}\n`
        : capturedStderr;
      resolve({
        code: terminationReason ? 1 : (code ?? 1),
        stdout,
        stderr
      });
    }

    function terminate(reason) {
      if (settled || terminationReason) {
        return;
      }
      terminationReason = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        finish(1);
        return;
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } finally {
          finish(1);
        }
      }, terminationGraceMs);
      forceKillTimer.unref?.();
    }

    function capture(chunks, chunk) {
      if (terminationReason) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        capturedBytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) {
        terminate(`Companion command output exceeded the ${maxOutputBytes}-byte limit.`);
      }
    }

    function onStdout(chunk) {
      capture(stdoutChunks, chunk);
    }

    function onStderr(chunk) {
      capture(stderrChunks, chunk);
    }

    function onAbort() {
      terminate("Companion command cancelled.");
    }

    function onError(cause) {
      if (!terminationReason) {
        terminationReason = `Failed to run companion command: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
      finish(1);
    }

    function onClose(code) {
      finish(code);
    }

    const timeoutTimer = setTimeout(() => {
      terminate(`Companion command timed out after ${timeoutMs}ms.`);
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

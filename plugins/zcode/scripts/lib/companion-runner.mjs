import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { splitRawArgumentString } from "../../../codex/scripts/lib/args.mjs";
import { resolveHost } from "../../../codex/scripts/lib/host.mjs";

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
}

export function runCompanion(input, options = {}) {
  validateInput(input);

  const env = options.env ?? process.env;
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
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(process.execPath, args, {
    cwd: host.projectDir,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  COMPANION_COMMANDS,
  runCompanion
} from "../plugins/zcode/scripts/lib/companion-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "plugins", "zcode", "scripts", "mcp-server.mjs");
const COMMANDS = [
  "setup",
  "review",
  "adversarial-review",
  "task",
  "transfer",
  "status",
  "result",
  "task-resume-candidate",
  "cancel"
];

function fakeChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  });

  return child;
}

function startServer() {
  const projectDir = makeTempDir("zcode-mcp-project-");
  const pluginData = makeTempDir("zcode-mcp-data-");
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_COMPANION_HOST: "zcode",
      CODEX_COMPANION_PLUGIN_ROOT: ROOT,
      ZCODE_PLUGIN_DATA: pluginData,
      ZCODE_PROJECT_DIR: projectDir
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = [];
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    pending.shift()?.resolve(JSON.parse(line));
  });
  child.on("exit", (code) => {
    while (pending.length) {
      pending.shift().reject(new Error(`MCP server exited ${code}: ${stderr}`));
    }
  });

  return {
    child,
    pluginData,
    projectDir,
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    request(id, method, params = {}) {
      const response = new Promise((resolve, reject) => pending.push({ resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode == null) {
        await once(child, "exit");
      }
      lines.close();
      assert.equal(child.exitCode, 0, stderr);
      assert.equal(stderr, "");
    }
  };
}

test("runner invokes only the allowlisted companion command with parsed arguments", async () => {
  const calls = [];
  const env = {
    CODEX_COMPANION_HOST: "zcode",
    CODEX_COMPANION_PLUGIN_ROOT: "/plugin root",
    ZCODE_PLUGIN_DATA: "/plugin data",
    ZCODE_PROJECT_DIR: "/project"
  };

  const result = await runCompanion(
    {
      command: "task",
      arguments: "--model spark \"review this change\""
    },
    {
      env,
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return fakeChild({ stdout: "queued\n" });
      }
    }
  );

  assert.deepEqual(COMPANION_COMMANDS, COMMANDS);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: [
        path.join("/plugin root", "plugins", "codex", "scripts", "codex-companion.mjs"),
        "task",
        "--model",
        "spark",
        "review this change"
      ],
      options: {
        cwd: "/project",
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    }
  ]);
  assert.deepEqual(result, { code: 0, stdout: "queued\n", stderr: "" });
});

test("runner rejects unknown commands and invalid input without spawning", async () => {
  let spawnCount = 0;
  const options = {
    env: {
      CODEX_COMPANION_PLUGIN_ROOT: ROOT,
      ZCODE_PROJECT_DIR: ROOT
    },
    spawnImpl() {
      spawnCount += 1;
      return fakeChild();
    }
  };

  assert.throws(() => runCompanion({ command: "task-worker" }, options), /Unsupported companion command/);
  assert.throws(() => runCompanion({ command: "task", arguments: ["--write"] }, options), /arguments.*string/);
  assert.throws(() => runCompanion({ arguments: "" }, options), /command.*required/);
  assert.equal(spawnCount, 0);
});

test("runner reports nonzero child exits with captured stderr", async () => {
  const result = await runCompanion(
    { command: "status" },
    {
      env: {
        CODEX_COMPANION_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: ROOT
      },
      spawnImpl() {
        return fakeChild({ code: 7, stderr: "status failed\n" });
      }
    }
  );

  assert.deepEqual(result, { code: 7, stdout: "", stderr: "status failed\n" });
});

test("stdio server initializes, handles notifications and ping, and lists one companion tool", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  assert.deepEqual(await server.request(1, "initialize", { protocolVersion: "2024-11-05" }), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "codex-companion-zcode",
        version: "1.0.0"
      }
    }
  });

  server.notify("notifications/initialized");
  assert.deepEqual(await server.request(2, "ping"), {
    jsonrpc: "2.0",
    id: 2,
    result: {}
  });
  assert.deepEqual(await server.request(3, "tools/list"), {
    jsonrpc: "2.0",
    id: 3,
    result: {
      tools: [
        {
          name: "companion",
          inputSchema: {
            type: "object",
            properties: {
              command: {
                enum: COMMANDS
              },
              arguments: {
                type: "string"
              }
            },
            required: ["command"]
          }
        }
      ]
    }
  });
});

test("stdio tools/call returns companion stdout as MCP text", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const response = await server.request(1, "tools/call", {
    name: "companion",
    arguments: {
      command: "task-resume-candidate",
      arguments: "--json"
    }
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    available: false,
    sessionId: null,
    candidate: null
  });
});

test("stdio tools/call returns useful stderr for nonzero companion exits", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const response = await server.request(1, "tools/call", {
    name: "companion",
    arguments: {
      command: "result",
      arguments: "missing-job --json"
    }
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /job|result|matching|found/i);
});

test("stdio tools/call rejects arbitrary commands and malformed input", async (t) => {
  const server = startServer();
  const marker = path.join(server.projectDir, "must-not-exist");
  t.after(() => server.close());

  const unknown = await server.request(1, "tools/call", {
    name: "companion",
    arguments: {
      command: process.execPath,
      arguments: `-e "require('node:fs').writeFileSync('${marker}', 'bad')"`
    }
  });
  const malformed = await server.request(2, "tools/call", {
    name: "companion",
    arguments: {
      command: "status",
      arguments: ["--json"]
    }
  });

  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.content[0].text, /Unsupported companion command/);
  assert.equal(malformed.result.isError, true);
  assert.match(malformed.result.content[0].text, /arguments.*string/);
  assert.equal(fs.existsSync(marker), false);
});

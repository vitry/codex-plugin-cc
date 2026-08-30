import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import * as companionRunner from "../plugins/zcode/scripts/lib/companion-runner.mjs";
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

function controlledChild({ naturalCloseMs = 100 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  const timer = setTimeout(() => child.emit("close", 0, null), naturalCloseMs);
  timer.unref();
  child.kill = (signal) => {
    child.killSignals.push(signal);
    clearTimeout(timer);
    queueMicrotask(() => {
      child.emit("error", new Error(`killed with ${signal}`));
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

function makeFixturePlugin() {
  const pluginRoot = makeTempDir("zcode-mcp-fixture-");
  const scriptDir = path.join(pluginRoot, "plugins", "codex", "scripts");
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptDir, "codex-companion.mjs"),
    [
      'import fs from "node:fs";',
      'const started = process.argv[3];',
      'const killed = process.argv[4];',
      'if (started) fs.appendFileSync(started, `${process.pid}\\n`);',
      'process.on("SIGTERM", () => {',
      '  if (killed) fs.appendFileSync(killed, `${process.pid}\\n`);',
      '  process.exit(143);',
      '});',
      'setTimeout(() => process.exit(0), 250);'
    ].join("\n"),
    "utf8"
  );
  return pluginRoot;
}

function startServer(options = {}) {
  const projectDir = makeTempDir("zcode-mcp-project-");
  const pluginData = makeTempDir("zcode-mcp-data-");
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_COMPANION_HOST: "zcode",
      CODEX_COMPANION_PLUGIN_ROOT: options.pluginRoot ?? ROOT,
      ZCODE_PLUGIN_DATA: pluginData,
      ZCODE_PROJECT_DIR: projectDir,
      ...options.env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const messages = [];
  const unsolicited = [];
  const messageWaiters = [];
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    while (messageWaiters.length) {
      messageWaiters.shift()(message);
    }
    if (Object.hasOwn(message, "id") && pending.has(message.id)) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    } else {
      unsolicited.push(message);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`MCP server exited ${code}: ${stderr}`));
    }
    pending.clear();
  });

  async function waitForExit() {
    if (child.exitCode == null) {
      await once(child, "exit");
    }
    lines.close();
    assert.equal(child.exitCode, 0, stderr);
    assert.equal(stderr, "");
  }

  return {
    child,
    messages,
    pluginData,
    projectDir,
    unsolicited,
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    request(id, method, params = {}) {
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    sendRaw(value) {
      child.stdin.write(value);
    },
    waitForMessage(timeoutMs = 150) {
      return Promise.race([
        new Promise((resolve) => messageWaiters.push(resolve)),
        delay(timeoutMs).then(() => {
          throw new Error(`No server message within ${timeoutMs}ms`);
        })
      ]);
    },
    async endInput() {
      child.stdin.end();
      await waitForExit();
    },
    async close() {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      await waitForExit();
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

test("runner isolates session identity across concurrent companion calls", async () => {
  const env = {
    CODEX_COMPANION_HOST: "zcode",
    CODEX_COMPANION_PLUGIN_ROOT: "/plugin",
    ZCODE_PROJECT_DIR: "/project"
  };
  const seen = [];
  const spawnImpl = (command, args, options) => {
    seen.push(options.env.CODEX_COMPANION_SESSION_ID);
    return fakeChild({ stdout: "ok\n" });
  };

  await Promise.all([
    runCompanion(
      { command: "status", arguments: "--json", sessionId: "sess-one" },
      { env, spawnImpl }
    ),
    runCompanion(
      { command: "status", arguments: "--json", sessionId: "sess-two" },
      { env, spawnImpl }
    )
  ]);

  assert.deepEqual(seen.sort(), ["sess-one", "sess-two"]);
  assert.equal(env.CODEX_COMPANION_SESSION_ID, undefined);
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

test("runner aborts the child and settles once across error and close races", async () => {
  const controller = new AbortController();
  const child = controlledChild();
  const resultPromise = runCompanion(
    { command: "status" },
    {
      env: {
        CODEX_COMPANION_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: ROOT
      },
      signal: controller.signal,
      spawnImpl() {
        return child;
      }
    }
  );

  controller.abort();
  const result = await resultPromise;

  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cancelled/i);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("runner cleans up when child termination throws", async () => {
  const controller = new AbortController();
  const child = controlledChild();
  child.kill = () => {
    throw new Error("kill unavailable");
  };
  const resultPromise = runCompanion(
    { command: "status" },
    {
      env: {
        CODEX_COMPANION_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: ROOT
      },
      signal: controller.signal,
      spawnImpl() {
        return child;
      }
    }
  );

  controller.abort();
  const result = await resultPromise;

  assert.equal(result.code, 1);
  assert.match(result.stderr, /cancelled/i);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("runner enforces its timeout and cleans up the child", async () => {
  const child = controlledChild();
  const result = await runCompanion(
    { command: "status" },
    {
      env: {
        CODEX_COMPANION_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: ROOT
      },
      timeoutMs: 5,
      spawnImpl() {
        return child;
      }
    }
  );

  assert.equal(companionRunner.DEFAULT_COMPANION_TIMEOUT_MS, 15 * 60 * 1000);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out/i);
});

test("runner terminates when combined output exceeds the fixed capture limit", async () => {
  const child = controlledChild();
  const resultPromise = runCompanion(
    { command: "status" },
    {
      env: {
        CODEX_COMPANION_PLUGIN_ROOT: ROOT,
        ZCODE_PROJECT_DIR: ROOT
      },
      maxOutputBytes: 16,
      spawnImpl() {
        return child;
      }
    }
  );

  child.stdout.write("1234567890");
  child.stderr.write("abcdefghij");
  const result = await resultPromise;

  assert.equal(companionRunner.MAX_COMPANION_OUTPUT_BYTES, 8 * 1024 * 1024);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /output.*limit/i);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) < 256);
});

test("stdio server initializes, handles notifications and ping, and lists one companion tool", async (t) => {
  const server = startServer();
  t.after(() => server.close());
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".zcode-plugin", "plugin.json"), "utf8"));

  assert.deepEqual(await server.request(1, "initialize", { protocolVersion: "2099-01-01" }), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: "codex-companion-zcode",
        version: manifest.version
      }
    }
  });

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
              },
              sessionId: {
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

test("stdio notifications never produce responses", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  server.notify("notifications/initialized");
  server.notify("notifications/cancelled", { requestId: "missing" });
  server.notify("notifications/future-event", { value: true });
  await server.request(1, "ping");

  assert.deepEqual(server.unsolicited, []);
});

test("stdio tools/call returns companion stdout as MCP text", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const response = await server.request(1, "tools/call", {
    name: "companion",
    arguments: {
      command: "task-resume-candidate",
      arguments: "--json",
      sessionId: "sess-mcp-call"
    }
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(response.result.content[0].text), {
    available: false,
    sessionId: "sess-mcp-call",
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

test("stdio tools/call rejects unknown tools with Invalid params", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const response = await server.request(1, "tools/call", {
    name: "arbitrary",
    arguments: {
      command: "status"
    }
  });

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32602,
      message: "Invalid params: unknown tool arbitrary"
    }
  });
});

test("stdio cancellation aborts the matching call and emits only its tool response", async (t) => {
  const pluginRoot = makeFixturePlugin();
  const started = path.join(pluginRoot, "started");
  const killed = path.join(pluginRoot, "killed");
  const server = startServer({ pluginRoot });
  t.after(() => server.close());

  const call = server.request("call-1", "tools/call", {
    name: "companion",
    arguments: {
      command: "status",
      arguments: `"${started}" "${killed}"`
    }
  });
  while (!fs.existsSync(started)) {
    await delay(5);
  }
  server.notify("notifications/cancelled", { requestId: "call-1" });
  const response = await call;
  await server.request("ping-after-cancel", "ping");

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/i);
  assert.equal(fs.existsSync(killed), true);
  assert.deepEqual(server.unsolicited, []);
  assert.equal(server.messages.filter((message) => message.id === "call-1").length, 1);
});

test("stdio EOF aborts every active companion call", async () => {
  const pluginRoot = makeFixturePlugin();
  const started = path.join(pluginRoot, "started");
  const killed = path.join(pluginRoot, "killed");
  const server = startServer({ pluginRoot });

  server.request(1, "tools/call", {
    name: "companion",
    arguments: {
      command: "status",
      arguments: `"${started}" "${killed}"`
    }
  }).catch(() => {});
  while (!fs.existsSync(started)) {
    await delay(5);
  }
  await server.endInput();

  assert.equal(fs.existsSync(killed), true);
  const response = server.messages.find((message) => message.id === 1);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled|shutdown/i);
});

test("stdio server caps concurrent companion calls without spawning an extra child", async (t) => {
  const pluginRoot = makeFixturePlugin();
  const started = path.join(pluginRoot, "started");
  const killed = path.join(pluginRoot, "killed");
  const server = startServer({ pluginRoot });
  t.after(() => server.close());

  const calls = Array.from({ length: 4 }, (_, index) =>
    server.request(index + 1, "tools/call", {
      name: "companion",
      arguments: {
        command: "status",
        arguments: `"${started}" "${killed}"`
      }
    })
  );
  while (!fs.existsSync(started) || fs.readFileSync(started, "utf8").trim().split("\n").length < 4) {
    await delay(5);
  }
  const overflow = await server.request(5, "tools/call", {
    name: "companion",
    arguments: {
      command: "status",
      arguments: `"${started}" "${killed}"`
    }
  });

  assert.equal(overflow.result.isError, true);
  assert.match(overflow.result.content[0].text, /too many|concurrent|limit/i);
  assert.equal(fs.readFileSync(started, "utf8").trim().split("\n").length, 4);

  for (let index = 1; index <= 4; index += 1) {
    server.notify("notifications/cancelled", { requestId: index });
  }
  const responses = await Promise.all(calls);
  assert.ok(responses.every((response) => response.result.isError === true));
});

test("stdio server rejects a duplicate active request id without spawning another child", async (t) => {
  const pluginRoot = makeFixturePlugin();
  const started = path.join(pluginRoot, "started");
  const killed = path.join(pluginRoot, "killed");
  const server = startServer({ pluginRoot });
  t.after(() => server.close());

  const call = {
    jsonrpc: "2.0",
    id: "duplicate",
    method: "tools/call",
    params: {
      name: "companion",
      arguments: {
        command: "status",
        arguments: `"${started}" "${killed}"`
      }
    }
  };
  server.sendRaw(`${JSON.stringify(call)}\n`);
  while (!fs.existsSync(started)) {
    await delay(5);
  }

  const duplicateResponse = server.waitForMessage();
  server.sendRaw(`${JSON.stringify(call)}\n`);

  assert.deepEqual(await duplicateResponse, {
    jsonrpc: "2.0",
    id: "duplicate",
    error: {
      code: -32600,
      message: "Invalid Request: duplicate active request id"
    }
  });
  assert.equal(fs.readFileSync(started, "utf8").trim().split("\n").length, 1);

  const originalResponse = server.waitForMessage();
  server.notify("notifications/cancelled", { requestId: "duplicate" });
  const firstResponse = await originalResponse;
  assert.equal(firstResponse.result.isError, true);
  assert.match(firstResponse.result.content[0].text, /cancelled/i);
});

test("stdio server rejects an oversized unterminated NDJSON line before EOF", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const messagePromise = server.waitForMessage();
  server.sendRaw(Buffer.alloc(1024 * 1024 + 1, 0x20));
  const response = await messagePromise;

  assert.deepEqual(response, {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32700,
      message: "Parse error"
    }
  });
  assert.equal(server.messages.length, 1);
});

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import * as brokerLifecycle from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint,
  waitForBrokerExit
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

function fakeBrokerOptions(overrides = {}) {
  let nextPid = 7000;
  return {
    timeoutMs: 25,
    scriptPath: "/definitely/missing/app-server-broker.mjs",
    createBrokerEndpoint(sessionDir) {
      return `unix:${path.join(sessionDir, "broker.sock")}`;
    },
    spawnBrokerProcess() {
      nextPid += 1;
      return { pid: nextPid };
    },
    waitForBrokerEndpoint: async () => true,
    ...overrides
  };
}

function runProcess(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
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
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`process exited ${code}: ${stderr}`));
      }
    });
  });
}

function writeMinimalBroker(root) {
  const scriptPath = path.join(root, "minimal-broker.mjs");
  const countFile = path.join(root, "spawn-count.log");
  const source = `
import fs from "node:fs";
import net from "node:net";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((entries, value, index, values) => {
    if (value.startsWith("--")) entries.push([value.slice(2), values[index + 1]]);
    return entries;
  }, [])
);
const endpoint = args.endpoint.replace(/^unix:/, "");
const instanceId = args["instance-id"];
fs.appendFileSync(${JSON.stringify(countFile)}, "spawn\\n");
fs.writeFileSync(args["pid-file"], JSON.stringify({ pid: process.pid, instanceId }) + "\\n");
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\\n");
    if (newline === -1) return;
    const message = JSON.parse(buffer.slice(0, newline));
    if (message.method === "broker/status") {
      socket.write(JSON.stringify({ id: message.id, result: { instanceId, protocolVersion: 1 } }) + "\\n");
    } else if (message.method === "broker/shutdown") {
      socket.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
      server.close(() => process.exit(0));
    }
  });
});
server.listen(endpoint);
`;
  fs.writeFileSync(scriptPath, source, { encoding: "utf8", mode: 0o700 });
  return { scriptPath, countFile };
}

test("concurrent ensure calls create exactly one broker session", async () => {
  const cwd = makeTempDir();
  let spawnCount = 0;
  const options = fakeBrokerOptions({
    spawnBrokerProcess(args) {
      spawnCount += 1;
      return { pid: 7100, args };
    }
  });

  const sessions = await Promise.all(
    Array.from({ length: 8 }, () => ensureBrokerSession(cwd, options))
  );

  assert.equal(spawnCount, 1);
  assert.equal(sessions.every((session) => session?.endpoint === sessions[0]?.endpoint), true);
  assert.deepEqual(loadBrokerSession(cwd), sessions[0]);

  clearBrokerSession(cwd, sessions[0].instanceId);
  teardownBrokerSession(sessions[0]);
});

test("replaces stale broker state without killing its unverified pid", async () => {
  const cwd = makeTempDir();
  const staleSessionDir = makeTempDir();
  const stale = {
    status: "ready",
    instanceId: "stale-instance",
    endpoint: `unix:${path.join(staleSessionDir, "missing.sock")}`,
    pidFile: path.join(staleSessionDir, "broker.pid"),
    logFile: path.join(staleSessionDir, "broker.log"),
    sessionDir: staleSessionDir,
    pid: 4242
  };
  fs.writeFileSync(
    stale.pidFile,
    `${JSON.stringify({ pid: 4242, instanceId: stale.instanceId })}\n`,
    "utf8"
  );
  fs.writeFileSync(stale.logFile, "stale\n", "utf8");
  saveBrokerSession(cwd, stale);
  let killCount = 0;
  let probeCount = 0;
  const options = fakeBrokerOptions({
    waitForBrokerEndpoint: async (endpoint) => {
      probeCount += 1;
      return endpoint !== stale.endpoint;
    },
    killProcess() {
      killCount += 1;
    }
  });

  const replacement = await ensureBrokerSession(cwd, options);

  assert.equal(probeCount >= 2, true);
  assert.equal(killCount, 0);
  assert.notEqual(replacement.endpoint, stale.endpoint);
  assert.deepEqual(loadBrokerSession(cwd), replacement);

  clearBrokerSession(cwd, replacement.instanceId);
  teardownBrokerSession(replacement);
});

test("does not reuse legacy broker state without an instance identity", async () => {
  const cwd = makeTempDir();
  const legacyDir = makeTempDir();
  saveBrokerSession(cwd, {
    status: "ready",
    instanceId: null,
    endpoint: `unix:${path.join(legacyDir, "foreign.sock")}`,
    sessionDir: legacyDir,
    pidFile: path.join(legacyDir, "broker.pid"),
    logFile: path.join(legacyDir, "broker.log"),
    leases: []
  });
  let spawnCount = 0;

  const replacement = await ensureBrokerSession(
    cwd,
    fakeBrokerOptions({
      spawnBrokerProcess() {
        spawnCount += 1;
        return { pid: 7040 };
      },
      waitForBrokerEndpoint: async () => true
    })
  );

  assert.equal(spawnCount, 1);
  assert.equal(typeof replacement.instanceId, "string");
  assert.notEqual(replacement.instanceId, "");

  clearBrokerSession(cwd, replacement.instanceId);
  teardownBrokerSession(replacement);
});

test("startup timeout terminates only the child spawned by that call", async () => {
  const cwd = makeTempDir();
  let childKillCount = 0;
  const session = await ensureBrokerSession(
    cwd,
    fakeBrokerOptions({
      spawnBrokerProcess() {
        return {
          pid: 7050,
          kill() {
            childKillCount += 1;
          }
        };
      },
      waitForBrokerEndpoint: async () => false
    })
  );

  assert.equal(session, null);
  assert.equal(childKillCount, 1);
  assert.equal(loadBrokerSession(cwd), null);
});

test("startup timeout escalates termination for a child that ignores SIGTERM", async (t) => {
  const cwd = makeTempDir();
  const childScript = path.join(cwd, "stubborn-child.mjs");
  fs.writeFileSync(
    childScript,
    `import net from "node:net";
process.on("SIGTERM", () => {});
net.createServer().listen(process.argv[2]);
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  let child = null;
  let spawned = null;
  t.after(() => {
    if (!child || child.signalCode !== null || child.exitCode !== null) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The implementation already terminated the child.
      }
    }
  });

  const session = await ensureBrokerSession(
    cwd,
    fakeBrokerOptions({
      timeoutMs: 25,
      spawnBrokerProcess(args) {
        spawned = args;
        const socketPath = args.endpoint.replace(/^unix:/, "");
        child = spawn(process.execPath, [childScript, socketPath], {
          detached: true,
          stdio: "ignore"
        });
        return child;
      },
      waitForBrokerEndpoint: async (endpoint) => {
        const socketPath = endpoint.replace(/^unix:/, "");
        const deadline = Date.now() + 500;
        while (!fs.existsSync(socketPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      }
    })
  );

  assert.equal(session, null);
  assert.ok(child);
  assert.ok(spawned);
  assert.notEqual(child.signalCode, null);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  assert.equal(fs.existsSync(spawned.endpoint.replace(/^unix:/, "")), false);
  assert.equal(fs.existsSync(path.dirname(spawned.pidFile)), false);
});

test("teardown preserves artifacts owned by another broker instance", () => {
  const sessionDir = makeTempDir();
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const socketPath = path.join(sessionDir, "broker.sock");
  fs.writeFileSync(
    pidFile,
    `${JSON.stringify({ pid: 7001, instanceId: "replacement" })}\n`,
    "utf8"
  );
  fs.writeFileSync(logFile, "replacement log\n", "utf8");
  fs.writeFileSync(socketPath, "replacement socket\n", "utf8");

  teardownBrokerSession({
    endpoint: `unix:${socketPath}`,
    pidFile,
    logFile,
    sessionDir,
    instanceId: "original"
  });

  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(logFile), true);
  assert.equal(fs.existsSync(socketPath), true);
});

test("keeps a shared broker until its final session lease ends", async () => {
  const cwd = makeTempDir();
  const options = fakeBrokerOptions();
  const first = await ensureBrokerSession(cwd, {
    ...options,
    env: { CODEX_COMPANION_SESSION_ID: "session-one" }
  });
  const second = await ensureBrokerSession(cwd, {
    ...options,
    env: { CODEX_COMPANION_SESSION_ID: "session-two" }
  });
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(typeof brokerLifecycle.releaseBrokerLease, "function");

  const firstRelease = await brokerLifecycle.releaseBrokerLease(cwd, "session-one");
  assert.equal(firstRelease.shouldShutdown, false);
  assert.deepEqual(
    loadBrokerSession(cwd).leases.map((lease) => lease.sessionId),
    ["session-two"]
  );

  const finalRelease = await brokerLifecycle.releaseBrokerLease(cwd, "session-two");
  assert.equal(finalRelease.shouldShutdown, true);
  assert.equal(finalRelease.session.instanceId, first.instanceId);

  clearBrokerSession(cwd, first.instanceId);
  teardownBrokerSession(first);
});

test("a new lease does not reuse an instance whose final lease is stopping", async () => {
  const cwd = makeTempDir();
  let nextPid = 7400;
  const options = fakeBrokerOptions({
    spawnBrokerProcess() {
      nextPid += 1;
      return { pid: nextPid };
    }
  });
  const first = await ensureBrokerSession(cwd, {
    ...options,
    env: { CODEX_COMPANION_SESSION_ID: "session-one" }
  });
  const released = await brokerLifecycle.releaseBrokerLease(cwd, "session-one");
  assert.equal(released.shouldShutdown, true);
  assert.equal(loadBrokerSession(cwd).status, "stopping");

  const replacement = await ensureBrokerSession(cwd, {
    ...options,
    env: { CODEX_COMPANION_SESSION_ID: "session-two" }
  });
  assert.notEqual(replacement.instanceId, first.instanceId);
  assert.equal(typeof brokerLifecycle.finalizeBrokerSession, "function");
  assert.equal(
    await brokerLifecycle.finalizeBrokerSession(cwd, first.instanceId),
    false
  );
  assert.equal(loadBrokerSession(cwd).instanceId, replacement.instanceId);

  clearBrokerSession(cwd, replacement.instanceId);
  teardownBrokerSession(released.session);
  teardownBrokerSession(replacement);
});

test("an old instance cannot clear newly published broker state", () => {
  const cwd = makeTempDir();
  saveBrokerSession(cwd, { instanceId: "new-instance", endpoint: "unix:/tmp/new.sock" });

  assert.equal(clearBrokerSession(cwd, "old-instance"), false);
  assert.equal(loadBrokerSession(cwd).instanceId, "new-instance");
  assert.equal(clearBrokerSession(cwd, "new-instance"), true);
  assert.equal(loadBrokerSession(cwd), null);
});

test("anonymous callers cannot clear broker state", () => {
  const cwd = makeTempDir();
  saveBrokerSession(cwd, {
    instanceId: "owned-instance",
    endpoint: "unix:/tmp/owned.sock"
  });

  assert.equal(clearBrokerSession(cwd), false);
  assert.equal(loadBrokerSession(cwd).instanceId, "owned-instance");
  assert.equal(clearBrokerSession(cwd, "owned-instance"), true);
});

test("anonymous callers cannot wait for a broker instance to exit", async () => {
  assert.equal(
    await waitForBrokerExit(
      `unix:${path.join(makeTempDir(), "missing.sock")}`,
      10
    ),
    false
  );
});

test("shutdown returns within its timeout when an endpoint stays silent", async () => {
  const root = makeTempDir();
  const socketPath = path.join(root, "silent.sock");
  const server = net.createServer((socket) => {
    setTimeout(() => socket.destroy(), 150);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const startedAt = Date.now();

  const acknowledged = await sendBrokerShutdown(
    `unix:${socketPath}`,
    30,
    "silent-instance"
  );

  assert.equal(acknowledged, false);
  assert.equal(Date.now() - startedAt < 100, true);
  await new Promise((resolve) => server.close(resolve));
});

test("exit wait does not treat a silent listening endpoint as exited", async () => {
  const root = makeTempDir();
  const socketPath = path.join(root, "silent-exit.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  assert.equal(
    await waitForBrokerExit(`unix:${socketPath}`, 50, "expected-instance"),
    false
  );

  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
});

test("readiness rejects a socket served by a different broker instance", async () => {
  const root = makeTempDir();
  const socketPath = path.join(root, "identity.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(chunk.trim());
      socket.write(
        `${JSON.stringify({
          id: message.id,
          result: { instanceId: "different-instance", protocolVersion: 1 }
        })}\n`
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  assert.equal(
    await waitForBrokerEndpoint(`unix:${socketPath}`, 100, "expected-instance"),
    false
  );

  await new Promise((resolve) => server.close(resolve));
});

test("exit wait rejects an endpoint replaced by a different broker instance", async () => {
  const root = makeTempDir();
  const socketPath = path.join(root, "replacement.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(chunk.trim());
      socket.write(
        `${JSON.stringify({
          id: message.id,
          result: { instanceId: "replacement", protocolVersion: 1 }
        })}\n`
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  assert.equal(
    await waitForBrokerExit(`unix:${socketPath}`, 100, "original"),
    false
  );

  await new Promise((resolve) => server.close(resolve));
});

test("publishes starting state before spawning a broker", async () => {
  const cwd = makeTempDir();
  let observed = null;
  const session = await ensureBrokerSession(
    cwd,
    fakeBrokerOptions({
      spawnBrokerProcess() {
        observed = loadBrokerSession(cwd);
        return { pid: 7200 };
      }
    })
  );

  assert.equal(observed.status, "starting");
  assert.equal(observed.instanceId, session.instanceId);
  assert.equal(session.status, "ready");

  clearBrokerSession(cwd, session.instanceId);
  teardownBrokerSession(session);
});

test("recovers a ready broker left in starting state without spawning another", async () => {
  const cwd = makeTempDir();
  const sessionDir = makeTempDir();
  const starting = {
    status: "starting",
    instanceId: "recoverable-instance",
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: 7300,
    leases: []
  };
  saveBrokerSession(cwd, starting);
  let spawnCount = 0;
  let probedInstanceId = null;
  let probeTimeoutMs = null;

  const recovered = await ensureBrokerSession(
    cwd,
    fakeBrokerOptions({
      timeoutMs: 600,
      waitForBrokerEndpoint: async (_endpoint, timeoutMs, instanceId) => {
        probeTimeoutMs = timeoutMs;
        probedInstanceId = instanceId;
        return true;
      },
      spawnBrokerProcess() {
        spawnCount += 1;
        return { pid: 7301 };
      }
    })
  );

  assert.equal(probedInstanceId, "recoverable-instance");
  assert.equal(probeTimeoutMs, 600);
  assert.equal(spawnCount, 0);
  assert.equal(recovered.status, "ready");

  clearBrokerSession(cwd, recovered.instanceId);
  teardownBrokerSession(recovered);
});

test("separate processes converge on one broker instance", async (t) => {
  const cwd = makeTempDir();
  const fixtureRoot = makeTempDir();
  const fixture = writeMinimalBroker(fixtureRoot);
  const zcodeData = makeTempDir();
  const claudeData = makeTempDir();
  const tempDirs = [makeTempDir(), makeTempDir()];
  const brokerModule = new URL(
    "../plugins/codex/scripts/lib/broker-lifecycle.mjs",
    import.meta.url
  ).href;
  const source = [
    `import { ensureBrokerSession } from ${JSON.stringify(brokerModule)};`,
    "const session = await ensureBrokerSession(process.argv[1], {",
    "  scriptPath: process.argv[2],",
    "  timeoutMs: 2000",
    "});",
    "process.stdout.write(JSON.stringify(session));"
  ].join("\n");

  t.after(async () => {
    const session = loadBrokerSession(cwd);
    if (!session) {
      return;
    }
    await sendBrokerShutdown(session.endpoint, 1000, session.instanceId);
    clearBrokerSession(cwd, session.instanceId);
    teardownBrokerSession(session);
  });

  const outputs = await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const env = { ...process.env };
      if (index % 2 === 0) {
        env.ZCODE_PLUGIN_DATA = zcodeData;
        delete env.CLAUDE_PLUGIN_DATA;
      } else {
        env.CLAUDE_PLUGIN_DATA = claudeData;
        delete env.ZCODE_PLUGIN_DATA;
      }
      env.TMPDIR = tempDirs[index % tempDirs.length];
      env.TMP = tempDirs[index % tempDirs.length];
      env.TEMP = tempDirs[index % tempDirs.length];
      return runProcess(
        ["--input-type=module", "-e", source, cwd, fixture.scriptPath],
        { env }
      );
    })
  );
  const sessions = outputs.map((output) => JSON.parse(output));

  assert.equal(fs.readFileSync(fixture.countFile, "utf8").trim().split("\n").length, 1);
  assert.equal(new Set(sessions.map((session) => session.instanceId)).size, 1);
  assert.equal(new Set(sessions.map((session) => session.endpoint)).size, 1);
});

test("broker startup failure removes pid and socket artifacts", () => {
  const root = makeTempDir();
  const binDir = path.join(root, "bin");
  const pidFile = path.join(root, "broker.pid");
  const socketPath = path.join(root, "broker.sock");
  const brokerScript = fileURLToPath(
    new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
  );
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\nexit 1\n", {
    encoding: "utf8",
    mode: 0o700
  });

  const result = run(
    process.execPath,
    [
      brokerScript,
      "serve",
      "--endpoint",
      `unix:${socketPath}`,
      "--cwd",
      root,
      "--pid-file",
      pidFile,
      "--instance-id",
      "failing-instance"
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    }
  );

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(socketPath), false);
});

test("broker exits and cleans artifacts when its backing app-server crashes", async () => {
  const root = makeTempDir();
  const binDir = path.join(root, "bin");
  const pidFile = path.join(root, "broker.pid");
  const socketPath = path.join(root, "broker.sock");
  const instanceId = "crashing-backend-instance";
  const brokerScript = fileURLToPath(
    new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
  );
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    setTimeout(() => process.exit(9), 1000);
  }
});
`,
    { encoding: "utf8", mode: 0o700 }
  );
  const child = spawn(
    process.execPath,
    [
      brokerScript,
      "serve",
      "--endpoint",
      `unix:${socketPath}`,
      "--cwd",
      root,
      "--pid-file",
      pidFile,
      "--instance-id",
      instanceId
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const exit = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(
    await waitForBrokerEndpoint(`unix:${socketPath}`, 5000, instanceId),
    true
  );
  const exitCode = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000))
  ]);
  if (exitCode === "timeout") {
    child.kill("SIGTERM");
    await exit;
  }

  assert.notEqual(exitCode, "timeout");
  assert.notEqual(exitCode, 0);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(socketPath), false);
});

test("broker exits after its bounded idle timeout", async () => {
  const root = makeTempDir();
  const binDir = path.join(root, "bin");
  const pidFile = path.join(root, "broker.pid");
  const socketPath = path.join(root, "broker.sock");
  const instanceId = "idle-timeout-instance";
  const brokerScript = fileURLToPath(
    new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
  );
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`,
    { encoding: "utf8", mode: 0o700 }
  );
  const child = spawn(
    process.execPath,
    [
      brokerScript,
      "serve",
      "--endpoint",
      `unix:${socketPath}`,
      "--cwd",
      root,
      "--pid-file",
      pidFile,
      "--instance-id",
      instanceId
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "500"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const exit = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(
    await waitForBrokerEndpoint(`unix:${socketPath}`, 5000, instanceId),
    true
  );
  const exitCode = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000))
  ]);
  if (exitCode === "timeout") {
    child.kill("SIGTERM");
    await exit;
  }

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(socketPath), false);
});

test("broker shutdown completes when its backing app-server ignores SIGTERM", async () => {
  const root = makeTempDir();
  const binDir = path.join(root, "bin");
  const pidFile = path.join(root, "broker.pid");
  const backendPidFile = path.join(root, "backend.pid");
  const socketPath = path.join(root, "bounded-shutdown.sock");
  const instanceId = "bounded-shutdown-instance";
  const brokerScript = fileURLToPath(
    new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
  );
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(backendPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`,
    { encoding: "utf8", mode: 0o700 }
  );

  const child = spawn(
    process.execPath,
    [
      brokerScript,
      "serve",
      "--endpoint",
      `unix:${socketPath}`,
      "--cwd",
      root,
      "--pid-file",
      pidFile,
      "--instance-id",
      instanceId
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS: "200"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const exit = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  assert.equal(
    await waitForBrokerEndpoint(`unix:${socketPath}`, 1000, instanceId),
    true
  );
  assert.equal(
    await sendBrokerShutdown(`unix:${socketPath}`, 100, null),
    false
  );
  assert.equal(
    await waitForBrokerEndpoint(`unix:${socketPath}`, 200, instanceId),
    true
  );
  assert.equal(
    await sendBrokerShutdown(`unix:${socketPath}`, 200, instanceId),
    true
  );
  const exitCode = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000))
  ]);
  if (exitCode === "timeout") {
    child.kill("SIGKILL");
    await exit;
    const backendPid = Number.parseInt(fs.readFileSync(backendPidFile, "utf8"), 10);
    try {
      process.kill(backendPid, "SIGKILL");
    } catch {
      // The implementation may already have force-terminated the backend.
    }
  }

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(socketPath), false);
});

test("bind failure cleans its pid without deleting another server socket", async () => {
  const root = makeTempDir();
  const binDir = path.join(root, "bin");
  const pidFile = path.join(root, "broker.pid");
  const socketPath = path.join(root, "occupied.sock");
  const brokerScript = fileURLToPath(
    new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url)
  );
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "codex"),
    `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  }
});
`,
    { encoding: "utf8", mode: 0o700 }
  );
  const occupyingServer = net.createServer();
  await new Promise((resolve) => occupyingServer.listen(socketPath, resolve));

  const child = spawn(
    process.execPath,
    [
      brokerScript,
      "serve",
      "--endpoint",
      `unix:${socketPath}`,
      "--cwd",
      root,
      "--pid-file",
      pidFile,
      "--instance-id",
      "bind-failure-instance"
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  assert.notEqual(exitCode, 0);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(socketPath), true);

  await new Promise((resolve) => occupyingServer.close(resolve));
});

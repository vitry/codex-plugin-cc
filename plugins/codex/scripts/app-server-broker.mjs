#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1000;
let cleanupFailureArtifacts = () => {};
process.once("exit", () => cleanupFailureArtifacts());

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile, instanceId) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(
    pidFile,
    `${JSON.stringify({ pid: process.pid, instanceId })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function removeOwnedPidFile(pidFile, instanceId) {
  if (!pidFile || !fs.existsSync(pidFile)) {
    return;
  }
  const quarantineFile = `${pidFile}.release-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(pidFile, quarantineFile);
    const owner = JSON.parse(fs.readFileSync(quarantineFile, "utf8"));
    if (owner?.instanceId === instanceId) {
      fs.unlinkSync(quarantineFile);
      return;
    }
  } catch {
    // A missing, malformed, or replaced PID file is not ours to remove.
  }
  if (fs.existsSync(quarantineFile)) {
    try {
      fs.renameSync(quarantineFile, pidFile);
    } catch {
      // Preserve an unexpected file in quarantine if its path was replaced.
    }
  }
}

async function settleWithin(promise, timeoutMs) {
  await Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    })
  ]);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint", "instance-id"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const instanceId = String(options["instance-id"] ?? "");
  if (!instanceId) {
    throw new Error("Missing required --instance-id.");
  }
  cleanupFailureArtifacts = () => {
    removeOwnedPidFile(pidFile, instanceId);
  };
  writePidFile(pidFile, instanceId);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let shuttingDown = false;
  let idleTimer = null;
  const configuredIdleTimeout = Number.parseInt(
    process.env.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS ?? "",
    10
  );
  const idleTimeoutMs =
    Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0
      ? configuredIdleTimeout
      : DEFAULT_IDLE_TIMEOUT_MS;
  const configuredShutdownTimeout = Number.parseInt(
    process.env.CODEX_COMPANION_BROKER_SHUTDOWN_TIMEOUT_MS ?? "",
    10
  );
  const shutdownTimeoutMs =
    Number.isFinite(configuredShutdownTimeout) && configuredShutdownTimeout > 0
      ? configuredShutdownTimeout
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    for (const socket of sockets) {
      socket.end();
    }
    await settleWithin(
      appClient.close({ timeoutMs: Math.max(100, shutdownTimeoutMs - 100) }),
      shutdownTimeoutMs
    );
    await settleWithin(
      new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
      }),
      shutdownTimeoutMs
    );
    for (const socket of sockets) {
      socket.destroy();
    }
    removeOwnedPidFile(pidFile, instanceId);
  }

  function scheduleIdleShutdown(server) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || sockets.size > 0) {
      return;
    }
    idleTimer = setTimeout(async () => {
      await shutdown(server);
      process.exit(0);
    }, idleTimeoutMs);
    idleTimer.unref();
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker",
              brokerInstanceId: instanceId
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/status") {
          send(socket, {
            id: message.id,
            result: {
              instanceId,
              protocolVersion: 1,
              pid: process.pid,
              cwd
            }
          });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          if (
            !message.params?.instanceId ||
            message.params.instanceId !== instanceId
          ) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(-32002, "Broker instance mismatch.")
            });
            continue;
          }
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleIdleShutdown(server);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      scheduleIdleShutdown(server);
    });
  });

  server.on("error", async (error) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await settleWithin(
      appClient.close({ timeoutMs: Math.max(100, shutdownTimeoutMs - 100) }),
      shutdownTimeoutMs
    );
    cleanupFailureArtifacts();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

  void appClient.exitPromise.then(async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await settleWithin(
        new Promise((resolve) => server.close(resolve)),
        shutdownTimeoutMs
      );
    }
    cleanupFailureArtifacts();
    process.exit(1);
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path, () => {
    scheduleIdleShutdown(server);
  });
}

main().catch((error) => {
  cleanupFailureArtifacts();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("direct app-server mode bypasses the persistent broker", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  let client;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: {
        ...buildEnv(binDir),
        CODEX_COMPANION_APP_SERVER_MODE: "direct"
      }
    });

    assert.equal(client.transport, "direct");
  } finally {
    await client?.close().catch(() => {});
    const broker = loadBrokerSession(cwd);
    if (broker) {
      await sendBrokerShutdown(broker.endpoint, 1000, broker.instanceId);
      clearBrokerSession(cwd, broker.instanceId);
      teardownBrokerSession(broker);
    }
  }
});

test("broker client rejects an endpoint with a different instance identity", async () => {
  const cwd = makeTempDir();
  const socketPath = path.join(makeTempDir(), "foreign.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const message = JSON.parse(chunk.trim());
      socket.write(
        `${JSON.stringify({
          id: message.id,
          result: {
            userAgent: "foreign-broker",
            brokerInstanceId: "foreign-instance"
          }
        })}\n`
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  await assert.rejects(
    CodexAppServerClient.connect(cwd, {
      brokerEndpoint: `unix:${socketPath}`,
      brokerInstanceId: "expected-instance"
    }),
    /broker instance mismatch/i
  );

  await new Promise((resolve) => server.close(resolve));
});

test("explicit broker endpoints require an instance identity", async () => {
  await assert.rejects(
    CodexAppServerClient.connect(makeTempDir(), {
      brokerEndpoint: "unix:/tmp/anonymous-broker.sock"
    }),
    /instance identity is required/i
  );
});

test("broker close remains bounded across repeated calls on a half-open socket", async () => {
  const socketPath = path.join(makeTempDir(), "half-open.sock");
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      const message = JSON.parse(chunk.trim());
      socket.write(
        `${JSON.stringify({
          id: message.id,
          result: {
            brokerInstanceId: "half-open-instance"
          }
        })}\n`
      );
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = await CodexAppServerClient.connect(makeTempDir(), {
    brokerEndpoint: `unix:${socketPath}`,
    brokerInstanceId: "half-open-instance"
  });
  let destroyCount = 0;
  const originalDestroy = client.socket.destroy.bind(client.socket);
  client.socket.destroy = (...args) => {
    destroyCount += 1;
    return originalDestroy(...args);
  };
  const startedAt = Date.now();

  await client.close({ timeoutMs: 100 });
  await client.close({ timeoutMs: 100 });

  const elapsedMs = Date.now() - startedAt;
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
  assert.equal(elapsedMs < 500, true);
  assert.equal(destroyCount, 1);
});

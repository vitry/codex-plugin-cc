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
      await sendBrokerShutdown(broker.endpoint);
      clearBrokerSession(cwd);
      teardownBrokerSession(broker);
    }
  }
});

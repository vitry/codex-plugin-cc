import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { launchDetachedWorker } from "../plugins/codex/scripts/lib/background-worker.mjs";

test("detached worker launch resolves only after worker readiness", async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
  };
  child.disconnect = () => {};

  let settled = false;
  const launched = launchDetachedWorker({
    cwd: "/repo",
    scriptPath: "/plugin/codex-companion.mjs",
    workerCommand: "review-worker",
    jobId: "review-1",
    spawnImpl(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        "/plugin/codex-companion.mjs",
        "review-worker",
        "--cwd",
        "/repo",
        "--job-id",
        "review-1"
      ]);
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
      return child;
    }
  }).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("message", { type: "ready" });
  await launched;
  assert.equal(child.unrefCalled, true);
});

test("detached worker launch rejects a spawn failure", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const cause = new Error("spawn failed");

  const launched = launchDetachedWorker({
    cwd: "/repo",
    scriptPath: "/plugin/codex-companion.mjs",
    workerCommand: "task-worker",
    jobId: "task-1",
    spawnImpl() {
      return child;
    }
  });

  child.emit("error", cause);
  await assert.rejects(launched, cause);
});

test("detached worker launch rejects an exit before readiness", async () => {
  const child = new EventEmitter();
  child.unref = () => {};

  const launched = launchDetachedWorker({
    cwd: "/repo",
    scriptPath: "/missing-script.mjs",
    workerCommand: "task-worker",
    jobId: "task-2",
    spawnImpl() {
      return child;
    }
  });

  child.emit("exit", 1, null);
  await assert.rejects(launched, /exited before ready.*code 1/i);
});

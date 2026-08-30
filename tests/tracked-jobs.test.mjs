import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { withJobLock } from "../plugins/codex/scripts/lib/job-lock.mjs";
import {
  readJobFile,
  resolveJobFile,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  failQueuedJob,
  runTrackedJob
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

function queuedJob(workspaceRoot, id) {
  return {
    id,
    kind: "task",
    title: "Codex Task",
    workspaceRoot,
    status: "queued",
    phase: "queued"
  };
}

test("a cancelled queued job cannot be claimed by a worker", async () => {
  const workspaceRoot = makeTempDir();
  const job = queuedJob(workspaceRoot, "task-cancelled");
  writeJobFile(workspaceRoot, job.id, { ...job, status: "cancelled" });
  upsertJob(workspaceRoot, { ...job, status: "cancelled" });
  let ran = false;

  const result = await runTrackedJob(
    job,
    async () => {
      ran = true;
      return { exitStatus: 0 };
    },
    { expectedStatus: "queued" }
  );

  assert.equal(result, null);
  assert.equal(ran, false);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "cancelled");
});

test("launch failure only transitions an existing queued job", async () => {
  const workspaceRoot = makeTempDir();
  const queued = queuedJob(workspaceRoot, "task-queued");
  const cancelled = queuedJob(workspaceRoot, "task-cancelled-launch");
  writeJobFile(workspaceRoot, queued.id, queued);
  upsertJob(workspaceRoot, queued);
  writeJobFile(workspaceRoot, cancelled.id, { ...cancelled, status: "cancelled" });
  upsertJob(workspaceRoot, { ...cancelled, status: "cancelled" });

  assert.equal(await failQueuedJob(queued, "launch failed"), true);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, queued.id)).status, "failed");
  assert.equal(await failQueuedJob(cancelled, "launch failed"), false);
  assert.equal(readJobFile(resolveJobFile(workspaceRoot, cancelled.id)).status, "cancelled");
  assert.equal(
    await failQueuedJob(queuedJob(workspaceRoot, "task-removed-launch"), "launch failed"),
    false
  );
  assert.equal(
    fs.existsSync(resolveJobFile(workspaceRoot, "task-removed-launch")),
    false
  );
});

test("job completion does not overwrite cancellation", async () => {
  const workspaceRoot = makeTempDir();
  const job = queuedJob(workspaceRoot, "task-running");
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);

  let finish;
  const runner = new Promise((resolve) => {
    finish = resolve;
  });
  const execution = runTrackedJob(
    job,
    () => runner,
    { expectedStatus: "queued" }
  );

  await withJobLock(workspaceRoot, job.id, () => {
    const running = readJobFile(resolveJobFile(workspaceRoot, job.id));
    assert.equal(running.status, "running");
    const cancelled = {
      ...running,
      status: "cancelled",
      phase: "cancelled",
      pid: null
    };
    writeJobFile(workspaceRoot, job.id, cancelled);
    upsertJob(workspaceRoot, cancelled);
  });

  finish({
    exitStatus: 0,
    payload: { ok: true },
    rendered: "done\n",
    summary: "done"
  });
  await execution;

  assert.equal(readJobFile(resolveJobFile(workspaceRoot, job.id)).status, "cancelled");
});

test("job completion cannot resurrect a removed session job", async () => {
  const workspaceRoot = makeTempDir();
  const job = queuedJob(workspaceRoot, "task-removed");
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);

  let finish;
  const runner = new Promise((resolve) => {
    finish = resolve;
  });
  const execution = runTrackedJob(job, () => runner, { expectedStatus: "queued" });

  await withJobLock(workspaceRoot, job.id, () => {
    fs.unlinkSync(resolveJobFile(workspaceRoot, job.id));
    updateState(workspaceRoot, (state) => {
      state.jobs = state.jobs.filter((candidate) => candidate.id !== job.id);
    });
  });

  finish({
    exitStatus: 0,
    payload: { ok: true },
    rendered: "done\n",
    summary: "done"
  });
  await execution;

  assert.equal(fs.existsSync(resolveJobFile(workspaceRoot, job.id)), false);
});

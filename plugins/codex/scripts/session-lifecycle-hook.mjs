#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { withJobLock } from "./lib/job-lock.mjs";
import {
  finalizeBrokerSession,
  loadBrokerSession,
  releaseBrokerLease,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerExit
} from "./lib/broker-lifecycle.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const removedJobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const activeJob = await withJobLock(workspaceRoot, job.id, () => {
      const current = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id);
      if (
        !current ||
        current.sessionId !== sessionId ||
        (current.status !== "queued" && current.status !== "running")
      ) {
        return null;
      }
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : current;
      const cancelled = {
        ...stored,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        errorMessage: "Session ended."
      };
      writeJobFile(workspaceRoot, job.id, cancelled);
      upsertJob(workspaceRoot, {
        id: job.id,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        errorMessage: "Session ended."
      });
      return current;
    });
    if (!activeJob) {
      continue;
    }
    try {
      terminateProcessTree(activeJob.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  const persistedBroker = loadBrokerSession(cwd);
  let brokerSession = persistedBroker;
  await cleanupSessionJobs(cwd, sessionId);

  if (!persistedBroker?.instanceId) {
    return;
  }
  const released = await releaseBrokerLease(cwd, sessionId);
  brokerSession = released.session;
  if (!released.shouldShutdown) {
    return;
  }

  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;

  if (brokerEndpoint) {
    const acknowledged = await sendBrokerShutdown(
      brokerEndpoint,
      1000,
      brokerSession?.instanceId ?? null
    );
    if (!acknowledged) {
      return;
    }
    const exited = await waitForBrokerExit(
      brokerEndpoint,
      1000,
      brokerSession?.instanceId ?? null
    );
    if (!exited) {
      return;
    }
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    instanceId: brokerSession?.instanceId ?? null
  });
  if (brokerSession?.instanceId) {
    await finalizeBrokerSession(cwd, brokerSession.instanceId);
  }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

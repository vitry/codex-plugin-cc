import fs from "node:fs";
import process from "node:process";

import { withJobLock, withJobLockSync } from "./job-lock.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    withJobLockSync(workspaceRoot, jobId, () => {
      const jobFile = resolveJobFile(workspaceRoot, jobId);
      if (!fs.existsSync(jobFile)) {
        return;
      }
      const storedJob = readJobFile(jobFile);
      if (storedJob.status === "cancelled") {
        return;
      }
      upsertJob(workspaceRoot, patch);
      writeJobFile(workspaceRoot, jobId, {
        ...storedJob,
        ...patch
      });
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function failQueuedJob(job, errorMessage) {
  return withJobLock(job.workspaceRoot, job.id, () => {
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (existing?.status !== "queued") {
      return false;
    }
    const completedAt = nowIso();
    const failedRecord = {
      ...existing,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage
    };
    writeJobFile(job.workspaceRoot, job.id, failedRecord);
    upsertJob(job.workspaceRoot, failedRecord);
    return true;
  });
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const started = await withJobLock(job.workspaceRoot, job.id, () => {
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (options.expectedStatus && existing?.status !== options.expectedStatus) {
      return false;
    }
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
    return true;
  });
  if (!started) {
    return null;
  }
  options.onStarted?.();

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    await withJobLock(job.workspaceRoot, job.id, () => {
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id);
      if (existing?.status !== "running") {
        return;
      }
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt
      });
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    await withJobLock(job.workspaceRoot, job.id, () => {
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id);
      if (existing?.status !== "running") {
        return;
      }
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      });
    });
    throw error;
  }
}

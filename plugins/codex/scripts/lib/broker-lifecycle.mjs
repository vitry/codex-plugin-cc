import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { withFileLock } from "./file-lock.mjs";
import { resolvePersistentRuntimeDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_DIR = ".broker.lock";
const BROKER_LEASE_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const TEST_STATE_ROOT_ENV = "CODEX_COMPANION_TEST_BROKER_STATE_ROOT";

export function createBrokerSessionDir(prefix = "cxc-") {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(sessionDir, 0o700);
  return sessionDir;
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

function endpointAcceptsConnections(endpoint, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

function requestBroker(endpoint, method, params, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    let settled = false;
    let buffer = "";
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.error ? null : (message.result ?? {}));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function waitForBrokerEndpoint(
  endpoint,
  timeoutMs = 2000,
  expectedInstanceId = null
) {
  if (!expectedInstanceId) {
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - start);
    const status = await requestBroker(
      endpoint,
      "broker/status",
      {},
      Math.max(1, Math.min(remainingMs, 150))
    );
    if (
      status?.protocolVersion === 1 &&
      status.instanceId === expectedInstanceId
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(
  endpoint,
  timeoutMs = 1000,
  expectedInstanceId = null
) {
  if (!expectedInstanceId) {
    return false;
  }
  const result = await requestBroker(
    endpoint,
    "broker/shutdown",
    { instanceId: expectedInstanceId },
    timeoutMs
  );
  return result !== null;
}

export async function waitForBrokerExit(
  endpoint,
  timeoutMs = 1000,
  expectedInstanceId = null
) {
  if (!expectedInstanceId) {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestBroker(
      endpoint,
      "broker/status",
      {},
      Math.max(1, Math.min(150, deadline - Date.now()))
    );
    if (!status) {
      const listening = await endpointAcceptsConnections(
        endpoint,
        Math.max(1, Math.min(100, deadline - Date.now()))
      );
      if (!listening) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    if (status.instanceId !== expectedInstanceId) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function childExitPromise(child) {
  if (
    child.exitCode !== undefined &&
    (child.exitCode !== null || child.signalCode !== null)
  ) {
    return Promise.resolve(true);
  }
  if (typeof child.once !== "function") {
    return null;
  }
  return new Promise((resolve) => {
    const finish = () => resolve(true);
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", finish);
  });
}

function signalSpawnedChild(child, signal) {
  if (
    signal === "SIGKILL" &&
    process.platform !== "win32" &&
    Number.isFinite(child.pid)
  ) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the exact child handle if no process group exists.
    }
  }
  if (typeof child.kill === "function") {
    child.kill(signal);
  }
}

async function terminateSpawnedChild(child, timeoutMs = 250) {
  const exited = childExitPromise(child);
  try {
    signalSpawnedChild(child, "SIGTERM");
  } catch {
    return false;
  }
  if (!exited) {
    return false;
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
  if (stopped) {
    return true;
  }
  try {
    signalSpawnedChild(child, "SIGKILL");
  } catch {
    return false;
  }
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  instanceId,
  env = process.env
}) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [
    scriptPath,
    "serve",
    "--endpoint",
    endpoint,
    "--cwd",
    cwd,
    "--pid-file",
    pidFile,
    "--instance-id",
    instanceId
  ], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveBrokerStateDir(cwd), BROKER_STATE_FILE);
}

function resolveBrokerStateDir(cwd) {
  const testStateRoot =
    process.env.NODE_TEST_CONTEXT && process.env[TEST_STATE_ROOT_ENV]
      ? process.env[TEST_STATE_ROOT_ENV]
      : null;
  return resolvePersistentRuntimeDir(cwd, testStateRoot);
}

function resolveBrokerLock(cwd) {
  const stateDir = resolveBrokerStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return path.join(stateDir, BROKER_LOCK_DIR);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateFile = resolveBrokerStateFile(cwd);
  const stateDir = path.dirname(stateFile);
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(tempFile, stateFile);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

export function clearBrokerSession(cwd, expectedInstanceId = null) {
  if (!expectedInstanceId) {
    return false;
  }
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return false;
  }
  const current = loadBrokerSession(cwd);
  if (current?.instanceId !== expectedInstanceId) {
    return false;
  }
  fs.unlinkSync(stateFile);
  return true;
}

async function isBrokerEndpointReady(
  endpoint,
  instanceId,
  probe = waitForBrokerEndpoint,
  timeoutMs = 150
) {
  if (!endpoint) {
    return false;
  }
  try {
    return await probe(endpoint, timeoutMs, instanceId);
  } catch {
    return false;
  }
}

function updateBrokerLease(session, env, now = Date.now()) {
  const sessionId = String(env?.[SESSION_ID_ENV] ?? "").trim();
  const leases = (Array.isArray(session.leases) ? session.leases : []).filter(
    (lease) =>
      typeof lease?.sessionId === "string" &&
      Number.isFinite(lease?.lastSeenAt) &&
      now - lease.lastSeenAt <= BROKER_LEASE_TTL_MS
  );
  if (sessionId) {
    const existing = leases.find((lease) => lease.sessionId === sessionId);
    if (existing) {
      existing.lastSeenAt = now;
    } else {
      leases.push({ sessionId, lastSeenAt: now });
    }
  }
  leases.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return {
    ...session,
    leases
  };
}

export async function ensureBrokerSession(cwd, options = {}) {
  return withFileLock(
    resolveBrokerLock(cwd),
    () => ensureBrokerSessionUnlocked(cwd, options),
    options.lockOptions
  );
}

async function ensureBrokerSessionUnlocked(cwd, options = {}) {
  const probe = options.waitForBrokerEndpoint ?? waitForBrokerEndpoint;
  const existing = loadBrokerSession(cwd);
  if (
    existing &&
    typeof existing.instanceId === "string" &&
    existing.instanceId &&
    existing.status !== "stopping" &&
    (await isBrokerEndpointReady(
      existing.endpoint,
      existing.instanceId,
      probe,
      existing.status === "starting" ? (options.timeoutMs ?? 2000) : 150
    ))
  ) {
    const leased = updateBrokerLease(
      { ...existing, status: "ready" },
      options.env ?? process.env
    );
    saveBrokerSession(cwd, leased);
    return leased;
  }

  if (existing) {
    if (existing.status !== "stopping") {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        instanceId: existing.instanceId ?? null
      });
    }
    if (existing.instanceId) {
      clearBrokerSession(cwd, existing.instanceId);
    } else {
      fs.rmSync(resolveBrokerStateFile(cwd), { force: true });
    }
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const instanceId = randomUUID();
  let session = updateBrokerLease({
    status: "starting",
    instanceId,
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: null,
    leases: []
  }, options.env ?? process.env);
  saveBrokerSession(cwd, session);

  const spawnProcess = options.spawnBrokerProcess ?? spawnBrokerProcess;
  let child;
  try {
    child = spawnProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      instanceId,
      env: options.env ?? process.env
    });
  } catch (error) {
    clearBrokerSession(cwd, instanceId);
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      instanceId
    });
    throw error;
  }
  session = { ...session, pid: child.pid ?? null };
  saveBrokerSession(cwd, session);

  const spawnFailed = new Promise((resolve) => {
    if (typeof child.once === "function") {
      child.once("error", () => resolve(true));
    }
  });
  const ready = await Promise.race([
    Promise.resolve(probe(endpoint, options.timeoutMs ?? 2000, instanceId))
      .then(Boolean)
      .catch(() => false),
    spawnFailed.then(() => false)
  ]);
  if (!ready) {
    let creatorExited = false;
    if (typeof child.kill === "function") {
      creatorExited = await terminateSpawnedChild(
        child,
        options.childTerminationTimeoutMs ?? 250
      );
    } else if (Number.isFinite(child.pid) && options.killProcess) {
      try {
        options.killProcess(child.pid);
      } catch {
        // Test adapters may expose only a PID-based termination primitive.
      }
    }
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      instanceId,
      removeEndpoint: creatorExited
    });
    clearBrokerSession(cwd, instanceId);
    return null;
  }

  session = { ...session, status: "ready" };
  saveBrokerSession(cwd, session);
  return session;
}

export async function releaseBrokerLease(cwd, sessionId) {
  return withFileLock(resolveBrokerLock(cwd), () => {
    const session = loadBrokerSession(cwd);
    if (!session) {
      return { session: null, shouldShutdown: false };
    }
    const current = updateBrokerLease(session, {});
    const normalizedSessionId = String(sessionId ?? "").trim();
    current.leases = normalizedSessionId
      ? current.leases.filter((lease) => lease.sessionId !== normalizedSessionId)
      : current.leases;
    if (current.leases.length > 0) {
      saveBrokerSession(cwd, current);
      return { session: current, shouldShutdown: false };
    }
    const stopping = { ...current, status: "stopping" };
    saveBrokerSession(cwd, stopping);
    return { session: stopping, shouldShutdown: true };
  });
}

export async function finalizeBrokerSession(cwd, instanceId) {
  if (!instanceId) {
    return false;
  }
  return withFileLock(resolveBrokerLock(cwd), () =>
    clearBrokerSession(cwd, instanceId)
  );
}

function readPidFileOwner(pidFile) {
  if (!pidFile || !fs.existsSync(pidFile)) {
    return null;
  }
  try {
    const value = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    return typeof value?.instanceId === "string" ? value : null;
  } catch {
    return null;
  }
}

function removeOwnedPidFile(pidFile, instanceId) {
  if (!pidFile || !fs.existsSync(pidFile)) {
    return "missing";
  }
  const quarantineFile = `${pidFile}.release-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(pidFile, quarantineFile);
  } catch (error) {
    return error?.code === "ENOENT" ? "missing" : "mismatch";
  }
  const owner = readPidFileOwner(quarantineFile);
  if (owner?.instanceId !== instanceId) {
    try {
      fs.renameSync(quarantineFile, pidFile);
    } catch {
      // Preserve the unexpected file in quarantine if its path was replaced.
    }
    return "mismatch";
  }
  fs.unlinkSync(quarantineFile);
  return "removed";
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null,
  instanceId = null,
  removeEndpoint = false
}) {
  const pidOwner = readPidFileOwner(pidFile);

  if (Number.isFinite(pid) && killProcess && pidOwner?.instanceId === instanceId) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (instanceId) {
    if (removeOwnedPidFile(pidFile, instanceId) === "mismatch") {
      return false;
    }
  } else if (pidFile && fs.existsSync(pidFile)) {
    return false;
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (removeEndpoint && endpoint && resolvedSessionDir) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      const endpointPath = path.resolve(target.path);
      if (
        target.kind === "unix" &&
        path.dirname(endpointPath) === path.resolve(resolvedSessionDir) &&
        fs.existsSync(endpointPath) &&
        fs.lstatSync(endpointPath).isSocket()
      ) {
        fs.unlinkSync(endpointPath);
      }
    } catch {
      // Creator-only cleanup is best effort after the child has exited.
    }
  }
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
  return true;
}

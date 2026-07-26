import fs from "node:fs";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_MS = 30000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function removeStaleLock(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {
    // Another process released the lock.
  }
}

function tryAcquire(lockPath, staleMs) {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (cause) {
    if (cause?.code !== "EEXIST") {
      throw cause;
    }
    removeStaleLock(lockPath, staleMs);
    return false;
  }
}

export function withFileLockSync(lockPath, action, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (!tryAcquire(lockPath, staleMs)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock: ${lockPath}`);
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, retryMs);
  }

  try {
    return action();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export async function withFileLock(lockPath, action, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (!tryAcquire(lockPath, staleMs)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lock: ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  try {
    return await action();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

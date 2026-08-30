import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { resolveStateDir } from "./state.mjs";

function resolveSharedJobLock(workspaceRoot) {
  return `${resolveStateDir(workspaceRoot)}/.jobs.lock`;
}

export async function withJobLock(workspaceRoot, _jobId, action, options = {}) {
  const lockPath = resolveSharedJobLock(workspaceRoot);
  return withFileLock(lockPath, action, options);
}

export function withJobLockSync(workspaceRoot, _jobId, action, options = {}) {
  const lockPath = resolveSharedJobLock(workspaceRoot);
  return withFileLockSync(lockPath, action, options);
}

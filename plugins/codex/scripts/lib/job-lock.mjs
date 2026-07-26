import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { resolveJobFile } from "./state.mjs";

export async function withJobLock(workspaceRoot, jobId, action, options = {}) {
  const lockPath = `${resolveJobFile(workspaceRoot, jobId)}.lock`;
  return withFileLock(lockPath, action, options);
}

export function withJobLockSync(workspaceRoot, jobId, action, options = {}) {
  const lockPath = `${resolveJobFile(workspaceRoot, jobId)}.lock`;
  return withFileLockSync(lockPath, action, options);
}

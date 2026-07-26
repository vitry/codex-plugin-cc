import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_WINDOWS_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 10;
const WINDOWS_HELPER_STARTUP_GRACE_MS = 5000;
const NATIVE_LOCK_SUFFIX = ".advisory-v2";
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const LOCK_CONTEXT = new AsyncLocalStorage();
const WINDOWS_GLOBAL_LOCK_KEY = Symbol("windows-global-lock");

function lockContextKeys(lockPath) {
  /** @type {Array<string | symbol>} */
  const keys = [path.resolve(lockPath)];
  if (process.platform === "win32") {
    keys.push(WINDOWS_GLOBAL_LOCK_KEY);
  }
  return keys;
}

function findActiveLockLease(lockPath) {
  const context = LOCK_CONTEXT.getStore();
  for (const key of lockContextKeys(lockPath)) {
    const lease = context?.get(key);
    if (lease?.active) {
      return lease;
    }
  }
  return null;
}

function retainLockLease(lease) {
  lease.references += 1;
}

function releaseLockLease(lease) {
  lease.references -= 1;
  if (lease.references > 0) {
    return null;
  }
  lease.active = false;
  if (!lease.releaseStarted) {
    lease.releaseStarted = true;
    lease.releaseResult = lease.release();
  }
  return lease.releaseResult;
}

function createLockContext(lockPath, release) {
  const context = new Map(LOCK_CONTEXT.getStore() ?? []);
  const lease = {
    active: true,
    references: 1,
    release,
    releaseStarted: false,
    releaseResult: null
  };
  for (const key of lockContextKeys(lockPath)) {
    context.set(key, lease);
  }
  return { context, lease };
}

function runWithLockContext(lockPath, action, release) {
  const { context, lease } = createLockContext(lockPath, release);
  try {
    return LOCK_CONTEXT.run(context, action);
  } finally {
    releaseLockLease(lease);
  }
}

async function runWithLockContextAsync(lockPath, action, release) {
  const { context, lease } = createLockContext(lockPath, release);
  try {
    return await LOCK_CONTEXT.run(context, action);
  } finally {
    await releaseLockLease(lease);
  }
}

function timeoutError(lockPath) {
  return new Error(`Timed out waiting for lock: ${lockPath}`);
}

function nativeLockCommand(fd) {
  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/lockf",
      args: ["-s", "-t", "0", String(fd)]
    };
  }
  return {
    command: "flock",
    args: ["-x", "-n", String(fd)]
  };
}

function openNativeLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return fs.openSync(`${lockPath}${NATIVE_LOCK_SUFFIX}`, "a+", 0o600);
}

function acquireNativeLockSync(lockPath, timeoutMs, retryMs) {
  const fd = openNativeLock(lockPath);
  const childFd = 3;
  const { command, args } = nativeLockCommand(childFd);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = spawnSync(command, args, {
      stdio: ["ignore", "ignore", "ignore", fd]
    });
    if (result.status === 0) {
      return fd;
    }
    if (Date.now() >= deadline) {
      fs.closeSync(fd);
      throw timeoutError(lockPath);
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, retryMs);
  }
}

async function acquireNativeLock(lockPath, timeoutMs, retryMs) {
  const fd = openNativeLock(lockPath);
  const childFd = 3;
  const { command, args } = nativeLockCommand(childFd);
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const status = await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: ["ignore", "ignore", "ignore", fd]
        });
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (status === 0) {
        return fd;
      }
      if (Date.now() >= deadline) {
        throw timeoutError(lockPath);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createWindowsMutexHelper(lockPath, timeoutMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;
  const readyFile = `${lockPath}.${token}.ready`;
  const releaseFile = `${lockPath}.${token}.release`;
  const doneFile = `${lockPath}.${token}.done`;
  const windowsDataRoot =
    process.env.LOCALAPPDATA ??
    path.join(process.env.USERPROFILE ?? path.dirname(process.execPath), "AppData", "Local");
  const ownerDir = path.join(windowsDataRoot, "OpenAI", "CodexCompanion");
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  const ownerFile = path.join(
    ownerDir,
    "codex-companion-windows-global-lock.owner.json"
  );
  const mutexName = "Global\\CodexCompanion-GlobalStateLock-v2";
  const script = [
    `$mutex = [System.Threading.Mutex]::new($false, ${powershellQuote(mutexName)})`,
    "$held = $false",
    "$parentGone = $false",
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${Math.max(1, Math.ceil(timeoutMs))})`,
    `$parentProcess = [System.Diagnostics.Process]::GetProcessById(${process.pid})`,
    "$parentStartTicks = $parentProcess.StartTime.ToUniversalTime().Ticks",
    "$helperProcess = [System.Diagnostics.Process]::GetCurrentProcess()",
    `$lease = @{ token = ${powershellQuote(token)}; readyFile = ${powershellQuote(readyFile)}; releaseFile = ${powershellQuote(releaseFile)}; doneFile = ${powershellQuote(doneFile)}; helperPid = $PID; helperStartTicks = $helperProcess.StartTime.ToUniversalTime().Ticks }`,
    "try {",
    "  while ($true) {",
    "    $acquired = $false",
    "    try { $acquired = $mutex.WaitOne(100) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }",
    "    if (-not $acquired) {",
    "      if ([DateTime]::UtcNow -ge $deadline) { exit 75 }",
    "      continue",
    "    }",
    "    $held = $true",
    "    $owner = $null",
    `    if ([System.IO.File]::Exists(${powershellQuote(ownerFile)})) {`,
    `      try { $owner = Get-Content -Raw ${powershellQuote(ownerFile)} | ConvertFrom-Json } catch { Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(ownerFile)} }`,
    "    }",
    "    if ($null -ne $owner) {",
    "      $ownerAlive = $true",
    "      try {",
    "        $ownerProcess = [System.Diagnostics.Process]::GetProcessById([int]$owner.parentPid)",
    "        if ($ownerProcess.StartTime.ToUniversalTime().Ticks -ne [long]$owner.parentStartTicks) { $ownerAlive = $false }",
    "      } catch { $ownerAlive = $false }",
    "      $activeLeases = @()",
    "      foreach ($existing in @($owner.leases)) {",
    "        if ([System.IO.File]::Exists([string]$existing.releaseFile)) {",
    "          $helperAlive = $true",
    "          if ($null -ne $existing.helperPid -and $null -ne $existing.helperStartTicks) {",
    "            try {",
    "              $existingHelper = [System.Diagnostics.Process]::GetProcessById([int]$existing.helperPid)",
    "              if ($existingHelper.StartTime.ToUniversalTime().Ticks -ne [long]$existing.helperStartTicks) { $helperAlive = $false }",
    "            } catch { $helperAlive = $false }",
    "          }",
    "          if (-not $ownerAlive -or -not $helperAlive) {",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$existing.readyFile)",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$existing.releaseFile)",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$existing.doneFile)",
    "          }",
    "        } else { $activeLeases += $existing }",
    "      }",
    "      $owner.leases = @($activeLeases)",
    "      if (-not $ownerAlive -or $owner.leases.Count -eq 0) {",
    "        if (-not $ownerAlive) {",
    "          foreach ($abandoned in @($owner.leases)) {",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$abandoned.readyFile)",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$abandoned.releaseFile)",
    "            Remove-Item -Force -ErrorAction SilentlyContinue ([string]$abandoned.doneFile)",
    "          }",
    "        }",
    `        Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(ownerFile)}`,
    "        $owner = $null",
    "      }",
    "    }",
    "    if ($null -eq $owner) {",
    `      $owner = @{ parentPid = ${process.pid}; parentStartTicks = $parentStartTicks; leases = @($lease) }`,
    `      $owner | ConvertTo-Json -Depth 5 -Compress | Set-Content -NoNewline ${powershellQuote(ownerFile)}`,
    "      $mutex.ReleaseMutex()",
    "      $held = $false",
    `      [System.IO.File]::WriteAllText(${powershellQuote(readyFile)}, "ready")`,
    "      break",
    "    }",
    "    $mutex.ReleaseMutex()",
    "    $held = $false",
    "    if ([DateTime]::UtcNow -ge $deadline) { exit 75 }",
    "    Start-Sleep -Milliseconds 10",
    "  }",
    `  while (-not [System.IO.File]::Exists(${powershellQuote(releaseFile)})) {`,
    `    try { $liveParent = [System.Diagnostics.Process]::GetProcessById(${process.pid}); if ($liveParent.StartTime.ToUniversalTime().Ticks -ne $parentStartTicks) { $parentGone = $true; break } } catch { $parentGone = $true; break }`,
    "    Start-Sleep -Milliseconds 10",
    "  }",
    "  $cleanupAcquired = $false",
    "  try { $cleanupAcquired = $mutex.WaitOne(1000) } catch [System.Threading.AbandonedMutexException] { $cleanupAcquired = $true }",
    "  if ($cleanupAcquired) {",
    "    $held = $true",
    "    $owner = $null",
    `    if ([System.IO.File]::Exists(${powershellQuote(ownerFile)})) { try { $owner = Get-Content -Raw ${powershellQuote(ownerFile)} | ConvertFrom-Json } catch {} }`,
    `    if ($null -ne $owner -and [int]$owner.parentPid -eq ${process.pid} -and [long]$owner.parentStartTicks -eq $parentStartTicks) {`,
    `      $remaining = @($owner.leases | Where-Object { [string]$_.token -ne ${powershellQuote(token)} })`,
    "      if ($remaining.Count -eq 0) {",
    `        Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(ownerFile)}`,
    "      } else {",
    "        $owner.leases = $remaining",
    `        $owner | ConvertTo-Json -Depth 5 -Compress | Set-Content -NoNewline ${powershellQuote(ownerFile)}`,
    "      }",
    "    }",
    "    $mutex.ReleaseMutex()",
    "    $held = $false",
    "  }",
    "  if ($parentGone) {",
    `    Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(readyFile)}`,
    `    Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(releaseFile)}`,
    `    Remove-Item -Force -ErrorAction SilentlyContinue ${powershellQuote(doneFile)}`,
    "  } else {",
    `    [System.IO.File]::WriteAllText(${powershellQuote(doneFile)}, "done")`,
    "  }",
    "} finally {",
    "  if ($held) { $mutex.ReleaseMutex() }",
    "  $mutex.Dispose()",
    "}"
  ].join("\r\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdio: "ignore", windowsHide: true }
  );
  child.once("error", () => {});
  return { child, readyFile, releaseFile, doneFile, ownerFile, token };
}

function cleanupWindowsMutexFiles(handle) {
  for (const file of [handle.readyFile, handle.releaseFile, handle.doneFile]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Unique coordination files may already have been removed.
    }
  }
}

function windowsLeaseWasGranted(handle) {
  try {
    const owner = JSON.parse(fs.readFileSync(handle.ownerFile, "utf8"));
    return Array.isArray(owner?.leases)
      && owner.leases.some((lease) => lease?.token === handle.token);
  } catch {
    return false;
  }
}

function abortWindowsMutexSync(handle, retryMs) {
  handle.child.kill();
  const deadline = Date.now() + 250;
  while (processIsAlive(handle.child.pid) && Date.now() < deadline) {
    Atomics.wait(WAIT_BUFFER, 0, 0, retryMs);
  }
  if (windowsLeaseWasGranted(handle)) {
    try {
      fs.writeFileSync(handle.releaseFile, "release", { flag: "wx" });
    } catch {
      // The release marker may already exist.
    }
  } else {
    cleanupWindowsMutexFiles(handle);
  }
}

async function abortWindowsMutex(handle, retryMs) {
  handle.child.kill();
  const deadline = Date.now() + 250;
  while (processIsAlive(handle.child.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  if (windowsLeaseWasGranted(handle)) {
    try {
      fs.writeFileSync(handle.releaseFile, "release", { flag: "wx" });
    } catch {
      // The release marker may already exist.
    }
  } else {
    cleanupWindowsMutexFiles(handle);
  }
}

function acquireWindowsLockSync(lockPath, timeoutMs, retryMs) {
  const handle = createWindowsMutexHelper(lockPath, timeoutMs);
  const deadline = Date.now() + timeoutMs + WINDOWS_HELPER_STARTUP_GRACE_MS;
  while (!fs.existsSync(handle.readyFile)) {
    if (!processIsAlive(handle.child.pid) || Date.now() >= deadline) {
      abortWindowsMutexSync(handle, retryMs);
      throw timeoutError(lockPath);
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, retryMs);
  }
  return handle;
}

async function acquireWindowsLock(lockPath, timeoutMs, retryMs) {
  const handle = createWindowsMutexHelper(lockPath, timeoutMs);
  const deadline = Date.now() + timeoutMs + WINDOWS_HELPER_STARTUP_GRACE_MS;
  while (!fs.existsSync(handle.readyFile)) {
    if (!processIsAlive(handle.child.pid) || Date.now() >= deadline) {
      await abortWindowsMutex(handle, retryMs);
      throw timeoutError(lockPath);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return handle;
}

function releaseWindowsLockSync(handle, retryMs) {
  fs.writeFileSync(handle.releaseFile, "release", { flag: "wx" });
  const deadline = Date.now() + 1000;
  while (!fs.existsSync(handle.doneFile) && processIsAlive(handle.child.pid)) {
    if (Date.now() >= deadline) {
      handle.child.kill();
      break;
    }
    Atomics.wait(WAIT_BUFFER, 0, 0, retryMs);
  }
  if (fs.existsSync(handle.doneFile)) {
    cleanupWindowsMutexFiles(handle);
  }
}

async function releaseWindowsLock(handle, retryMs) {
  fs.writeFileSync(handle.releaseFile, "release", { flag: "wx" });
  const deadline = Date.now() + 1000;
  while (!fs.existsSync(handle.doneFile) && processIsAlive(handle.child.pid)) {
    if (Date.now() >= deadline) {
      handle.child.kill();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  if (fs.existsSync(handle.doneFile)) {
    cleanupWindowsMutexFiles(handle);
  }
}

export function withFileLockSync(lockPath, action, options = {}) {
  const timeoutMs =
    options.timeoutMs ??
    (process.platform === "win32" ? DEFAULT_WINDOWS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const activeLease = findActiveLockLease(lockPath);
  if (activeLease) {
    retainLockLease(activeLease);
    try {
      return action();
    } finally {
      releaseLockLease(activeLease);
    }
  }
  if (process.platform !== "win32") {
    const fd = acquireNativeLockSync(lockPath, timeoutMs, retryMs);
    return runWithLockContext(lockPath, action, () => fs.closeSync(fd));
  }
  const handle = acquireWindowsLockSync(lockPath, timeoutMs, retryMs);
  return runWithLockContext(
    lockPath,
    action,
    () => releaseWindowsLockSync(handle, retryMs)
  );
}

export async function withFileLock(lockPath, action, options = {}) {
  const timeoutMs =
    options.timeoutMs ??
    (process.platform === "win32" ? DEFAULT_WINDOWS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const activeLease = findActiveLockLease(lockPath);
  if (activeLease) {
    retainLockLease(activeLease);
    try {
      return await action();
    } finally {
      await releaseLockLease(activeLease);
    }
  }
  if (process.platform !== "win32") {
    const fd = await acquireNativeLock(lockPath, timeoutMs, retryMs);
    return runWithLockContextAsync(lockPath, action, () => fs.closeSync(fd));
  }
  const handle = await acquireWindowsLock(lockPath, timeoutMs, retryMs);
  return runWithLockContextAsync(
    lockPath,
    action,
    () => releaseWindowsLock(handle, retryMs)
  );
}

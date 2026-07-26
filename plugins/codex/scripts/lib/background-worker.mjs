import { spawn } from "node:child_process";
import process from "node:process";

export function launchDetachedWorker({
  cwd,
  scriptPath,
  workerCommand,
  jobId,
  env = process.env,
  spawnImpl = spawn
}) {
  const child = spawnImpl(
    process.execPath,
    [scriptPath, workerCommand, "--cwd", cwd, "--job-id", jobId],
    {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true
    }
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      try {
        child.disconnect?.();
      } catch {
        // The IPC channel may already be closed.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may already have exited.
      }
      child.unref();
      finish(new Error("Background worker did not become ready in time."));
    }, 10000);
    timeout.unref?.();

    function cleanup() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function finish(cause = null) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (cause) {
        reject(cause);
        return;
      }
      child.unref();
      resolve({ pid: child.pid ?? null });
    }

    function onMessage(message) {
      if (message?.type === "ready") {
        child.disconnect?.();
        finish();
      }
    }

    function onError(cause) {
      finish(cause);
    }

    function onExit(code, signal) {
      finish(
        new Error(
          `Background worker exited before ready${signal ? ` (${signal})` : ` (code ${code ?? 1})`}.`
        )
      );
    }

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

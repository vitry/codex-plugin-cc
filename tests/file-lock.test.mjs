import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  withFileLock,
  withFileLockSync
} from "../plugins/codex/scripts/lib/file-lock.mjs";

function waitForFile(file, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${file}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function spawnLockHolder(lockPath, readyFile) {
  const lockModule = new URL(
    "../plugins/codex/scripts/lib/file-lock.mjs",
    import.meta.url
  ).href;
  const source = [
    `import fs from "node:fs";`,
    `import { withFileLock } from ${JSON.stringify(lockModule)};`,
    `await withFileLock(${JSON.stringify(lockPath)}, async () => {`,
    `  fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    `  setInterval(() => {}, 1000);`,
    `  await new Promise(() => {});`,
    `});`
  ].join("\n");
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: "ignore"
  });
}

test("a live owner cannot be displaced by lock age", async (t) => {
  const root = makeTempDir();
  const lockPath = path.join(root, "state.lock");
  const readyFile = path.join(root, "ready");
  const child = spawnLockHolder(lockPath, readyFile);
  t.after(() => child.kill("SIGKILL"));
  await waitForFile(readyFile);
  if (process.platform !== "win32") {
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(`${lockPath}.advisory-v2`, old, old);
  }

  assert.throws(
    () =>
      withFileLockSync(lockPath, () => "unexpected", {
        timeoutMs: 25
      }),
    /timed out waiting for lock/i
  );
});

test("a crashed owner releases the kernel lock immediately", async (t) => {
  const root = makeTempDir();
  const lockPath = path.join(root, "state.lock");
  const readyFile = path.join(root, "ready");
  const child = spawnLockHolder(lockPath, readyFile);
  t.after(() => child.kill("SIGKILL"));
  await waitForFile(readyFile);
  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }

  assert.equal(
    withFileLockSync(lockPath, () => "acquired", { timeoutMs: 100 }),
    "acquired"
  );
});

test(
  "release keeps one persistent lock inode instead of unlinking a shared path",
  { skip: process.platform === "win32" },
  () => {
  const lockPath = path.join(makeTempDir(), "state.lock");
  const nativeLockPath = `${lockPath}.advisory-v2`;
  withFileLockSync(lockPath, () => {});
  const before = fs.statSync(nativeLockPath);

  withFileLockSync(lockPath, () => {});
  const after = fs.statSync(nativeLockPath);

  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  }
);

test("an old directory lock does not block the advisory lock upgrade", () => {
  const lockPath = path.join(makeTempDir(), "state.lock");
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: 999999, token: "legacy" })}\n`,
    "utf8"
  );

  assert.equal(
    withFileLockSync(lockPath, () => "acquired", { timeoutMs: 100 }),
    "acquired"
  );
  assert.equal(fs.statSync(lockPath).isDirectory(), true);
});

test("the same lock path is reentrant within one synchronous action", () => {
  const root = makeTempDir();
  const lockPath = path.join(root, "state.lock");
  const result = withFileLockSync(lockPath, () =>
    withFileLockSync(lockPath, () => "nested", {
      timeoutMs: 1000
    })
  );

  assert.equal(result, "nested");
});

test("the same lock path is reentrant within one asynchronous action", async () => {
  const lockPath = path.join(makeTempDir(), "state.lock");

  const result = await withFileLock(lockPath, () =>
    withFileLock(lockPath, async () => "nested", {
      timeoutMs: 1000
    })
  );

  assert.equal(result, "nested");
});

test("a detached same-path action retains the underlying process lock", async (t) => {
  const root = makeTempDir();
  const lockPath = path.join(root, "state.lock");
  const attemptedFile = path.join(root, "attempted");
  const enteredFile = path.join(root, "entered");
  const lockModule = new URL(
    "../plugins/codex/scripts/lib/file-lock.mjs",
    import.meta.url
  ).href;
  let releaseDetached;
  const detachedGate = new Promise((resolve) => {
    releaseDetached = resolve;
  });
  let detachedPromise;

  await withFileLock(lockPath, async () => {
    detachedPromise = withFileLock(lockPath, async () => {
      await detachedGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  const source = [
    `import fs from "node:fs";`,
    `import { withFileLockSync } from ${JSON.stringify(lockModule)};`,
    `fs.writeFileSync(${JSON.stringify(attemptedFile)}, "attempted");`,
    `withFileLockSync(${JSON.stringify(lockPath)}, () => {`,
    `  fs.writeFileSync(${JSON.stringify(enteredFile)}, "entered");`,
    `}, { timeoutMs: 1000 });`
  ].join("\n");
  const contender = spawn(
    process.execPath,
    ["--input-type=module", "-e", source],
    { stdio: "ignore" }
  );
  const contenderExit = new Promise((resolve, reject) => {
    contender.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`contender exited ${code}`));
      }
    });
    contender.once("error", reject);
  });
  t.after(() => contender.kill("SIGKILL"));
  await waitForFile(attemptedFile);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(fs.existsSync(enteredFile), false);

  releaseDetached();
  await detachedPromise;
  await contenderExit;
  assert.equal(fs.existsSync(enteredFile), true);
});

test(
  "a killed Windows mutex helper does not release its live parent lease",
  { skip: process.platform !== "win32" },
  () => {
    const root = makeTempDir();
    const lockPath = path.join(root, "state.lock");
    const contenderFile = path.join(root, "contender-entered");
    const lockModule = new URL(
      "../plugins/codex/scripts/lib/file-lock.mjs",
      import.meta.url
    ).href;

    withFileLockSync(lockPath, () => {
      const killChildren = [
        `$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*-EncodedCommand*' })`,
        "if ($children.Count -ne 1) { exit 3 }",
        "$helperPid = [int]$children[0].ProcessId",
        "Stop-Process -Id $helperPid -Force",
        "Wait-Process -Id $helperPid -ErrorAction SilentlyContinue",
        "Write-Output $helperPid"
      ].join("; ");
      const killed = spawnSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", killChildren],
        { encoding: "utf8" }
      );
      assert.equal(killed.status, 0, killed.stderr);
      const helperPid = Number.parseInt(killed.stdout.trim(), 10);
      assert.equal(Number.isInteger(helperPid), true);
      assert.throws(() => process.kill(helperPid, 0));

      const source = [
        `import fs from "node:fs";`,
        `import { withFileLockSync } from ${JSON.stringify(lockModule)};`,
        `withFileLockSync(${JSON.stringify(lockPath)}, () => {`,
        `  fs.writeFileSync(${JSON.stringify(contenderFile)}, "entered");`,
        `}, { timeoutMs: 100 });`
      ].join("\n");
      const contender = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", source],
        { encoding: "utf8", timeout: 1000 }
      );
      assert.notEqual(contender.status, 0);
      assert.equal(fs.existsSync(contenderFile), false);
    });

    assert.equal(
      withFileLockSync(lockPath, () => "recovered", { timeoutMs: 1000 }),
      "recovered"
    );
    assert.deepEqual(
      fs.readdirSync(root).filter((name) =>
        /\.(?:ready|release|done)$/.test(name)
      ),
      []
    );
  }
);

test(
  "Windows reclaims files after a lock parent and helper crash together",
  { skip: process.platform !== "win32" },
  async () => {
    const root = makeTempDir();
    const lockPath = path.join(root, "state.lock");
    const readyFile = path.join(root, "holder-ready");
    const child = spawnLockHolder(lockPath, readyFile);
    await waitForFile(readyFile);

    const killed = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { encoding: "utf8" }
    );
    assert.equal(killed.status, 0, killed.stderr);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }

    assert.equal(
      withFileLockSync(lockPath, () => "recovered", { timeoutMs: 1000 }),
      "recovered"
    );
    assert.deepEqual(
      fs.readdirSync(root).filter((name) =>
        /\.(?:ready|release|done)$/.test(name)
      ),
      []
    );
  }
);

test(
  "concurrent Windows locks in one process remain mutually exclusive",
  { skip: process.platform !== "win32" },
  async () => {
    const root = makeTempDir();
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        withFileLock(path.join(root, `lock-${index}`), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        })
      )
    );

    assert.equal(peak, 1);
  }
);

test(
  "a detached Windows lock call cannot reuse an expired nested context",
  { skip: process.platform !== "win32" },
  async () => {
    const root = makeTempDir();
    let active = 0;
    let peak = 0;
    let detachedPromise = null;
    let triggerDetached;
    const detachedTrigger = new Promise((resolve) => {
      triggerDetached = resolve;
    });

    await withFileLock(path.join(root, "outer.lock"), async () => {
      detachedPromise = detachedTrigger.then(() =>
        withFileLock(
          path.join(root, "detached.lock"),
          async () => {
            active += 1;
            peak = Math.max(peak, active);
            active -= 1;
          }
        )
      );
    });

    let markHolderEntered;
    const holderEntered = new Promise((resolve) => {
      markHolderEntered = resolve;
    });
    const holder = withFileLock(path.join(root, "holder.lock"), async () => {
      active += 1;
      peak = Math.max(peak, active);
      markHolderEntered();
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
    });
    await holderEntered;
    triggerDetached();
    await Promise.all([holder, detachedPromise]);

    assert.equal(peak, 1);
  }
);

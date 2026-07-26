import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  exportZCodeSession,
  parseZCodeSessionSource
} from "../plugins/codex/scripts/lib/zcode-session-transfer.mjs";

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDatabase(root) {
  const databasePath = path.join(root, "db.sqlite");
  const repo = path.join(root, "repo");
  const otherRepo = path.join(root, "other");
  fs.mkdirSync(repo);
  fs.mkdirSync(otherRepo);
  const statements = [
    "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);",
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);",
    `INSERT INTO session VALUES ('sess_current', ${sql(repo)}, 'Current session', 1000, 9000);`,
    `INSERT INTO session VALUES ('sess_other', ${sql(otherRepo)}, 'Other session', 2000, 8000);`,
    `INSERT INTO message VALUES ('msg_u1', 'sess_current', 1100, 1100, ${sql(JSON.stringify({ role: "user" }))});`,
    `INSERT INTO part VALUES ('part_u1', 'msg_u1', 'sess_current', 1110, 1110, ${sql(JSON.stringify({ type: "text", text: "First request" }))});`,
    `INSERT INTO message VALUES ('msg_a1', 'sess_current', 1200, 1200, ${sql(JSON.stringify({ role: "assistant" }))});`,
    `INSERT INTO part VALUES ('part_reason', 'msg_a1', 'sess_current', 1210, 1210, ${sql(JSON.stringify({ type: "reasoning", text: "private reasoning" }))});`,
    `INSERT INTO part VALUES ('part_a1', 'msg_a1', 'sess_current', 1220, 1220, ${sql(JSON.stringify({ type: "text", text: "First answer" }))});`,
    `INSERT INTO part VALUES ('part_tool', 'msg_a1', 'sess_current', 1230, 1230, ${sql(JSON.stringify({ type: "tool", tool: "Read" }))});`,
    `INSERT INTO message VALUES ('msg_u2', 'sess_current', 1300, 1300, ${sql(JSON.stringify({ role: "user" }))});`,
    `INSERT INTO part VALUES ('part_u2a', 'msg_u2', 'sess_current', 1310, 1310, ${sql(JSON.stringify({ type: "text", text: "Second" }))});`,
    `INSERT INTO part VALUES ('part_u2b', 'msg_u2', 'sess_current', 1320, 1320, ${sql(JSON.stringify({ type: "text", text: "request" }))});`,
    `INSERT INTO message VALUES ('msg_other', 'sess_other', 2100, 2100, ${sql(JSON.stringify({ role: "user" }))});`,
    `INSERT INTO part VALUES ('part_other', 'msg_other', 'sess_other', 2110, 2110, ${sql(JSON.stringify({ type: "text", text: "Other workspace" }))});`
  ];
  const created = spawnSync("sqlite3", [databasePath], {
    input: statements.join("\n"),
    encoding: "utf8"
  });
  assert.equal(created.status, 0, created.stderr);
  return { databasePath, repo, otherRepo };
}

function readJsonl(sourcePath) {
  return fs
    .readFileSync(sourcePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function createSqliteWrapper(root, body) {
  const wrapperPath = path.join(root, "sqlite3-wrapper");
  const sqlitePath = spawnSync("which", ["sqlite3"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh\n${body}\nexec ${JSON.stringify(sqlitePath)} "$@"\n`,
    { encoding: "utf8", mode: 0o700 }
  );
  return wrapperPath;
}

test("exports the current ZCode session as deterministic visible Claude JSONL", () => {
  const root = makeTempDir();
  const outputDir = path.join(root, "exports");
  const fixture = createDatabase(root);
  const options = {
    databasePath: fixture.databasePath,
    outputDir,
    env: {
      ZCODE_SESSION_ID: "sess_current"
    }
  };

  const databaseBefore = fs.readFileSync(fixture.databasePath);
  const first = exportZCodeSession(fixture.repo, options);
  const firstContent = fs.readFileSync(first.sourcePath, "utf8");
  const second = exportZCodeSession(fixture.repo, options);
  const entries = readJsonl(second.sourcePath);

  assert.equal(first.sessionId, "sess_current");
  assert.equal(first.messageCount, 3);
  assert.equal(firstContent, fs.readFileSync(second.sourcePath, "utf8"));
  assert.equal(entries[0].type, "custom-title");
  assert.equal(entries[0].customTitle, "Current session");
  assert.deepEqual(
    entries.slice(1).map((entry) => [entry.type, entry.message.role, entry.message.content]),
    [
      ["user", "user", "First request"],
      ["assistant", "assistant", "First answer"],
      ["user", "user", "Second\nrequest"]
    ]
  );
  assert.equal(entries.some((entry) => JSON.stringify(entry).includes("private reasoning")), false);
  assert.equal(entries.some((entry) => JSON.stringify(entry).includes("Read")), false);
  assert.equal(new Set(entries.slice(1).map((entry) => entry.uuid)).size, 3);
  assert.equal(entries.slice(1).every((entry) => entry.sessionId === "sess_current"), true);
  assert.deepEqual(fs.readFileSync(fixture.databasePath), databaseBefore);
});

test("preserves visible text whitespace", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const padded = "  indented text\n";
  const updated = spawnSync(
    "sqlite3",
    [fixture.databasePath, `UPDATE part SET data = ${sql(JSON.stringify({ type: "text", text: padded }))} WHERE id = 'part_u1';`],
    { encoding: "utf8" }
  );
  assert.equal(updated.status, 0, updated.stderr);

  const exported = exportZCodeSession(fixture.repo, {
    sessionId: "sess_current",
    databasePath: fixture.databasePath,
    outputDir: path.join(root, "exports")
  });
  assert.equal(readJsonl(exported.sourcePath)[1].message.content, padded);
});

test("parses each supported ZCode transfer source syntax", () => {
  assert.deepEqual(parseZCodeSessionSource("sess_123"), {
    sessionId: "sess_123"
  });
  assert.deepEqual(parseZCodeSessionSource("/tmp/zcode.sqlite"), {
    databasePath: "/tmp/zcode.sqlite"
  });
  assert.deepEqual(parseZCodeSessionSource("/tmp/zcode.sqlite#sess_123"), {
    databasePath: "/tmp/zcode.sqlite",
    sessionId: "sess_123"
  });
});

test("rejects an implicit current session from another workspace", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        databasePath: fixture.databasePath,
        outputDir: path.join(root, "exports"),
        env: {
          ZCODE_SESSION_ID: "sess_other"
        }
      }),
    /belongs to a different workspace/i
  );
});

test("allows an explicitly selected ZCode session from another workspace", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const exported = exportZCodeSession(fixture.repo, {
    sessionId: "sess_other",
    databasePath: fixture.databasePath,
    outputDir: path.join(root, "exports")
  });

  assert.equal(exported.sessionId, "sess_other");
  assert.equal(exported.messageCount, 1);
  assert.match(fs.readFileSync(exported.sourcePath, "utf8"), /Other workspace/);
});

test("paginates visible message parts without changing their order", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const queryLog = path.join(root, "query.log");
  const sqliteCommand = createSqliteWrapper(
    root,
    `printf 'query\\n' >> ${JSON.stringify(queryLog)}`
  );
  const statements = [];
  for (let index = 0; index < 550; index += 1) {
    statements.push(
      `INSERT INTO part VALUES ('part_many_${String(index).padStart(4, "0")}', 'msg_u2', 'sess_current', ${1400 + index}, ${1400 + index}, ${sql(JSON.stringify({ type: "text", text: `part-${index}` }))});`
    );
  }
  const inserted = spawnSync("sqlite3", [fixture.databasePath], {
    input: statements.join("\n"),
    encoding: "utf8"
  });
  assert.equal(inserted.status, 0, inserted.stderr);

  const exported = exportZCodeSession(fixture.repo, {
    sessionId: "sess_current",
    databasePath: fixture.databasePath,
    outputDir: path.join(root, "exports"),
    sqliteCommand,
    pageSize: 100
  });
  const finalMessage = readJsonl(exported.sourcePath).at(-1).message.content;
  assert.match(finalMessage, /^Second\nrequest\npart-0\npart-1/);
  assert.match(finalMessage, /part-548\npart-549$/);
  assert.equal(fs.readFileSync(queryLog, "utf8").trim().split("\n").length >= 7, true);
});

test("rejects a transcript that exceeds the configured visible-text limit", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        sessionId: "sess_current",
        databasePath: fixture.databasePath,
        outputDir: path.join(root, "exports"),
        maxTranscriptBytes: 10
      }),
    /too large/i
  );
});

test("times out a stalled sqlite query with an actionable error", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const sqliteCommand = createSqliteWrapper(root, "sleep 1");

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        sessionId: "sess_current",
        databasePath: fixture.databasePath,
        outputDir: path.join(root, "exports"),
        sqliteCommand,
        queryTimeoutMs: 25
      }),
    /timed out/i
  );
});

test("enforces an overall export deadline across paginated queries", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const sqliteCommand = createSqliteWrapper(root, "sleep 0.02");

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        sessionId: "sess_current",
        databasePath: fixture.databasePath,
        outputDir: path.join(root, "exports"),
        sqliteCommand,
        pageSize: 1,
        queryTimeoutMs: 1_000,
        exportTimeoutMs: 50
      }),
    /deadline|timed out/i
  );
});

test("counts blank text parts toward the row safety limit", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);
  const statements = Array.from(
    { length: 10 },
    (_, index) =>
      `INSERT INTO part VALUES ('part_blank_${index}', 'msg_u2', 'sess_current', ${2000 + index}, ${2000 + index}, ${sql(JSON.stringify({ type: "text", text: " " }))});`
  );
  const inserted = spawnSync("sqlite3", [fixture.databasePath], {
    input: statements.join("\n"),
    encoding: "utf8"
  });
  assert.equal(inserted.status, 0, inserted.stderr);

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        sessionId: "sess_current",
        databasePath: fixture.databasePath,
        outputDir: path.join(root, "exports"),
        maxPartRows: 8
      }),
    /too many|row limit/i
  );
});

test("cleans a private import stage when transcript writing fails", () => {
  const root = makeTempDir();
  const fixture = createDatabase(root);

  assert.throws(
    () =>
      exportZCodeSession(fixture.repo, {
        sessionId: "sess_current",
        databasePath: fixture.databasePath,
        tempDir: root,
        writeTranscript() {
          throw new Error("synthetic write failure");
        }
      }),
    /synthetic write failure/
  );
  assert.deepEqual(
    fs.readdirSync(root).filter((entry) => entry.startsWith("codex-zcode-transfer-")),
    []
  );
});

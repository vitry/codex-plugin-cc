import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DATABASE_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const SESSION_ID_PATTERN = /^sess_[a-zA-Z0-9_-]+$/;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PART_ROWS = 20_000;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return path.resolve(cwd, value);
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function queryDatabase(databasePath, query, options = {}) {
  const result = spawnSync(
    options.sqliteCommand ?? "sqlite3",
    ["-readonly", "-json", databasePath, query],
    {
    encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
    }
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("ZCode session transfer requires the sqlite3 command.");
  }
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `Timed out while reading the ZCode session database after ${options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS} ms.`
    );
  }
  if (result.error?.code === "ENOBUFS") {
    throw new Error(
      "A ZCode session database query returned too much data. Transfer a smaller session or reduce the size of individual messages."
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not read the ZCode session database: ${String(result.stderr || "").trim() || `sqlite3 exited with ${result.status}`}`
    );
  }
  const output = String(result.stdout ?? "").trim();
  if (!output) {
    return [];
  }
  try {
    return JSON.parse(output);
  } catch (cause) {
    throw new Error("sqlite3 returned invalid JSON for the ZCode session database.", {
      cause
    });
  }
}

function stableUuid(sessionId, value) {
  const hex = crypto.createHash("sha256").update(`${sessionId}:${value}`).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20)
  ].join("-");
}

function isoTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : new Date(0).toISOString();
}

function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

function boundedQueryOptions(options, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("ZCode session export exceeded its overall deadline.");
  }
  return {
    ...options,
    queryTimeoutMs: Math.min(
      options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      remainingMs
    )
  };
}

function readSession(databasePath, sessionId, options, deadline) {
  const sessions = queryDatabase(
    databasePath,
    [
      "SELECT id, directory, title, time_created, time_updated",
      "FROM session",
      `WHERE id = ${sqlText(sessionId)}`,
      "LIMIT 1;"
    ].join(" "),
    boundedQueryOptions(options, deadline)
  );
  if (sessions.length === 0) {
    throw new Error(`ZCode session not found: ${sessionId}`);
  }
  return sessions[0];
}

function readVisibleMessages(databasePath, sessionId, options, deadline) {
  const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0
    ? Math.min(options.pageSize, 1_000)
    : DEFAULT_PAGE_SIZE;
  const maxTranscriptBytes =
    Number.isInteger(options.maxTranscriptBytes) && options.maxTranscriptBytes > 0
      ? options.maxTranscriptBytes
      : DEFAULT_MAX_TRANSCRIPT_BYTES;
  const maxPartRows =
    Number.isInteger(options.maxPartRows) && options.maxPartRows > 0
      ? options.maxPartRows
      : DEFAULT_MAX_PART_ROWS;
  const messages = [];
  let cursor = null;
  let partRows = 0;
  let transcriptBytes = 0;

  while (true) {
    const cursorFilter = cursor
      ? [
          "AND (m.time_created, m.id, p.time_created, p.id) >",
          `(${Number(cursor.message_time)}, ${sqlText(cursor.message_id)},`,
          `${Number(cursor.part_time)}, ${sqlText(cursor.part_id)})`
        ].join(" ")
      : "";
    const rows = queryDatabase(
      databasePath,
      [
        "SELECT m.id AS message_id, m.time_created AS message_time,",
        "json_extract(m.data, '$.role') AS role,",
        "p.id AS part_id, p.time_created AS part_time,",
        "json_extract(p.data, '$.text') AS text",
        "FROM message m",
        "JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id",
        `WHERE m.session_id = ${sqlText(sessionId)}`,
        "AND json_extract(m.data, '$.role') IN ('user', 'assistant')",
        "AND json_extract(p.data, '$.type') = 'text'",
        cursorFilter,
        "ORDER BY m.time_created, m.id, p.time_created, p.id",
        `LIMIT ${pageSize};`
      ].join(" "),
      boundedQueryOptions(options, deadline)
    );

    partRows += rows.length;
    if (partRows > maxPartRows) {
      throw new Error(
        `ZCode session ${sessionId} has too many visible text rows to transfer safely (row limit ${maxPartRows}).`
      );
    }
    for (const row of rows) {
      const text = typeof row.text === "string" ? row.text : "";
      if (!text.trim()) {
        continue;
      }
      transcriptBytes += Buffer.byteLength(text, "utf8");
      if (transcriptBytes > maxTranscriptBytes) {
        throw new Error(
          `ZCode session ${sessionId} is too large to transfer safely (visible text exceeds ${maxTranscriptBytes} bytes).`
        );
      }
      const previous = messages.at(-1);
      if (previous?.id === row.message_id) {
        previous.parts.push(text);
        continue;
      }
      messages.push({
        id: row.message_id,
        role: row.role,
        timeCreated: row.message_time,
        parts: [text]
      });
    }

    if (rows.length < pageSize) {
      break;
    }
    cursor = rows.at(-1);
  }
  return messages;
}

function buildTranscript(session, messages) {
  const entries = [
    {
      type: "custom-title",
      customTitle: session.title || "Imported ZCode session",
      sessionId: session.id
    }
  ];
  let parentUuid = null;

  for (const message of messages) {
    const uuid = stableUuid(session.id, message.id);
    entries.push({
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: session.directory,
      sessionId: session.id,
      version: "zcode",
      type: message.role,
      uuid,
      timestamp: isoTimestamp(message.timeCreated),
      message: {
        role: message.role,
        content: message.parts.join("\n")
      }
    });
    parentUuid = uuid;
  }

  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function parseZCodeSessionSource(source) {
  const value = String(source ?? "").trim();
  if (!value) {
    return {};
  }
  if (value.startsWith("sess_")) {
    return { sessionId: value };
  }
  const separator = value.lastIndexOf("#");
  if (separator > 0 && value.slice(separator + 1).startsWith("sess_")) {
    return {
      databasePath: value.slice(0, separator),
      sessionId: value.slice(separator + 1)
    };
  }
  return { databasePath: value };
}

function createImportStage(tempDir = os.tmpdir()) {
  const cleanupRoot = fs.mkdtempSync(path.join(tempDir, "codex-zcode-transfer-"));
  try {
    fs.chmodSync(cleanupRoot, 0o700);
    const importHome = path.join(cleanupRoot, "home");
    const outputDir = path.join(importHome, ".claude", "projects", "zcode");
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    for (const directory of [
      importHome,
      path.join(importHome, ".claude"),
      path.join(importHome, ".claude", "projects"),
      outputDir
    ]) {
      fs.chmodSync(directory, 0o700);
    }
    return { cleanupRoot, importHome, outputDir };
  } catch (error) {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

export function exportZCodeSession(cwd, options = {}) {
  const exportTimeoutMs =
    Number.isInteger(options.exportTimeoutMs) && options.exportTimeoutMs > 0
      ? options.exportTimeoutMs
      : DEFAULT_EXPORT_TIMEOUT_MS;
  const deadline = Date.now() + exportTimeoutMs;
  const env = options.env ?? process.env;
  const explicitSession = typeof options.sessionId === "string" && options.sessionId.trim();
  const sessionId = explicitSession
    ? options.sessionId.trim()
    : (env.CODEX_COMPANION_SESSION_ID ?? env.ZCODE_SESSION_ID)?.trim();
  if (!sessionId) {
    throw new Error("Could not identify the current ZCode session.");
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ZCode session id: ${sessionId}`);
  }

  const requestedDatabase =
    options.databasePath ??
    env.ZCODE_SESSION_DB_PATH ??
    env.ZCODE_SESSION_DB ??
    DEFAULT_DATABASE_PATH;
  const databasePath = fs.realpathSync(resolveUserPath(cwd, requestedDatabase));
  const session = readSession(databasePath, sessionId, options, deadline);
  if (!explicitSession) {
    const workspace = fs.realpathSync(cwd);
    const sessionWorkspace = fs.realpathSync(session.directory);
    if (workspace !== sessionWorkspace) {
      throw new Error(
        `ZCode session ${sessionId} belongs to a different workspace: ${session.directory}`
      );
    }
  }

  const messages = readVisibleMessages(databasePath, sessionId, options, deadline);
  if (messages.length === 0) {
    throw new Error(`ZCode session ${sessionId} has no visible user or assistant messages.`);
  }
  let stage = null;
  try {
    stage = options.outputDir ? null : createImportStage(options.tempDir);
    const outputDir = stage?.outputDir ?? resolveUserPath(cwd, options.outputDir);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const outputDirectory = fs.lstatSync(outputDir);
    if (!outputDirectory.isDirectory() || outputDirectory.isSymbolicLink()) {
      throw new Error("The ZCode session export path must be a private directory.");
    }
    fs.chmodSync(outputDir, 0o700);
    const sourcePath = path.join(outputDir, `${sessionId}.jsonl`);
    (options.writeTranscript ?? atomicWrite)(sourcePath, buildTranscript(session, messages));

    return {
      sourcePath,
      sessionId,
      cwd: session.directory,
      messageCount: messages.length,
      importHome: stage?.importHome ?? null,
      cleanupRoot: stage?.cleanupRoot ?? null
    };
  } catch (error) {
    if (stage?.cleanupRoot) {
      fs.rmSync(stage.cleanupRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

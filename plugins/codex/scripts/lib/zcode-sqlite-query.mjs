#!/usr/bin/env node

import process from "node:process";

async function main() {
  const [databasePath, query] = process.argv.slice(2);
  if (!databasePath || !query) {
    throw new Error("Usage: zcode-sqlite-query.mjs <database-path> <query>");
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, {
    open: true,
    readOnly: true,
    allowExtension: false
  });
  try {
    process.stdout.write(`${JSON.stringify(database.prepare(query).all())}\n`);
  } finally {
    database.close();
  }
}

try {
  await main();
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

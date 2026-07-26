#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  COMPANION_COMMANDS,
  runCompanion
} from "./lib/companion-runner.mjs";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_ACTIVE_CALLS = 4;
const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const manifest = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../../../.zcode-plugin/plugin.json", import.meta.url)),
    "utf8"
  )
);
const activeCalls = new Map();

const TOOL = {
  name: "companion",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        enum: COMPANION_COMMANDS
      },
      arguments: {
        type: "string"
      }
    },
    required: ["command"]
  }
};

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result(id, value) {
  send({
    jsonrpc: "2.0",
    id,
    result: value
  });
}

function error(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function toolError(id, message) {
  result(id, {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true
  });
}

function abortActiveCall(requestId) {
  activeCalls.get(requestId)?.abort();
}

function abortAllCalls() {
  for (const controller of activeCalls.values()) {
    controller.abort();
  }
}

async function callTool(id, params) {
  if (params?.name !== "companion") {
    error(id, -32602, `Invalid params: unknown tool ${params?.name ?? ""}`);
    return;
  }
  if (activeCalls.size >= MAX_ACTIVE_CALLS) {
    toolError(id, `Too many concurrent companion calls; limit is ${MAX_ACTIVE_CALLS}.`);
    return;
  }

  const controller = new AbortController();
  activeCalls.set(id, controller);
  try {
    const child = await runCompanion(params.arguments, {
      signal: controller.signal
    });
    const text =
      child.code === 0
        ? child.stdout
        : child.stderr || child.stdout || `Companion command exited with code ${child.code}.`;
    result(id, {
      content: [
        {
          type: "text",
          text
        }
      ],
      ...(child.code === 0 ? {} : { isError: true })
    });
  } catch (cause) {
    toolError(id, cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (activeCalls.get(id) === controller) {
      activeCalls.delete(id);
    }
  }
}

async function handleMessage(message) {
  if (message == null || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    error(message?.id ?? null, -32600, "Invalid Request");
    return;
  }

  const isNotification = !Object.hasOwn(message, "id");
  if (isNotification) {
    if (message.method === "notifications/cancelled") {
      abortActiveCall(message.params?.requestId);
    }
    return;
  }

  if (activeCalls.has(message.id)) {
    error(message.id, -32600, "Invalid Request: duplicate active request id");
    return;
  }

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "codex-companion-zcode",
          version: manifest.version
        }
      });
      break;
    case "ping":
      result(message.id, {});
      break;
    case "tools/list":
      result(message.id, { tools: [TOOL] });
      break;
    case "tools/call":
      await callTool(message.id, message.params);
      break;
    default:
      error(message.id, -32601, `Method not found: ${message.method}`);
  }
}

let lineChunks = [];
let lineBytes = 0;
let droppingOversizedLine = false;

function resetLine() {
  lineChunks = [];
  lineBytes = 0;
}

function parseLine() {
  const line = Buffer.concat(lineChunks, lineBytes).toString("utf8").replace(/\r$/, "");
  resetLine();
  if (!line) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    error(null, -32700, "Parse error");
    return;
  }

  void handleMessage(message).catch((cause) => {
    error(message?.id ?? null, -32603, cause instanceof Error ? cause.message : String(cause));
  });
}

function rejectOversizedLine() {
  resetLine();
  droppingOversizedLine = true;
  error(null, -32700, "Parse error");
}

process.stdin.on("data", (chunk) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let start = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }

    const segment = buffer.subarray(start, index);
    if (droppingOversizedLine) {
      droppingOversizedLine = false;
    } else if (lineBytes + segment.length > MAX_NDJSON_LINE_BYTES) {
      rejectOversizedLine();
      droppingOversizedLine = false;
    } else {
      lineChunks.push(segment);
      lineBytes += segment.length;
      parseLine();
    }
    start = index + 1;
  }

  const remainder = buffer.subarray(start);
  if (droppingOversizedLine || remainder.length === 0) {
    return;
  }
  if (lineBytes + remainder.length > MAX_NDJSON_LINE_BYTES) {
    rejectOversizedLine();
    return;
  }
  lineChunks.push(remainder);
  lineBytes += remainder.length;
});

process.stdin.on("end", () => {
  if (!droppingOversizedLine && lineBytes > 0) {
    parseLine();
  }
  abortAllCalls();
});

function shutdown() {
  abortAllCalls();
  process.stdin.destroy();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

#!/usr/bin/env node

import readline from "node:readline";

import {
  COMPANION_COMMANDS,
  runCompanion
} from "./lib/companion-runner.mjs";

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

async function callTool(id, params) {
  if (params?.name !== "companion") {
    toolError(id, `Unknown tool: ${params?.name ?? ""}`);
    return;
  }

  try {
    const child = await runCompanion(params.arguments);
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
  }
}

async function handleMessage(message) {
  if (message == null || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    error(message?.id ?? null, -32600, "Invalid Request");
    return;
  }

  if (message.method === "notifications/initialized") {
    return;
  }

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "codex-companion-zcode",
          version: "1.0.0"
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

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

lines.on("line", (line) => {
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
});

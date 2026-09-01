/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession, loadReusableBrokerSession } from "./broker-lifecycle.mjs";
import { resolveHostClientInfo } from "./host.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_INSTANCE_ID_ENV = "CODEX_COMPANION_APP_SERVER_INSTANCE_ID";
export const APP_SERVER_MODE_ENV = "CODEX_COMPANION_APP_SERVER_MODE";
export const BROKER_BUSY_RPC_CODE = -32001;

/** @returns {ClientInfo} */
function resolveClientInfo(env) {
  return {
    ...resolveHostClientInfo(env),
    version: PLUGIN_MANIFEST.version ?? "0.0.0"
  };
}

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  async waitForExit(timeoutMs = 1000) {
    if (this.exitResolved) {
      return true;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      void this.exitPromise.then(() => finish(true));
    });
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    this.sendMessage({
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? resolveClientInfo(this.options.env ?? process.env),
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(options = {}) {
    const timeoutMs = Math.max(100, options.timeoutMs ?? 1000);
    if (this.closed) {
      await this.waitForExit(timeoutMs + 100);
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    let terminateTimer = null;
    let forceTimer = null;
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      terminateTimer = setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, Math.min(50, Math.floor(timeoutMs / 2)));
      terminateTimer.unref?.();
      forceTimer = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          try {
            this.proc.kill("SIGKILL");
          } catch {
            // The process may have exited between the check and signal.
          }
        }
      }, timeoutMs);
      forceTimer.unref?.();
    }

    await this.waitForExit(timeoutMs + 100);
    if (terminateTimer) {
      clearTimeout(terminateTimer);
    }
    if (forceTimer) {
      clearTimeout(forceTimer);
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    const initialized = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? resolveClientInfo(this.options.env ?? process.env),
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    const actualInstanceId =
      /** @type {{ brokerInstanceId?: string }} */ (initialized).brokerInstanceId;
    if (
      !this.options.brokerInstanceId ||
      actualInstanceId !== this.options.brokerInstanceId
    ) {
      this.socket.destroy();
      throw new Error("Codex app-server broker instance mismatch.");
    }
    this.notify("initialized", {});
  }

  async close(options = {}) {
    const timeoutMs = Math.max(100, options.timeoutMs ?? 1000);
    if (this.closed) {
      await this.waitForExit(timeoutMs);
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    const exited = await this.waitForExit(timeoutMs);
    if (!exited) {
      this.socket?.destroy();
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    let brokerInstanceId = null;
    const appServerMode = options.env?.[APP_SERVER_MODE_ENV] ?? process.env[APP_SERVER_MODE_ENV];
    if (!options.disableBroker && appServerMode !== "direct") {
      if (options.brokerEndpoint && !options.brokerInstanceId) {
        throw new Error(
          "A broker instance identity is required with an explicit broker endpoint."
        );
      }
      const envEndpoint =
        options.env?.[BROKER_ENDPOINT_ENV] ??
        process.env[BROKER_ENDPOINT_ENV] ??
        null;
      const envInstanceId =
        options.env?.[BROKER_INSTANCE_ID_ENV] ??
        process.env[BROKER_INSTANCE_ID_ENV] ??
        null;
      brokerEndpoint = options.brokerEndpoint ?? envEndpoint;
      brokerInstanceId = options.brokerInstanceId ?? envInstanceId;
      if (brokerEndpoint && !brokerInstanceId) {
        brokerEndpoint = null;
      }
      if (!brokerEndpoint && options.reuseExistingBrokerIfFresh) {
        // Auth-status style lookups: reuse only while the broker's login
        // still matches the codex auth file, and never create a broker.
        const brokerSession = loadReusableBrokerSession(cwd, { env: options.env });
        if (
          typeof brokerSession?.instanceId === "string" &&
          brokerSession.instanceId
        ) {
          brokerEndpoint = brokerSession.endpoint ?? null;
          brokerInstanceId = brokerSession.instanceId;
        }
      }
      if (!brokerEndpoint && options.reuseExistingBroker) {
        // Interrupt style lookups must reach the recorded broker even when
        // its login is stale, because the turn being interrupted lives there.
        const brokerSession = loadBrokerSession(cwd);
        if (
          typeof brokerSession?.instanceId === "string" &&
          brokerSession.instanceId
        ) {
          brokerEndpoint = brokerSession.endpoint ?? null;
          brokerInstanceId = brokerSession.instanceId;
        }
      }
      if (
        !brokerEndpoint &&
        !options.reuseExistingBroker &&
        !options.reuseExistingBrokerIfFresh
      ) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
        brokerInstanceId = brokerSession?.instanceId ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, {
          ...options,
          brokerEndpoint,
          brokerInstanceId
        })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}

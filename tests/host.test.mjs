import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveHost,
  resolveHostClientInfo,
  resolveHostPluginDataDir,
  resolveHostSessionId
} from "../plugins/codex/scripts/lib/host.mjs";

test("resolveHost returns ZCode metadata and paths", () => {
  assert.deepEqual(
    resolveHost({
      ZCODE_PLUGIN_ROOT: "/plugin",
      ZCODE_PLUGIN_DATA: "/data",
      ZCODE_PROJECT_DIR: "/repo",
      ZCODE_SESSION_ID: "sess_z"
    }),
    {
      kind: "zcode",
      displayName: "ZCode",
      serviceName: "zcode_codex_plugin",
      pluginRoot: "/plugin",
      pluginDataDir: "/data",
      projectDir: "/repo",
      sessionId: "sess_z"
    }
  );
});

test("resolveHost defaults to Claude Code metadata and cwd", () => {
  assert.deepEqual(resolveHost({}, "/fallback"), {
    kind: "claude",
    displayName: "Claude Code",
    serviceName: "claude_code_codex_plugin",
    pluginRoot: undefined,
    pluginDataDir: undefined,
    projectDir: "/fallback",
    sessionId: undefined
  });
});

test("explicit host kind overrides ZCode host variable detection", () => {
  assert.equal(resolveHost({ CODEX_COMPANION_HOST: "claude", ZCODE_SESSION_ID: "sess_z" }).kind, "claude");
  assert.equal(resolveHost({ CODEX_COMPANION_HOST: "zcode", CLAUDE_SESSION_ID: "sess_c" }).kind, "zcode");
});

test("presence of any ZCode host variable selects ZCode", () => {
  assert.equal(resolveHost({ ZCODE_PLUGIN_ROOT: "" }).kind, "zcode");
});

test("resolveHost applies root, data, project, and session precedence", () => {
  const host = resolveHost(
    {
      CODEX_COMPANION_PLUGIN_ROOT: "/companion-plugin",
      ZCODE_PLUGIN_ROOT: "/zcode-plugin",
      CLAUDE_PLUGIN_ROOT: "/claude-plugin",
      ZCODE_PLUGIN_DATA: "/zcode-data",
      CLAUDE_PLUGIN_DATA: "/claude-data",
      ZCODE_PROJECT_DIR: "/zcode-project",
      CLAUDE_PROJECT_DIR: "/claude-project",
      CODEX_COMPANION_SESSION_ID: "sess_companion",
      ZCODE_SESSION_ID: "sess_z",
      CLAUDE_SESSION_ID: "sess_c",
      CLAUDE_CODE_SESSION_ID: "sess_cc"
    },
    "/fallback"
  );

  assert.equal(host.pluginRoot, "/companion-plugin");
  assert.equal(host.pluginDataDir, "/zcode-data");
  assert.equal(host.projectDir, "/zcode-project");
  assert.equal(host.sessionId, "sess_companion");
});

test("host value helpers retain Claude compatibility", () => {
  const env = {
    CLAUDE_PLUGIN_DATA: "/claude-data",
    CLAUDE_CODE_SESSION_ID: "sess_cc"
  };

  assert.equal(resolveHostPluginDataDir(env), "/claude-data");
  assert.equal(resolveHostSessionId(env), "sess_cc");
  assert.deepEqual(resolveHostClientInfo(env), {
    title: "Codex Plugin",
    name: "Claude Code"
  });
});

test("resolveHostClientInfo uses the selected host display name", () => {
  assert.deepEqual(resolveHostClientInfo({ ZCODE_PROJECT_DIR: "/repo" }), {
    title: "Codex Plugin",
    name: "ZCode"
  });
});

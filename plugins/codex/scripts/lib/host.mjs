const HOSTS = {
  zcode: {
    displayName: "ZCode",
    serviceName: "zcode_codex_plugin"
  },
  claude: {
    displayName: "Claude Code",
    serviceName: "claude_code_codex_plugin"
  }
};

function firstValue(env, names) {
  for (const name of names) {
    if (typeof env[name] === "string" && env[name].trim()) {
      return env[name];
    }
  }
  return undefined;
}

function resolveHostKind(env) {
  const explicitHost = typeof env.CODEX_COMPANION_HOST === "string" ? env.CODEX_COMPANION_HOST.trim() : "";
  if (explicitHost === "zcode" || explicitHost === "claude") {
    return explicitHost;
  }
  return Object.entries(env).some(
    ([name, value]) => name.startsWith("ZCODE_") && typeof value === "string" && value.trim()
  )
    ? "zcode"
    : "claude";
}

export function resolveHostSessionId(env = process.env) {
  return firstValue(env, [
    "CODEX_COMPANION_SESSION_ID",
    "ZCODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID"
  ]);
}

export function resolveHostPluginDataDir(env = process.env) {
  return firstValue(env, ["ZCODE_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"]);
}

export function resolveHost(env = process.env, cwd = process.cwd()) {
  const kind = resolveHostKind(env);
  return {
    kind,
    ...HOSTS[kind],
    pluginRoot: firstValue(env, ["CODEX_COMPANION_PLUGIN_ROOT", "ZCODE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]),
    pluginDataDir: resolveHostPluginDataDir(env),
    projectDir: firstValue(env, ["ZCODE_PROJECT_DIR", "CLAUDE_PROJECT_DIR"]) ?? cwd,
    sessionId: resolveHostSessionId(env)
  };
}

export function resolveHostClientInfo(env = process.env) {
  return {
    title: "Codex Plugin",
    name: resolveHost(env).displayName
  };
}

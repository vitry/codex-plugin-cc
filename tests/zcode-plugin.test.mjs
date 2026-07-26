import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESCRIPTION = "Use Codex from ZCode to review code or delegate tasks.";
const COMMAND_NAMES = [
  "adversarial-review",
  "cancel",
  "rescue",
  "result",
  "review",
  "setup",
  "status",
  "transfer"
];
const COMMAND_FRONTMATTER = new Set([
  "allowed-tools",
  "argument-hint",
  "description",
  "disable-noninteractive",
  "model",
  "skills"
]);
const COMMAND_MAPPING = {
  "adversarial-review": "adversarial-review",
  cancel: "cancel",
  rescue: "task",
  result: "result",
  review: "review",
  setup: "setup",
  status: "status",
  transfer: "transfer"
};

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function commandSource(name) {
  return read(`plugins/zcode/commands/${name}.md`);
}

function frontmatterEntries(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "Markdown must start with frontmatter");

  return match[1].split("\n").map((line) => {
    const entry = line.match(/^([a-z][a-z-]*):\s+(\S.*)$/);
    assert.ok(entry, `frontmatter must be flat: ${line}`);
    return {
      key: entry[1],
      value: entry[2]
    };
  });
}

test("ZCode manifest defines the independent Codex plugin", () => {
  const packageJson = readJson("package.json");
  const manifest = readJson(".zcode-plugin/plugin.json");
  const hooks = readJson("plugins/zcode/hooks/hooks.json");

  assert.deepEqual(manifest, {
    name: "codex",
    version: packageJson.version,
    description: DESCRIPTION,
    author: {
      name: "OpenAI"
    },
    license: "Apache-2.0",
    commands: "plugins/zcode/commands",
    agents: "plugins/zcode/agents",
    skills: "plugins/codex/skills",
    hooks: "plugins/zcode/hooks/hooks.json",
    mcpServers: {
      codex: {
        command: "node",
        args: ["${ZCODE_PLUGIN_ROOT}/plugins/zcode/scripts/mcp-server.mjs"],
        cwd: "${ZCODE_PROJECT_DIR}",
        env: {
          CODEX_COMPANION_HOST: "zcode",
          CODEX_COMPANION_PLUGIN_ROOT: "${ZCODE_PLUGIN_ROOT}",
          ZCODE_PLUGIN_DATA: "${ZCODE_PLUGIN_DATA}",
          ZCODE_PROJECT_DIR: "${ZCODE_PROJECT_DIR}"
        }
      }
    }
  });
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "SessionStart", "Stop"]);
  for (const event of Object.values(hooks.hooks)) {
    assert.equal(event.length, 1);
    assert.equal(event[0].hooks.length, 1);
    const hook = event[0].hooks[0];
    assert.equal(hook.type, "process");
    assert.equal(hook.command, "node");
    assert.ok(Array.isArray(hook.args));
    assert.match(hook.args.join(" "), /\$\{ZCODE_PLUGIN_ROOT\}/);
    assert.equal(Number.isInteger(hook.timeoutMs), true);
    assert.equal(Object.hasOwn(hook, "timeout"), false);
  }
  assert.equal(hooks.hooks.PreToolUse[0].matcher, "mcp__codex__companion");
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeoutMs, 960000);
  const stopWrapper = read("plugins/zcode/scripts/stop-review-gate-hook.mjs");
  assert.match(stopWrapper, /WRAPPER_TIMEOUT_MS\s*=\s*930000/);
  assert.match(read("plugins/codex/scripts/stop-review-gate-hook.mjs"), /15 \* 60 \* 1000/);
});

test("ZCode marketplace exposes one repository-root plugin", () => {
  const manifest = readJson(".zcode-plugin/plugin.json");
  const marketplace = readJson("marketplace.json");

  assert.equal(fs.existsSync(path.join(ROOT, ".zcode-plugin", "marketplace.json")), false);
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: "codex",
    version: manifest.version,
    description: DESCRIPTION,
    author: {
      name: "OpenAI"
    },
    source: "."
  });
});

test("ZCode exposes the exact static command set with recognized frontmatter", () => {
  const commandsRoot = path.join(ROOT, "plugins", "zcode", "commands");
  const commandNames = fs
    .readdirSync(commandsRoot)
    .filter((file) => file.endsWith(".md"))
    .map((file) => path.basename(file, ".md"))
    .sort();

  assert.deepEqual(commandNames, COMMAND_NAMES);

  for (const commandName of commandNames) {
    const source = commandSource(commandName);
    const frontmatter = frontmatterEntries(source);

    for (const { key } of frontmatter) {
      assert.ok(COMMAND_FRONTMATTER.has(key), `${commandName}.md uses recognized frontmatter`);
    }
    assert.ok(frontmatter.some(({ key }) => key === "description"), `${commandName}.md has a description`);
    assert.ok(frontmatter.some(({ key }) => key === "argument-hint"), `${commandName}.md has an argument hint`);
    assert.ok(frontmatter.some(({ key }) => key === "allowed-tools"), `${commandName}.md limits tools`);
    assert.match(source, /\$ARGUMENTS/, `${commandName}.md forwards command arguments`);
    assert.match(source, /\bmcp__codex__companion\b/, `${commandName}.md names the companion MCP tool`);
    assert.match(
      source,
      new RegExp(`"command"\\s*:\\s*"${COMMAND_MAPPING[commandName]}"`),
      `${commandName}.md maps to the expected companion command`
    );
    assert.doesNotMatch(source, /\$\{[^}]+\}/, `${commandName}.md must not use runtime paths`);
    assert.doesNotMatch(source, /\b(?:CLAUDE|ZCODE)_PLUGIN_ROOT\b/, `${commandName}.md must not name runtime roots`);
    assert.doesNotMatch(source, /\bcodex-companion\.mjs\b/, `${commandName}.md must not embed a node path`);
    assert.doesNotMatch(source, /(?:^|\s)node(?:\s|$)/m, `${commandName}.md must not invoke node`);
    assert.doesNotMatch(source, /(?:^|\s)npm\s+(?:install|i)\b/m, `${commandName}.md must not invoke npm`);
    assert.doesNotMatch(source, /!`|^```!|\$\(|`[^`\n]*(?:node|npm|git)\s/mi, `${commandName}.md must not embed shell`);
  }
});

test("ZCode setup uses companion JSON output and confirms any global installation", () => {
  const source = commandSource("setup");

  assert.match(source, /"command"\s*:\s*"setup"/);
  assert.match(source, /"arguments"\s*:\s*"--json \$ARGUMENTS"/);
  assert.match(source, /Codex is missing/i);
  assert.match(source, /npm is available/i);
  assert.match(source, /user question/i);
  assert.match(source, /explicit confirmation/i);
  assert.match(source, /global/i);
  assert.match(source, /@openai\/codex/);
  assert.match(source, /codex login/);
});

test("ZCode review commands preserve target, execution, and read-only semantics", () => {
  const review = commandSource("review");
  const adversarial = commandSource("adversarial-review");

  for (const source of [review, adversarial]) {
    assert.match(source, /--wait/);
    assert.match(source, /--background/);
    assert.match(source, /--base <ref>/);
    assert.match(source, /--scope auto\|working-tree\|branch/);
    assert.match(source, /read-only|review-only/i);
    assert.match(source, /Do not (?:fix|edit|modify|apply)/i);
    assert.match(source, /verbatim/i);
    assert.match(source, /working-tree/i);
    assert.match(source, /branch/i);
    assert.match(source, /staged/i);
    assert.match(source, /unstaged/i);
  }

  assert.match(review, /does not accept extra focus text/i);
  assert.match(adversarial, /focus text/i);
  assert.match(adversarial, /implementation approach|design choices/i);
});

test("ZCode rescue delegates routing and runtime controls through its registered agent", () => {
  const manifest = readJson(".zcode-plugin/plugin.json");
  const rescue = commandSource("rescue");
  const agent = read("plugins/zcode/agents/codex-rescue.md");
  const agentFrontmatter = Object.fromEntries(
    frontmatterEntries(agent).map(({ key, value }) => [key, value])
  );

  assert.equal(manifest.agents, "plugins/zcode/agents");
  assert.equal(agentFrontmatter.name, "codex-rescue");
  assert.match(agentFrontmatter.description, /\S/);
  assert.equal(agentFrontmatter.tools, "mcp__codex__companion");
  assert.deepEqual(Object.keys(agentFrontmatter).sort(), ["description", "name", "tools"]);

  assert.match(rescue, /codex:codex-rescue/);
  assert.match(rescue, /--resume/);
  assert.match(rescue, /--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /gpt-5\.3-codex-spark/);
  assert.match(rescue, /verbatim/i);
  assert.match(rescue, /forward `--background`/i);
  assert.doesNotMatch(rescue, /Do not forward either flag/i);

  assert.equal([...agent.matchAll(/\bmcp__codex__companion\b/g)].length, 1);
  assert.match(agent, /exactly one/i);
  assert.match(agent, /"command"\s*:\s*"task"/);
  assert.match(agent, /"arguments"\s*:\s*"--write <forwarded arguments>"/);
  assert.match(agent, /verbatim/i);
  assert.match(agent, /no other tools|do not use any other tool/i);
  assert.doesNotMatch(agent, /\b(?:Read|Glob|Grep|Bash|Agent)\b/);
});

test("ZCode job commands preserve arguments and output contracts", () => {
  const transfer = commandSource("transfer");
  const status = commandSource("status");
  const result = commandSource("result");
  const cancel = commandSource("cancel");

  assert.match(transfer, /\[--source <claude-jsonl>\]/);
  assert.match(transfer, /Claude JSONL transcript/i);
  assert.doesNotMatch(transfer, /current ZCode session/i);
  assert.match(transfer, /Codex session ID/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(transfer, /verbatim|exactly as returned/i);

  assert.match(status, /\[job-id\] \[--wait\] \[--timeout-ms <ms>\] \[--all\]/);
  assert.match(status, /single Markdown table/i);
  assert.match(status, /If .*job ID/i);
  assert.match(status, /full .*output/i);

  assert.match(result, /\[job-id\]/);
  assert.match(result, /complete result payload/i);
  assert.match(result, /Do not summarize|verbatim/i);

  assert.match(cancel, /\[job-id\]/);
  assert.match(cancel, /verbatim/i);
});

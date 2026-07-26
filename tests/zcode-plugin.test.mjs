import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESCRIPTION = "Use Codex from ZCode to review code or delegate tasks.";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test("ZCode manifest defines the independent Codex plugin", () => {
  const packageJson = readJson("package.json");
  const manifest = readJson(".zcode-plugin/plugin.json");

  assert.deepEqual(manifest, {
    name: "codex",
    version: packageJson.version,
    description: DESCRIPTION,
    author: {
      name: "OpenAI"
    },
    license: "Apache-2.0",
    commands: "plugins/zcode/commands",
    skills: "plugins/codex/skills",
    hooks: "plugins/zcode/hooks/hooks.json"
  });
  assert.equal(manifest.version, packageJson.version);
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

test("ZCode commands use static compatible Markdown", () => {
  const commandsRoot = path.join(ROOT, "plugins", "zcode", "commands");
  const commandFiles = fs.readdirSync(commandsRoot).filter((file) => file.endsWith(".md")).sort();

  assert.deepEqual(commandFiles, ["setup.md"]);

  for (const commandFile of commandFiles) {
    const source = fs.readFileSync(path.join(commandsRoot, commandFile), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);

    assert.ok(frontmatter, `${commandFile} must have frontmatter`);
    for (const line of frontmatter[1].split("\n")) {
      assert.match(line, /^[a-z][a-z-]*:\s+\S.*$/, `${commandFile} frontmatter must be flat`);
    }
    assert.match(source, /\$ARGUMENTS/, `${commandFile} must forward command arguments`);
    assert.match(source, /\$\{ZCODE_PLUGIN_ROOT\}/, `${commandFile} must use the ZCode plugin root`);
    assert.doesNotMatch(source, /!`/, `${commandFile} must not use inline dynamic shell`);
    assert.doesNotMatch(source, /^```!/m, `${commandFile} must not use fenced dynamic shell`);
  }
});

test("ZCode setup command guides setup, confirmed installation, and login", () => {
  const source = read("plugins/zcode/commands/setup.md");
  const setupCommand = /node "\$\{ZCODE_PLUGIN_ROOT\}\/plugins\/codex\/scripts\/codex-companion\.mjs" setup --json \$ARGUMENTS/g;

  assert.equal([...source.matchAll(setupCommand)].length, 2);
  assert.match(source, /Codex is missing/i);
  assert.match(source, /npm is available/i);
  assert.match(source, /ask the user/i);
  assert.match(source, /only if the user confirms/i);
  assert.match(source, /npm install -g @openai\/codex/);
  assert.match(source, /codex login/);
});

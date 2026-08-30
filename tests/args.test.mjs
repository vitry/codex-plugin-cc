import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString preserves Windows path separators", () => {
  assert.deepEqual(
    splitRawArgumentString(String.raw`--cwd C:\Users\alice\repo`),
    ["--cwd", String.raw`C:\Users\alice\repo`]
  );
});

test("splitRawArgumentString preserves quoted Windows paths with spaces", () => {
  assert.deepEqual(
    splitRawArgumentString(String.raw`--cwd "C:\Users\Alice Smith\repo"`),
    ["--cwd", String.raw`C:\Users\Alice Smith\repo`]
  );
});

test("splitRawArgumentString still supports escaped whitespace", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd demo\ repo`), ["--cwd", "demo repo"]);
});

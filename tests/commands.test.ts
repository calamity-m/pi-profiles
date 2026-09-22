import assert from "node:assert/strict";
import test from "node:test";
import { completeArguments, parseCommand } from "../src/commands.ts";
import type { ProfileState } from "../src/profiles.ts";

const state: ProfileState = {
  version: 1,
  active: "stable",
  profiles: { stable: { disabled: [] }, small: { disabled: ["/x.ts"], description: "Small" } },
};

test("action suggestions include descriptions and support prefixes", () => {
  assert.equal(completeArguments("")?.length, 4);
  assert.ok(completeArguments("")?.every((item) => item.description));
  assert.deepEqual(
    completeArguments("us")?.map((item) => item.value),
    ["use"],
  );
});
test("profile completions replace full arguments including trailing-space prefixes", () => {
  assert.deepEqual(
    completeArguments("use ", state)?.map((item) => item.value),
    ["use stable", "use small"],
  );
  assert.deepEqual(
    completeArguments("edit st", state)?.map((item) => item.value),
    ["edit stable"],
  );
  assert.equal(completeArguments("use unknown", state), null);
  assert.equal(completeArguments("manage ", state), null);
});
test("empty and incomplete commands open their workflows", () => {
  assert.deepEqual(parseCommand(""), { action: "pick" });
  for (const action of ["use", "edit", "new", "manage"])
    assert.deepEqual(parseCommand(`${action} `), { action });
  assert.deepEqual(parseCommand("use stable"), { action: "use", name: "stable" });
  assert.throws(() => parseCommand("what"), /Use \/profile/);
  assert.throws(() => parseCommand("manage stable"));
  assert.throws(() => parseCommand("use stable extra"));
});

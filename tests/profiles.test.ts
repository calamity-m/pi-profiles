import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  normalizeExclusions,
  reconcileProfile,
  renameProfile,
  validateName,
  validateState,
  type ProfileState,
} from "../src/profiles.ts";

function fixture(): ProfileState {
  return validateState({
    version: 1,
    active: "default",
    profiles: {
      default: { description: "Everyday", disabled: ["/extensions/one.ts", "/missing.ts"] },
      quiet: { description: "Focused", disabled: ["/extensions/two.ts"] },
    },
  });
}

function freeze(state: ProfileState): ProfileState {
  for (const profile of Object.values(state.profiles)) {
    Object.freeze(profile.disabled);
    Object.freeze(profile);
  }
  Object.freeze(state.profiles);
  return Object.freeze(state);
}

test("validates slugs, including prototype-like but valid names", () => {
  for (const name of ["a", "0", "a-b_c", "a".repeat(64), "constructor", "tostring"]) {
    assert.doesNotThrow(() => validateName(name));
  }
  for (const name of [
    "",
    "A",
    " a",
    "a ",
    "a\n",
    "a/b",
    "a.b",
    "-a",
    "_a",
    "__proto__",
    "a".repeat(65),
  ]) {
    assert.throws(() => validateName(name));
  }
  assert.throws(() => validateName(null as unknown as string));
});

test("normalizes and deduplicates logical absolute identities without filesystem access", () => {
  assert.deepEqual(
    normalizeExclusions(["/not-installed/a/../b.ts", "/not-installed/b.ts", "/one//two.ts"]),
    ["/not-installed/b.ts", "/one/two.ts"],
  );
  for (const value of ["relative.ts", "~/extension.ts", "", "/bad\0.ts", 1, null]) {
    assert.throws(() => normalizeExclusions([value as string]));
  }
  assert.throws(() => normalizeExclusions("/file.ts" as unknown as string[]));
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(() => normalizeExclusions(sparse));
});

test("validation returns an independent normalized state and preserves descriptions", () => {
  const input = {
    version: 1,
    active: "default",
    profiles: { default: { description: "", disabled: ["/a/../b.ts", "/b.ts"] } },
  };
  const output = validateState(input);
  assert.equal(output.profiles.default!.description, "");
  assert.deepEqual(output.profiles.default!.disabled, ["/b.ts"]);
  assert.equal(Object.getPrototypeOf(output.profiles), null);
  output.profiles.default!.disabled.push("/c.ts");
  assert.deepEqual(input.profiles.default.disabled, ["/a/../b.ts", "/b.ts"]);
});

test("rejects missing, malformed, unknown-version and unknown-field namespaces", () => {
  const good = { version: 1, active: "default", profiles: { default: { disabled: [] } } };
  const invalid: unknown[] = [
    undefined,
    null,
    false,
    [],
    "{}",
    new Date(),
    {},
    { ...good, version: 2 },
    { ...good, version: "1" },
    { ...good, active: "missing" },
    { ...good, active: "UPPER" },
    { ...good, active: undefined },
    { ...good, extra: true },
    { ...good, profiles: null },
    { ...good, profiles: [] },
    { ...good, profiles: {} },
    { ...good, profiles: { default: null } },
    { ...good, profiles: { default: [] } },
    { ...good, profiles: { default: {} } },
    { ...good, profiles: { default: { disabled: "no" } } },
    { ...good, profiles: { default: { disabled: ["relative"] } } },
    { ...good, profiles: { default: { disabled: [], description: 12 } } },
    { ...good, profiles: { default: { disabled: [], description: undefined } } },
    { ...good, profiles: { default: { disabled: [], extra: true } } },
    { ...good, profiles: { default: { disabled: [] }, "Bad Name": { disabled: [] } } },
    { ...good, [Symbol("extra")]: true },
  ];
  for (const input of invalid) assert.throws(() => validateState(input));
  for (const field of ["version", "active", "profiles"] as const) {
    const input: Record<string, unknown> = { ...good };
    delete input[field];
    assert.throws(() => validateState(input));
  }
});

test("uses only owned profile keys and safely supports constructor", () => {
  assert.throws(() => validateState({ version: 1, active: "constructor", profiles: {} }));
  const inherited = Object.create({ default: { disabled: [] } });
  assert.throws(() => validateState({ version: 1, active: "default", profiles: inherited }));
  const malicious = JSON.parse(
    '{"version":1,"active":"default","profiles":{"default":{"disabled":[]},"__proto__":{"disabled":[]}}}',
  );
  assert.throws(() => validateState(malicious));
  const created = createProfile(fixture(), "constructor");
  assert.deepEqual(created.profiles.constructor, { disabled: created.profiles.default!.disabled });
  assert.throws(() => createProfile(created, "constructor"), /already exists/);
  const renamed = renameProfile(created, "default", "tostring");
  assert.equal(renamed.active, "tostring");
  const copied = duplicateProfile(renamed, "constructor", "valueof");
  assert.deepEqual(copied.profiles.valueof, copied.profiles.constructor);
  assert.equal(Object.hasOwn(deleteProfile(copied, "constructor").profiles, "constructor"), false);
  assert.throws(() => duplicateProfile(fixture(), "constructor", "other"), /does not exist/);
});

test("new copies active exclusions but not description; duplicate copies both", () => {
  const state = freeze(fixture());
  const created = createProfile(state, "new");
  assert.equal(created.active, "default");
  assert.deepEqual(created.profiles.new, { disabled: state.profiles.default!.disabled });
  created.profiles.new!.disabled.push("/new.ts");
  assert.deepEqual(created.profiles.default!.disabled, state.profiles.default!.disabled);
  const duplicated = duplicateProfile(state, "quiet", "copy");
  assert.equal(duplicated.active, "default");
  assert.deepEqual(duplicated.profiles.copy, state.profiles.quiet);
  duplicated.profiles.copy!.disabled.push("/new.ts");
  assert.deepEqual(duplicated.profiles.quiet!.disabled, state.profiles.quiet!.disabled);
});

test("rename preserves exclusions, description and selected identity", () => {
  const state = freeze(fixture());
  const renamed = renameProfile(state, "default", "stable");
  assert.equal(renamed.active, "stable");
  assert.equal(Object.hasOwn(renamed.profiles, "default"), false);
  assert.deepEqual(renamed.profiles.stable, state.profiles.default);
  assert.equal(renameProfile(state, "quiet", "silent").active, "default");
  assert.deepEqual(renameProfile(state, "default", "default"), state);
});

test("refuses invalid, duplicate and nonexistent operation names", () => {
  const state = freeze(fixture());
  for (const operation of [
    () => createProfile(state, "quiet"),
    () => createProfile(state, "BAD"),
    () => duplicateProfile(state, "missing", "copy"),
    () => duplicateProfile(state, "quiet", "default"),
    () => duplicateProfile(state, "quiet", "BAD"),
    () => renameProfile(state, "missing", "copy"),
    () => renameProfile(state, "default", "quiet"),
    () => renameProfile(state, "default", "BAD"),
    () => deleteProfile(state, "missing"),
    () => deleteProfile(state, "BAD"),
  ])
    assert.throws(operation);
});

test("delete only removes an inactive profile, refusing active and last deletion", () => {
  const state = freeze(fixture());
  assert.throws(() => deleteProfile(state, "default"), /active/);
  const next = deleteProfile(state, "quiet");
  assert.deepEqual(Object.keys(next.profiles), ["default"]);
  assert.equal(next.active, "default");
  assert.throws(() => deleteProfile(next, "default"), /last/);
  assert.equal(Object.hasOwn(state.profiles, "quiet"), true);
});

test("reconciliation updates only disk-selected profile and retains missing exclusions", () => {
  const state = freeze(fixture());
  const candidates = [
    { path: "/extensions/one.ts", enabled: true },
    { path: "/extensions/two.ts", enabled: false },
    { path: "/new.ts", enabled: true },
  ];
  const next = reconcileProfile(state, candidates);
  assert.deepEqual(next.profiles.default!.disabled, ["/missing.ts", "/extensions/two.ts"]);
  assert.equal(next.profiles.default!.description, "Everyday");
  assert.deepEqual(next.profiles.quiet, state.profiles.quiet);
  assert.deepEqual(reconcileProfile(state, []), state);
  const diskSelected = { ...state, active: "quiet" };
  const refreshed = reconcileProfile(diskSelected, [
    { path: "/extensions/one.ts", enabled: false },
  ]);
  assert.deepEqual(refreshed.profiles.default, state.profiles.default);
  assert.deepEqual(refreshed.profiles.quiet!.disabled, [
    "/extensions/two.ts",
    "/extensions/one.ts",
  ]);
  assert.deepEqual(reconcileProfile(next, candidates), next);
});

test("missing and reinstalled identities retain exclusions; moved and new entrypoints default on", () => {
  const absent = reconcileProfile(fixture(), []);
  assert.ok(absent.profiles.default!.disabled.includes("/missing.ts"));
  const reinstalled = reconcileProfile(absent, [
    { path: "/missing.ts", enabled: false },
    { path: "/moved.ts", enabled: true },
    { path: "/package/new-entrypoint.ts", enabled: true },
  ]);
  assert.deepEqual(reinstalled, absent);
  assert.equal(
    createProfile(reinstalled, "new").profiles.new!.disabled.includes("/moved.ts"),
    false,
  );
  const externallyEnabled = reconcileProfile(reinstalled, [{ path: "/missing.ts", enabled: true }]);
  assert.equal(externallyEnabled.profiles.default!.disabled.includes("/missing.ts"), false);
});

test("locked manager identities cannot be excluded, even by duplicate normalized candidates", () => {
  const state = freeze(fixture());
  const next = reconcileProfile(state, [
    { path: "/extensions/../extensions/one.ts", enabled: false, locked: true },
    { path: "/extensions/one.ts", enabled: false },
    { path: "/other.ts", enabled: false },
    { path: "/tmp/../other.ts", enabled: false },
  ]);
  assert.deepEqual(next.profiles.default!.disabled, ["/missing.ts", "/other.ts"]);
  assert.deepEqual(next.profiles.quiet, state.profiles.quiet);
  assert.throws(() => reconcileProfile(state, [{ path: "relative.ts", enabled: false }]));
});

test("all operations return independent mutable copies without modifying frozen input", () => {
  const state = freeze(fixture());
  const original = JSON.stringify(state);
  for (const output of [
    validateState(state),
    createProfile(state, "new"),
    duplicateProfile(state, "quiet", "copy"),
    renameProfile(state, "quiet", "renamed"),
    deleteProfile(state, "quiet"),
    reconcileProfile(state, [{ path: "/another.ts", enabled: false }]),
  ]) {
    assert.notEqual(output, state);
    assert.notEqual(output.profiles, state.profiles);
    output.profiles.default!.disabled.push("/mutation.ts");
    output.profiles.default!.description = "Changed";
    assert.equal(JSON.stringify(state), original);
  }
});

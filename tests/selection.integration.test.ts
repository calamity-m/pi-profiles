import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { discover } from "../src/catalog.ts";
import { projectSelection } from "../src/selection.ts";
import { createProfile, reconcileProfile } from "../src/profiles.ts";

let home: string, agent: string, manager: string, root: string, a: string, b: string;
let oldHome: string | undefined;
async function file(path: string, content = "export default () => {}") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}
beforeEach(async () => {
  oldHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "pi-profiles-selection-"));
  process.env.HOME = home;
  agent = join(home, "agent");
  manager = await file(join(agent, "extensions", "manager.ts"));
  root = join(home, "package");
  await file(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["extensions"] } }));
  a = await file(join(root, "extensions", "a.ts"));
  b = await file(join(root, "extensions", "b.ts"));
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

test("string conversion preserves omitted non-extension manifest types and unrelated fields", async () => {
  await file(join(root, "prompts", "hello.md"), "Hello");
  await file(
    join(root, "skills", "skill", "SKILL.md"),
    "---\nname: skill\ndescription: fixture\n---\nTest",
  );
  const document = { packages: [root], custom: { untouched: true }, theme: "dark" };
  const catalog = await discover(document, agent, manager);
  const next = await projectSelection(document, catalog, [a, manager]);
  assert.deepEqual(next.packages, [
    { source: root, skills: [], prompts: [], themes: [], extensions: ["-extensions/a.ts"] },
  ]);
  assert.deepEqual(next.custom, document.custom);
  const verified = await discover(next, agent, manager);
  assert.equal(verified.extensions.find((e) => e.path === a)?.enabled, false);
  assert.equal(verified.extensions.find((e) => e.path === manager)?.enabled, true);
  assert.equal(verified.nonExtensions.prompts.filter((e) => e.enabled).length, 0);
});

test("empty, allowlist and wildcard filters become exact current exclusions, new children default on in multiple profiles", async () => {
  for (const filter of [[], ["extensions/a.ts"], ["!extensions/b.ts"]]) {
    const document = { packages: [{ source: root, extensions: filter }] };
    const catalog = await discover(document, agent, manager);
    let state = reconcileProfile(
      { version: 1, active: "default", profiles: { default: { disabled: [] } } },
      catalog.extensions,
    );
    state = createProfile(state, "curated");
    const next = await projectSelection(document, catalog, state.profiles.default.disabled);
    const c = await file(join(root, "extensions", "c.ts"));
    const fresh = await discover(next, agent, manager);
    for (const profile of Object.values(state.profiles)) {
      const applied = await projectSelection(next, fresh, profile.disabled);
      const resolved = await discover(applied, agent, manager);
      assert.equal(resolved.extensions.find((e) => e.path === c)?.enabled, true);
      assert.equal(
        resolved.extensions.find((e) => e.path === b)?.enabled,
        !profile.disabled.includes(b),
      );
    }
    await rm(c);
  }
});

test("autoload false projects explicit default-on extensions without altering other filters", async () => {
  await file(join(root, "prompts", "hello.md"), "Hello");
  const document = {
    packages: [{ source: root, autoload: false, extensions: ["+extensions/a.ts"], prompts: [] }],
  };
  const catalog = await discover(document, agent, manager);
  const next = await projectSelection(document, catalog, [b]);
  assert.deepEqual(next.packages, [
    { source: root, autoload: false, extensions: ["**/*", "-extensions/b.ts"], prompts: [] },
  ]);
  const verified = await discover(next, agent, manager);
  assert.equal(verified.extensions.find((e) => e.path === a)?.enabled, true);
});

test("order-sensitive autoload selectors cannot reorder retained enabled extensions", async () => {
  const document = {
    packages: [
      { source: root, autoload: false, extensions: ["+extensions/b.ts", "+extensions/a.ts"] },
    ],
  };
  const catalog = await discover(document, agent, manager);
  await assert.rejects(
    projectSelection(document, catalog, []),
    /reorder retained enabled extensions/,
  );
});

test("top-level discovery roots remain and exact exclusions replace selectors", async () => {
  const loose = await file(join(home, "loose.ts"));
  const document = { extensions: [loose, "!**/manager.ts"] };
  const catalog = await discover(document, agent, manager);
  const next = await projectSelection(document, catalog, [loose, manager]);
  assert.deepEqual(next.extensions, [loose, `-${loose}`]);
});

test("Pi built-in selectors survive discovery and profile switches unchanged", async () => {
  const selectors = [
    "builtin:codemode",
    "-builtin:mcp",
    "+builtin:tool_search",
    "!builtin:future*",
  ];
  const document = { packages: [root], extensions: selectors };
  const catalog = await discover(document, agent, manager);
  assert.deepEqual(
    new Set(catalog.extensions.map((entry) => entry.path)),
    new Set([manager, a, b]),
  );
  const disabled = await projectSelection(document, catalog, [a]);
  assert.deepEqual(disabled.extensions, selectors);
  const fresh = await discover(disabled, agent, manager);
  const enabled = await projectSelection(disabled, fresh, []);
  assert.deepEqual(enabled.extensions, selectors);
  assert.equal(
    (await discover(enabled, agent, manager)).extensions.find((e) => e.path === a)?.enabled,
    true,
  );
});

test("unsupported registrations stay unchanged and cannot be disabled", async () => {
  const loose = await file(join(home, "loose.ts"));
  const document = { packages: [loose, root] };
  const catalog = await discover(document, agent, manager);
  const next = await projectSelection(document, catalog, [a]);
  assert.equal((next.packages as unknown[])[0], loose);
  await assert.rejects(projectSelection(document, catalog, [loose]), /Read-only/);
});

test("stale selector documents and changed on-disk inventories block projection", async () => {
  const document = { packages: [root] };
  const catalog = await discover(document, agent, manager);
  await assert.rejects(projectSelection({ packages: [] }, catalog, []), /changed since discovery/);
  await file(join(root, "extensions", "new.ts"));
  await assert.rejects(projectSelection(document, catalog, [a]), /changed the extension inventory/);
});

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { discover } from "../src/catalog.ts";

let home: string;
let agentDir: string;
let managerPath: string;
let originalHome: string | undefined;
let originalOffline: string | undefined;

async function file(
  path: string,
  content = "throw new Error('extension must never be evaluated');",
) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function pkg(root: string, manifest: unknown = { extensions: ["extensions"] }) {
  await file(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.2.3", pi: manifest }),
  );
  const a = await file(join(root, "extensions", "a.ts"));
  const b = await file(join(root, "extensions", "b.ts"));
  return { root, a, b };
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalOffline = process.env.PI_OFFLINE;
  home = await mkdtemp(join(tmpdir(), "pi-profiles-catalog-"));
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  agentDir = join(home, "agent");
  managerPath = await file(join(agentDir, "extensions", "manager.ts"));
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
  await rm(home, { recursive: true, force: true });
});

test("discovers auto, explicit files/directories and disabled children without evaluating code or reading project settings", async () => {
  const sentinel = join(home, "evaluated");
  const automatic = await file(
    join(agentDir, "extensions", "automatic.ts"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');`,
  );
  const explicit = await file(join(home, "explicit.ts"));
  const directoryEntry = await file(join(home, "directory", "child", "index.ts"));
  const project = await file(join(agentDir, ".pi", "extensions", "untrusted.ts"));
  const projectSettings = await file(
    join(agentDir, ".pi", "settings.json"),
    JSON.stringify({ extensions: [project] }),
  );
  const before = await readFile(projectSettings, "utf8");
  const catalog = await discover(
    { extensions: [explicit, join(home, "directory"), `-${automatic}`] },
    agentDir,
    managerPath,
  );
  assert.deepEqual(
    new Set(catalog.extensions.map((entry) => entry.path)),
    new Set([managerPath, automatic, explicit, directoryEntry]),
  );
  assert.equal(catalog.extensions.find((entry) => entry.path === automatic)?.enabled, false);
  assert.equal(catalog.extensions.find((entry) => entry.path === managerPath)?.locked, true);
  assert.equal(await readFile(projectSettings, "utf8"), before);
  await assert.rejects(access(sentinel));
});

test("local manifest exclusions stay outside candidates and metadata preserves owner/root/relative paths", async () => {
  const source = await pkg(join(home, "local"), { extensions: ["extensions", "!extensions/b.ts"] });
  const catalog = await discover(
    { packages: [{ source: source.root, extensions: [] }] },
    agentDir,
    managerPath,
  );
  const entry = catalog.extensions.find((candidate) => candidate.path === source.a);
  assert.ok(entry);
  assert.equal(entry.enabled, false);
  assert.equal(entry.owner, "package:0");
  assert.equal(entry.root, source.root);
  assert.equal(entry.relativePath, "extensions/a.ts");
  assert.equal(entry.canonicalPath, source.a);
  assert.equal(
    catalog.extensions.some((candidate) => candidate.path === source.b),
    false,
  );
});

test("managed npm and existing git layouts are discovered offline, with source versions intact", async () => {
  const npm = await pkg(join(agentDir, "npm", "node_modules", "@fixtures", "npm"));
  const git = await pkg(join(agentDir, "git", "github.com", "fixtures", "git"));
  const catalog = await discover(
    { packages: ["npm:@fixtures/npm@^1.2.0", "git:github.com/fixtures/git@v1"] },
    agentDir,
    managerPath,
  );
  assert.equal(catalog.packages[0].root, npm.root);
  assert.equal(catalog.packages[1].root, git.root);
  assert.equal(
    catalog.extensions.find((entry) => entry.path === npm.a)?.source,
    "npm:@fixtures/npm@^1.2.0",
  );
  assert.equal(catalog.extensions.find((entry) => entry.path === git.a)?.enabled, true);
  await assert.rejects(access(join(git.root, "node_modules")));
});

test("autoload:false enumeration includes unmentioned extensions but retains actual order-sensitive state", async () => {
  const source = await pkg(join(home, "autoload"));
  const c = await file(join(source.root, "extensions", "c.ts"));
  const catalog = await discover(
    {
      packages: [
        {
          source: source.root,
          autoload: false,
          extensions: ["+extensions/b.ts", "-extensions/b.ts", "+extensions/a.ts"],
        },
      ],
    },
    agentDir,
    managerPath,
  );
  assert.equal(catalog.extensions.find((entry) => entry.path === source.a)?.enabled, true);
  assert.equal(catalog.extensions.find((entry) => entry.path === source.b)?.enabled, false);
  assert.equal(catalog.extensions.find((entry) => entry.path === c)?.enabled, false);
  assert.equal(catalog.extensions.filter((entry) => entry.owner === "package:0").length, 3);
});

test("loose files and fallback directories are explicitly read-only, while legitimate empty packages are valid", async () => {
  const loose = await file(join(home, "loose.ts"));
  const fallback = join(home, "fallback");
  await file(join(fallback, "index.ts"));
  const empty = join(home, "empty");
  await file(join(empty, "package.json"), JSON.stringify({ pi: { skills: [] } }));
  const catalog = await discover({ packages: [loose, fallback, empty] }, agentDir, managerPath);
  assert.equal(catalog.extensions.find((entry) => entry.path === loose)?.supported, false);
  assert.equal(catalog.extensions.find((entry) => entry.path === fallback)?.supported, false);
  assert.equal(catalog.packages[2].supported, true);
  assert.equal(catalog.diagnostics.length, 2);
  assert.match(catalog.diagnostics[0], /settings.extensions/);
});

test("missing/incompatible packages block inventory without installing, including offline callback suppression", async () => {
  const wrapperLog = join(home, "npm-commands");
  const wrapper = await file(
    join(home, "npm-wrapper.cjs"),
    `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(wrapperLog)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(${JSON.stringify(join(home, "legacy"))});`,
  );
  await assert.rejects(
    discover(
      { packages: ["npm:missing-fixture"], npmCommand: [process.execPath, wrapper] },
      agentDir,
      managerPath,
    ),
    /Missing package/,
  );
  assert.match(await readFile(wrapperLog, "utf8"), /root/);
  assert.doesNotMatch(await readFile(wrapperLog, "utf8"), /install/);
  await assert.rejects(access(join(agentDir, "npm")));
  await pkg(join(agentDir, "npm", "node_modules", "incompatible"));
  await assert.rejects(
    discover({ packages: ["npm:incompatible@2.0.0"] }, agentDir, managerPath),
    /incompatible npm package/,
  );
  await assert.rejects(
    discover({ packages: ["git:github.com/fixtures/missing"] }, agentDir, managerPath),
    /Missing package/,
  );
  await assert.rejects(access(join(agentDir, "git")));
});

test("rejects malformed selectors, invalid manifests, stale roots and a CLI-only manager", async () => {
  await assert.rejects(
    discover({ packages: [{ source: "x", autoload: "false" }] }, agentDir, managerPath),
    /autoload/,
  );
  await assert.rejects(discover({ extensions: [42] }, agentDir, managerPath), /extensions/);
  await assert.rejects(
    discover({ extensions: [join(home, "absent.ts")] }, agentDir, managerPath),
    /Missing extensions discovery root/,
  );
  const broken = join(home, "broken");
  await file(join(broken, "package.json"), "{broken");
  await assert.rejects(discover({ packages: [broken] }, agentDir, managerPath), /JSON|property/i);
  const cli = await file(join(home, "cli-only.ts"));
  await assert.rejects(discover({}, agentDir, cli), /not globally discoverable/);
});

test("rejects aliases, duplicate package identities and conflicting package/top-level ownership", async () => {
  const source = await pkg(join(home, "owned"));
  await assert.rejects(
    discover({ packages: [source.root, source.root] }, agentDir, managerPath),
    /Conflicting package ownership/,
  );
  await assert.rejects(
    discover({ packages: [source.root], extensions: [source.a] }, agentDir, managerPath),
    /Conflicting resource ownership/,
  );
  const alias = join(home, "alias.ts");
  await symlink(source.a, alias);
  await assert.rejects(
    discover({ extensions: [source.a, alias] }, agentDir, managerPath),
    /alias/i,
  );
  await symlink(source.a, join(source.root, "extensions", "alias.ts"));
  await assert.rejects(discover({ packages: [source.root] }, agentDir, managerPath), /alias/i);
});

test("a single logical symlink identity is retained and canonical manager identity remains locked", async () => {
  const actualManager = await file(join(home, "manager-target.ts"));
  await rm(managerPath);
  await symlink(actualManager, managerPath);
  const catalog = await discover({}, agentDir, actualManager);
  assert.equal(catalog.extensions[0].path, managerPath);
  assert.equal(catalog.extensions[0].canonicalPath, actualManager);
  assert.equal(catalog.extensions[0].locked, true);
});

test("effective signature ignores profile metadata but notices ordered selection and source changes", async () => {
  const a = await file(join(home, "a.ts"));
  const b = await file(join(home, "b.ts"));
  const first = await discover({ extensions: [a, b] }, agentDir, managerPath);
  const renamed = await discover(
    {
      extensions: [a, b],
      piProfiles: { version: 1, active: "renamed", profiles: { renamed: { disabled: [] } } },
    },
    agentDir,
    managerPath,
  );
  const reordered = await discover({ extensions: [b, a] }, agentDir, managerPath);
  const disabled = await discover({ extensions: [a, b, `-${b}`] }, agentDir, managerPath);
  assert.equal(first.signature, renamed.signature);
  assert.notEqual(first.signature, reordered.signature);
  assert.notEqual(first.signature, disabled.signature);
});

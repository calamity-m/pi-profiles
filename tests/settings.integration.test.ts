import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
  commitSettings,
  fingerprint,
  profilesPath,
  readSettings,
  type GlobalSettings,
} from "../src/settings.ts";

async function fixture(t: TestContext, document?: GlobalSettings) {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-profiles-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, "settings.json");
  if (document) {
    const { piProfiles, ...global } = document;
    await fs.writeFile(path, JSON.stringify(global));
    if (piProfiles) await fs.writeFile(profilesPath(path), JSON.stringify(piProfiles));
  }
  return { dir, path };
}

function selection(name = "default"): GlobalSettings {
  return {
    extensions: ["/extensions", "-/extensions/off.ts"],
    piProfiles: {
      version: 1,
      active: name,
      profiles: { [name]: { disabled: ["/extensions/off.ts"] } },
    },
  };
}

function piWriter(t: TestContext, dir: string, firstCreationBarrier?: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { SettingsManager } from '@earendil-works/pi-coding-agent';
    import { createRequire } from 'node:module';
    import { existsSync } from 'node:fs';
    const lockfile = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('proper-lockfile');
    const dir = process.argv[1];
    const barrier = process.argv[2];
    const manager = SettingsManager.create(dir, dir, { projectTrusted: false });
    if (manager.drainErrors().length) throw new Error('Pi read failed');
    process.send('ready');
    process.once('message', async () => {
      if (barrier) {
        const original = lockfile.lockSync;
        lockfile.lockSync = (...args) => {
          process.send('computed-before-lock');
          const deadline = Date.now() + 10000;
          while (!existsSync(barrier)) {
            if (Date.now() > deadline) throw new Error('Barrier timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          return original(...args);
        };
      }
      process.send('writing');
      manager.setTheme('light');
      await manager.flush();
      process.send({ errors: manager.drainErrors().map(e => e.error.message) });
      process.disconnect();
    });
  `,
      dir,
      ...(firstCreationBarrier ? [firstCreationBarrier] : []),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, PI_OFFLINE: "1", HOME: dir, PI_CODING_AGENT_DIR: dir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const messages: unknown[] = [];
  const waiters: Array<() => void> = [];
  child.on("message", (message) => {
    messages.push(message);
    waiters.shift()?.();
  });
  const exited = once(child, "exit").then(([code]) => {
    assert.equal(code, 0, stderr);
  });
  // Consume rejection even when an earlier assertion aborts the test.
  void exited.catch(() => {});
  t.after(() => {
    child.kill();
  });
  return {
    child,
    exited,
    async message() {
      if (!messages.length)
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      return messages.shift();
    },
  };
}

test("absent settings stay absent on read, then commit privately in a missing parent", async (t) => {
  const { dir } = await fixture(t);
  const path = join(dir, "nested", "settings.json");
  const before = await readSettings(path);
  assert.deepEqual(before.document, {});
  await assert.rejects(fs.stat(dirname(path)), { code: "ENOENT" });
  const after = await commitSettings(before, selection());
  assert.deepEqual(after, await readSettings(path));
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-profiles.json", "settings.json"]);
  assert.equal((await fs.stat(profilesPath(path))).mode & 0o777, 0o600);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path, "utf8")), "piProfiles"), false);
});

test("commits home-relative profile paths without changing selectors or caller data", async (t) => {
  const { path } = await fixture(t);
  const absolute = join(homedir(), ".pi", "extensions", "off.ts");
  const proposal = selection();
  proposal.extensions = [`-${absolute}`];
  proposal.piProfiles = {
    version: 1,
    active: "default",
    profiles: { default: { disabled: [absolute, "~/.pi/extensions/off.ts", "/outside/off.ts"] } },
  };
  const original = structuredClone(proposal);
  const saved = await commitSettings(await readSettings(path), proposal);
  assert.deepEqual(saved, await readSettings(path));
  assert.deepEqual(saved.document.extensions, [`-${absolute}`]);
  assert.deepEqual(saved.document.piProfiles, {
    version: 1,
    active: "default",
    profiles: { default: { disabled: ["~/.pi/extensions/off.ts", "/outside/off.ts"] } },
  });
  assert.deepEqual(proposal, original);
});

test("validates JSON roots, selectors, sources, argv, and strict profile metadata", async (t) => {
  const { path } = await fixture(t);
  const invalid: unknown[] = [
    null,
    [],
    "settings",
    42,
    { extensions: "x" },
    { extensions: [null] },
    { extensions: ["!"] },
    { skills: [false] },
    { themes: {} },
    { prompts: [""] },
    { packages: {} },
    { packages: [null] },
    { packages: [{}] },
    { packages: [{ source: 42 }] },
    { packages: ["npm:"] },
    { packages: [{ source: "./pkg", autoload: "false" }] },
    ...["extensions", "skills", "themes", "prompts"].map((key) => ({
      packages: [{ source: "./pkg", [key]: [1] }],
    })),
    { npmCommand: "npm" },
    { npmCommand: [""] },
    { npmCommand: ["npm", false] },
  ];
  for (const document of invalid) {
    await fs.writeFile(path, JSON.stringify(document));
    await assert.rejects(readSettings(path), { name: /Error/ }, JSON.stringify(document));
  }
  await fs.writeFile(path, "{broken");
  await assert.rejects(readSettings(path), SyntaxError);
  await fs.writeFile(path, "");
  await assert.rejects(readSettings(path), SyntaxError);
  const valid = {
    packages: [{ source: "./pkg", autoload: false, extensions: [], custom: { future: true } }],
    npmCommand: [],
    future: null,
  };
  await fs.writeFile(path, `\uFEFF${JSON.stringify(valid)}`);
  assert.deepEqual((await readSettings(path)).document, valid);
});

test("legacy metadata is ignored and preserved, never migrated or validated", async (t) => {
  const { path } = await fixture(t);
  for (const legacy of [selection("legacy").piProfiles, null, { version: 99 }]) {
    await fs.writeFile(path, JSON.stringify({ theme: "dark", piProfiles: legacy }));
    const before = await readSettings(path);
    assert.deepEqual(before.document, { theme: "dark" });
    await commitSettings(before, before.document);
    await assert.rejects(fs.stat(profilesPath(path)), { code: "ENOENT" });
    await commitSettings(await readSettings(path), selection());
    assert.deepEqual((await readSettings(path)).document.piProfiles, selection().piProfiles);
    assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).piProfiles, legacy);
    await fs.unlink(profilesPath(path));
  }
});

test("metadata-only edits leave Pi settings byte-for-byte unchanged", async (t) => {
  const { path } = await fixture(t, { theme: "dark" });
  const original = await fs.readFile(path, "utf8");
  await commitSettings(await readSettings(path), {
    theme: "dark",
    piProfiles: selection().piProfiles,
  });
  assert.equal(await fs.readFile(path, "utf8"), original);
  await commitSettings(await readSettings(path), {
    theme: "dark",
    piProfiles: selection("other").piProfiles,
  });
  assert.equal(await fs.readFile(path, "utf8"), original);
});

test("invalid and externally edited standalone metadata is never overwritten", async (t) => {
  const { path } = await fixture(t, {});
  for (const invalid of ["{broken", "null", JSON.stringify({ version: 99 })]) {
    await fs.writeFile(profilesPath(path), invalid);
    await assert.rejects(readSettings(path));
    assert.equal(await fs.readFile(profilesPath(path), "utf8"), invalid);
  }
  await fs.writeFile(profilesPath(path), JSON.stringify(selection().piProfiles));
  const before = await readSettings(path);
  await fs.writeFile(profilesPath(path), JSON.stringify(selection("external").piProfiles));
  await assert.rejects(commitSettings(before, selection("draft")), /changed.*stale/);
  await fs.writeFile(path, JSON.stringify(selection()));
  assert.deepEqual(
    (await readSettings(path)).document.piProfiles,
    selection("external").piProfiles,
  );
});

test("standalone metadata preserves symlinks and permissions and rejects retargeted drafts", async (t) => {
  const { dir, path } = await fixture(t, {});
  const target = join(dir, "metadata.json");
  await fs.writeFile(target, JSON.stringify(selection().piProfiles), { mode: 0o640 });
  await fs.symlink("metadata.json", profilesPath(path));
  await commitSettings(await readSettings(path), selection("other"));
  assert.equal(await fs.readlink(profilesPath(path)), "metadata.json");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  const before = await readSettings(path);
  await fs.writeFile(join(dir, "replacement.json"), await fs.readFile(target));
  await fs.unlink(profilesPath(path));
  await fs.symlink("replacement.json", profilesPath(path));
  await assert.rejects(commitSettings(before, selection()), /target changed/);
});

test("settings failure restores existing metadata or removes newly created metadata", async (t) => {
  for (const initialized of [false, true]) {
    const { path } = await fixture(t, initialized ? selection() : {});
    const before = await readSettings(path);
    const rename = fs.rename.bind(fs);
    const mocked = t.mock.method(fs, "rename", async (from: string, to: string) => {
      if (to === before.target) throw new Error("settings rename denied");
      return rename(from, to);
    });
    try {
      await assert.rejects(
        commitSettings(before, {
          ...selection("other"),
          extensions: ["/different.ts"],
        }),
        /settings rename denied/,
      );
    } finally {
      mocked.mock.restore();
    }
    assert.deepEqual(await readSettings(path), before);
    await commitSettings(before, selection("other"));
  }
});

test("standalone metadata lock contention releases the Pi settings lock", async (t) => {
  const { path } = await fixture(t, {});
  const before = await readSettings(path);
  const release = await lockfile.lock(profilesPath(path), { realpath: false });
  try {
    await assert.rejects(commitSettings(before, selection()), { code: "ELOCKED" });
    const releaseGlobal = await lockfile.lock(path, { realpath: false });
    await releaseGlobal();
  } finally {
    await release();
  }
  await commitSettings(before, selection());
});

test("fingerprint ignores unrelated settings and key order, but retains array order and absence", () => {
  assert.equal(
    fingerprint({ extensions: ["a"], theme: "light" }),
    fingerprint({ theme: "dark", extensions: ["a"] }),
  );
  assert.equal(
    fingerprint({ packages: [{ source: "a", extensions: [] }] }),
    fingerprint({ packages: [{ extensions: [], source: "a" }] }),
  );
  assert.notEqual(fingerprint({ extensions: ["a", "b"] }), fingerprint({ extensions: ["b", "a"] }));
  assert.notEqual(fingerprint({}), fingerprint({ extensions: [] }));
  for (const key of ["packages", "extensions", "npmCommand", "piProfiles"]) {
    assert.notEqual(fingerprint({}), fingerprint({ [key]: [] }));
  }
});

test("merges only managed keys into fresh JSON and preserves modes and unknown own keys", async (t) => {
  const original = JSON.parse(
    '{"theme":"dark","__proto__":{"retained":true},"future":{"a":1}}',
  ) as GlobalSettings;
  const { path } = await fixture(t, original);
  await fs.chmod(path, 0o640);
  const before = await readSettings(path);
  await fs.writeFile(
    path,
    JSON.stringify({ ...original, theme: "light", future: { a: 2 }, added: true }),
  );
  const after = await commitSettings(before, {
    ...before.document,
    ...selection(),
    theme: "stale",
  });
  assert.equal(after.document.theme, "light");
  assert.deepEqual(after.document.future, { a: 2 });
  assert.equal(after.document.added, true);
  assert.equal(Object.hasOwn(after.document, "__proto__"), true);
  assert.deepEqual(after.document.__proto__, { retained: true });
  assert.equal((await fs.stat(path)).mode & 0o777, 0o640);
  assert.deepEqual(after, await readSettings(path));
});

test("managed changes reject stale drafts without overwriting disk", async (t) => {
  const { path } = await fixture(t, {});
  for (const change of [
    { extensions: ["other"] },
    { packages: ["./pkg"] },
    { npmCommand: ["wrapper"] },
    selection("other"),
  ]) {
    await fs.writeFile(path, "{}");
    const before = await readSettings(path);
    await fs.writeFile(path, JSON.stringify(change));
    await assert.rejects(commitSettings(before, selection()), /changed.*stale/);
    const { piProfiles: _legacy, ...expected } = change;
    assert.deepEqual((await readSettings(path)).document, expected);
  }
});

test("symlinked settings preserve links, target permissions, and reject target changes", async (t) => {
  const { dir, path } = await fixture(t);
  const target = join(dir, "target.json");
  await fs.writeFile(target, "{}", { mode: 0o640 });
  await fs.symlink("target.json", path);
  const before = await readSettings(path);
  assert.equal(before.target, target);
  await commitSettings(before, selection());
  assert.equal(await fs.readlink(path), "target.json");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  const stale = await readSettings(path);
  await fs.writeFile(join(dir, "other.json"), JSON.stringify(stale.document));
  await fs.unlink(path);
  await fs.symlink("other.json", path);
  await assert.rejects(commitSettings(stale, selection("other")), /target changed/);
  assert.deepEqual((await readSettings(target)).document, stale.document);
});

test("dangling settings symlink creates its target without replacing the link", async (t) => {
  const { dir, path } = await fixture(t);
  await fs.symlink("nested/target.json", path);
  const before = await readSettings(path);
  assert.equal(before.target, join(dir, "nested", "target.json"));
  await commitSettings(before, selection());
  assert.equal(await fs.readlink(path), "nested/target.json");
  assert.deepEqual((await readSettings(path)).document, selection());
});

test("two simultaneous profile writers commit exactly one complete proposal", async (t) => {
  const { path } = await fixture(t, {});
  const snapshot = await readSettings(path);
  const outcomes = await Promise.allSettled([
    commitSettings(snapshot, selection("one")),
    commitSettings(snapshot, selection("two")),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(String(rejected?.reason), /changed.*stale/);
  const document = (await readSettings(path)).document;
  assert.ok(
    [selection("one"), selection("two")].some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(document),
    ),
  );
});

test("atomic replacement exposes complete old-or-new JSON to unlocked readers", async (t) => {
  const { path } = await fixture(t, selection("old"));
  const before = await readSettings(path);
  const next: GlobalSettings = {
    ...selection("new"),
    packages: Array.from({ length: 3000 }, (_, i) => `./pkg-${i}`),
  };
  const oldGlobalFingerprint = fingerprint(JSON.parse(await fs.readFile(path, "utf8")));
  let done = false;
  const writing = commitSettings(before, next).finally(() => {
    done = true;
  });
  do {
    const document = JSON.parse(await fs.readFile(path, "utf8")) as GlobalSettings;
    const { piProfiles: _metadata, ...nextGlobal } = next;
    assert.ok([oldGlobalFingerprint, fingerprint(nextGlobal)].includes(fingerprint(document)));
  } while (!done);
  await writing;
});

test("write and rename failures remove temporary files and release the lock", async (t) => {
  const { dir, path } = await fixture(t, selection());
  const before = await readSettings(path);
  for (const operation of ["open", "rename"] as const) {
    const mocked = t.mock.method(fs, operation, async () => {
      throw Object.assign(new Error(`${operation} denied`), { code: "EACCES" });
    });
    await assert.rejects(commitSettings(before, selection("other")), /denied/);
    mocked.mock.restore();
    assert.deepEqual(await fs.readdir(dir), ["pi-profiles.json", "settings.json"]);
    assert.deepEqual(await readSettings(path), before);
    const release = await lockfile.lock(path, { realpath: false });
    await release();
  }
  await commitSettings(before, selection("other"));
});

test("logical-path lock contention fails cleanly for both profile and Pi writers", async (t) => {
  const { dir, path } = await fixture(t, {});
  const before = await readSettings(path);
  const pi = piWriter(t, dir);
  assert.equal(await pi.message(), "ready");
  const release = await lockfile.lock(path, { realpath: false });
  try {
    pi.child.send("go");
    assert.equal(await pi.message(), "writing");
    const result = (await pi.message()) as { errors: string[] };
    assert.ok(
      result.errors.some((error) => /lock.*held/i.test(error)),
      JSON.stringify(result),
    );
    await assert.rejects(commitSettings(before, selection()), { code: "ELOCKED" });
    assert.deepEqual((await readSettings(path)).document, {});
  } finally {
    await release();
  }
  await pi.exited;
});

test("Pi ordinary writes interoperate with concurrent profile commits on existing settings", async (t) => {
  const { dir, path } = await fixture(t, { theme: "dark" });
  const before = await readSettings(path);
  const pi = piWriter(t, dir);
  assert.equal(await pi.message(), "ready");
  const release = await lockfile.lock(path, { realpath: false });
  const committing = commitSettings(before, selection());
  pi.child.send("go");
  assert.equal(await pi.message(), "writing");
  await release();
  assert.deepEqual(await pi.message(), { errors: [] });
  await Promise.all([committing, pi.exited]);
  assert.deepEqual((await readSettings(path)).document, { theme: "light", ...selection() });
});

test("Pi can create absent settings before or after a profile commit sequentially", async (t) => {
  const { dir, path } = await fixture(t);
  const before = await readSettings(path);
  const pi = SettingsManager.create(dir, dir, { projectTrusted: false });
  pi.setTheme("light");
  await pi.flush();
  assert.deepEqual(pi.drainErrors(), []);
  await commitSettings(before, selection());
  pi.setTheme("dark");
  await pi.flush();
  assert.deepEqual(pi.drainErrors(), []);
  assert.deepEqual((await readSettings(path)).document, { theme: "dark", ...selection() });
});

test(
  "upstream limit: Pi's simultaneous first creation can overwrite a completed profile commit",
  { timeout: 15000 },
  async (t) => {
    const { dir, path } = await fixture(t);
    const before = await readSettings(path);
    const barrier = join(dir, "resume-pi");
    const pi = piWriter(t, dir, barrier);
    assert.equal(await pi.message(), "ready");
    pi.child.send("go");
    assert.equal(await pi.message(), "writing");
    assert.equal(await pi.message(), "computed-before-lock");
    // Pi already computed its absent-file JSON, but has not acquired the shared lock.
    await commitSettings(before, selection());
    await fs.writeFile(barrier, "resume");
    assert.deepEqual(await pi.message(), { errors: [] });
    await pi.exited;
    assert.deepEqual((await readSettings(path)).document, {
      theme: "light",
      piProfiles: selection().piProfiles,
    });
  },
);

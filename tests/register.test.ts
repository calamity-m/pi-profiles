import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { register } from "../src/register.ts";
import type { ProfileMenu } from "../src/ui/profile-picker.ts";

let home: string, dir: string, manager: string, a: string, settings: string;
let oldHome: string | undefined;
beforeEach(async () => {
  oldHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "pi-profiles-register-"));
  process.env.HOME = home;
  dir = join(home, "agent");
  await mkdir(join(dir, "extensions"), { recursive: true });
  manager = join(dir, "extensions", "manager.ts");
  a = join(dir, "extensions", "a.ts");
  await writeFile(manager, "export default () => {}");
  await writeFile(a, "export default () => {}");
  settings = join(dir, "settings.json");
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});
const initial = () => ({
  piProfiles: {
    version: 1,
    active: "default",
    profiles: { default: { disabled: [] }, small: { disabled: [a] } },
  },
});
async function disk() {
  return JSON.parse(await readFile(settings, "utf8"));
}
async function put(value: unknown) {
  await writeFile(settings, JSON.stringify(value));
}

function harness() {
  let command: RegisteredCommand;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notices: string[] = [],
    statuses: (string | undefined)[] = [];
  const choices: (string | null | ((view: ProfileMenu) => void | Promise<void>))[] = [];
  const inputs: (string | undefined)[] = [];
  const confirmations: boolean[] = [];
  let reloads = 0,
    isIdle = true,
    oldContext = false;
  const check = () => assert.equal(oldContext, false, "old context accessed after reload");
  const ctx = {
    mode: "tui",
    isIdle: () => {
      check();
      return isIdle;
    },
    reload: async () => {
      check();
      reloads++;
      oldContext = true;
    },
    ui: {
      notify: (message: string) => {
        check();
        notices.push(message);
      },
      setStatus: (_key: string, value: string | undefined) => {
        check();
        statuses.push(value);
      },
      input: async () => {
        check();
        return inputs.shift();
      },
      confirm: async () => {
        check();
        return confirmations.shift() ?? false;
      },
      custom: async (
        factory: (
          tui: TUI,
          theme: Theme,
          keys: KeybindingsManager,
          done: (value: unknown) => void,
        ) => ProfileMenu,
      ) => {
        check();
        let result: unknown;
        const menu = factory(
          { terminal: { rows: 24 }, requestRender() {} } as TUI,
          { fg: (_key: string, value: string) => value } as Theme,
          new KeybindingsManager(TUI_KEYBINDINGS),
          (value) => {
            result = value;
          },
        );
        const choice = choices.shift() ?? null;
        if (typeof choice === "function") await choice(menu);
        else if (choice === null) menu.onCancel();
        else menu.onChoose(choice);
        assert.notEqual(result, undefined, "dialog was not closed");
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;
  register(
    {
      on: (event: string, callback: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
        handlers.set(event, callback);
      },
      registerCommand: (_name: string, value: RegisteredCommand) => {
        command = value;
      },
    } as unknown as ExtensionAPI,
    manager,
    dir,
  );
  return {
    ctx,
    choices,
    inputs,
    confirmations,
    notices,
    statuses,
    run: (args = "") => command.handler(args, ctx),
    start: () => handlers.get("session_start")!({}, ctx),
    complete: (prefix: string) => command.getArgumentCompletions!(prefix),
    busy: () => {
      isIdle = false;
    },
    get reloads() {
      return reloads;
    },
    get handlers() {
      return handlers;
    },
  };
}

test("uninitialized startup/completions/cancel never write; first capture preserves actual exclusions", async () => {
  const h = harness();
  await h.start();
  await h.complete("use ");
  await h.run();
  await assert.rejects(readFile(settings), { code: "ENOENT" });
  await put({ extensions: [`-${a}`] });
  h.confirmations.push(true);
  await h.run();
  assert.deepEqual((await disk()).piProfiles.profiles.default.disabled, [
    "~/agent/extensions/a.ts",
  ]);
  assert.equal(h.reloads, 0);
});

test("startup accepts home-relative metadata and canonical saves are stable", async () => {
  await put({
    ...initial(),
    extensions: [`-${a}`],
    piProfiles: {
      version: 1,
      active: "default",
      profiles: { default: { disabled: ["~/agent/extensions/a.ts"] } },
    },
  });
  const before = await readFile(settings, "utf8");
  const h = harness();
  await h.start();
  await h.start();
  assert.equal(await readFile(settings, "utf8"), before);
  assert.deepEqual(h.notices, []);
  assert.equal(h.reloads, 0);
});

test("activation commits target once and reload is terminal", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  h.choices.push("apply");
  await h.run("use small");
  assert.equal(h.reloads, 1);
  assert.equal((await disk()).piProfiles.active, "small");
  assert.deepEqual((await disk()).extensions, [`-${a}`]);
  assert.deepEqual(h.notices, []);
});

test("external edits reconcile to disk-selected profile, same-profile choice can reload", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  const external = initial();
  external.piProfiles.active = "small";
  await put({ ...external, extensions: [`-${a}`] });
  await h.run();
  assert.match(h.statuses.at(-1)!, /profile:small.*reload needed/);
  assert.deepEqual((await disk()).piProfiles.profiles.default.disabled, []);
  h.choices.push("apply");
  await h.run("use small");
  assert.equal(h.reloads, 1);
});

test("active rename does not reload or mark selection stale", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  h.choices.push("rename", "default", null);
  h.inputs.push("stable");
  await h.run("manage");
  assert.equal((await disk()).piProfiles.active, "stable");
  assert.equal(h.reloads, 0);
  assert.equal(h.statuses.at(-1), "profile:stable");
});

test("inactive save changes metadata only; active apply reloads", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  h.choices.push((view) => {
    view.onChoose(`entry:${a}`);
    view.onChoose(":save");
  }, null);
  await h.run("edit small");
  assert.deepEqual((await disk()).piProfiles.profiles.small.disabled, []);
  assert.equal(h.reloads, 0);
  h.choices.push((view) => {
    view.onChoose(`entry:${a}`);
    view.onChoose(":activate");
  }, "apply");
  await h.run("edit default");
  assert.equal(h.reloads, 1);
  assert.deepEqual((await disk()).piProfiles.profiles.default.disabled, [
    "~/agent/extensions/a.ts",
  ]);
});

test("stale drafts and busy-after-editor actions do not commit or reload", async () => {
  for (const change of ["disk", "busy"]) {
    await put(initial());
    const h = harness();
    await h.start();
    h.choices.push(async (view) => {
      if (change === "disk") await put({ ...initial(), npmCommand: ["other-npm"] });
      else h.busy();
      view.onChoose(`entry:${a}`);
      view.onChoose(":save");
    });
    await h.run("edit small");
    assert.equal(h.reloads, 0);
    assert.deepEqual((await disk()).piProfiles.profiles.small.disabled, [
      change === "disk" ? a : "~/agent/extensions/a.ts",
    ]);
    assert.match(h.notices.at(-1)!, change === "disk" ? /stale/ : /busy/);
  }
});

test("cancelling an apply preview returns to the same dirty draft", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  h.choices.push(
    (view) => {
      view.onChoose(`entry:${a}`);
      view.onChoose(":activate");
    },
    "cancel",
    (view) => {
      assert.match(view.render(150).join("\n"), /1 draft changes/);
      view.onCancel();
    },
    null,
  );
  h.confirmations.push(true);
  await h.run("edit default");
  assert.deepEqual((await disk()).piProfiles.profiles.default.disabled, []);
  assert.equal(h.reloads, 0);
});

test("normalizing external selectors then switching uses the refreshed catalog", async () => {
  await put({ ...initial(), extensions: ["!**/a.ts"] });
  const h = harness();
  h.choices.push("apply");
  await h.run("use small");
  assert.deepEqual(h.notices, []);
  assert.equal(h.reloads, 1);
  assert.deepEqual((await disk()).piProfiles.profiles.default.disabled, [
    "~/agent/extensions/a.ts",
  ]);
});

test("incomplete inventory blocks reconciliation and every profile write", async () => {
  const original = { ...initial(), packages: [join(home, "missing-package")] };
  await put(original);
  const h = harness();
  await h.start();
  await h.run("edit small");
  assert.deepEqual(await disk(), original);
  assert.equal(h.reloads, 0);
  assert.ok(h.notices.every((message) => /Missing package/.test(message)));
});

test("non-TUI events and busy commands never mutate; shutdown has no handler", async () => {
  await put(initial());
  for (const mode of ["rpc", "json", "print"] as const) {
    const h = harness();
    h.ctx.mode = mode;
    await h.start();
    await h.run("use small");
    assert.equal(h.reloads, 0);
    assert.equal(h.statuses.length, 0);
  }
  const h = harness();
  h.busy();
  await h.run();
  assert.match(h.notices[0], /busy/);
  assert.equal(h.handlers.has("session_shutdown"), false);
  assert.deepEqual(await disk(), initial());
});

test("create draft cancellation leaves no new profile; duplicate and delete are management actions", async () => {
  await put(initial());
  const h = harness();
  await h.start();
  await h.run("new cancelled");
  assert.equal(Object.hasOwn((await disk()).piProfiles.profiles, "cancelled"), false);
  h.inputs.push("copy");
  h.choices.push("duplicate", "small", null);
  await h.run("manage");
  assert.deepEqual((await disk()).piProfiles.profiles.copy, {
    disabled: ["~/agent/extensions/a.ts"],
  });
  h.choices.push("delete", "copy", null);
  h.confirmations.push(true);
  await h.run("manage");
  assert.equal(Object.hasOwn((await disk()).piProfiles.profiles, "copy"), false);
});

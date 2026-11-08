import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discover } from "../src/catalog.ts";
import { projectSelection } from "../src/selection.ts";
import { register } from "../src/register.ts";

test("missing child and removed/reinstalled package keep exact previous exclusions", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-profiles-reinstall-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const agent = join(home, "agent");
    await mkdir(join(agent, "extensions"), { recursive: true });
    const manager = join(agent, "extensions", "manager.ts");
    await writeFile(manager, "export default () => {}");
    const pkg = join(home, "pkg");
    await mkdir(join(pkg, "extensions"), { recursive: true });
    const child = join(pkg, "extensions", "child.ts");
    await writeFile(child, "export default () => {}");
    let document: Record<string, unknown> = { packages: [pkg] };
    document = await projectSelection(document, await discover(document, agent, manager), [child]);
    await rm(child);
    document = await projectSelection(document, await discover(document, agent, manager), [child]);
    await writeFile(child, "export default () => {}");
    assert.equal(
      (await discover(document, agent, manager)).extensions.find((e) => e.path === child)?.enabled,
      false,
    );
    document.packages = [];
    document = await projectSelection(document, await discover(document, agent, manager), [child]);
    assert.deepEqual(document.extensions, [`-${child}`]);
    document.piProfiles = {
      version: 1,
      active: "default",
      profiles: { default: { disabled: [child] } },
    };
    document.packages = [pkg];
    const settings = join(agent, "settings.json");
    const { piProfiles, ...global } = document;
    await writeFile(settings, JSON.stringify(global));
    await writeFile(join(agent, "pi-profiles.json"), JSON.stringify(piProfiles));
    let startup!: (_event: unknown, ctx: ExtensionContext) => Promise<void>;
    register(
      {
        on: (_name: string, handler: typeof startup) => {
          startup = handler;
        },
        registerCommand() {},
      } as unknown as ExtensionAPI,
      manager,
      agent,
    );
    const errors: string[] = [];
    await startup({}, {
      mode: "tui",
      isIdle: () => true,
      ui: {
        setStatus() {},
        notify: (text: string) => {
          errors.push(text);
        },
      },
    } as unknown as ExtensionContext);
    assert.deepEqual(errors, []);
    document = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(
      (await discover(document, agent, manager)).extensions.find((e) => e.path === child)?.enabled,
      false,
    );
    assert.deepEqual(document.extensions, []);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

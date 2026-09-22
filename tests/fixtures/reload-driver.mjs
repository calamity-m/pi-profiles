import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

const here = dirname(fileURLToPath(import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = join(process.env.HOME, "cwd");
const pkg = join(process.env.HOME, "fixtures");
await mkdir(cwd, { recursive: true });
await mkdir(pkg, { recursive: true });
await mkdir(agentDir, { recursive: true });
await cp(join(here, "alpha.js"), join(pkg, "alpha.js"));
await cp(join(here, "bravo.js"), join(pkg, "bravo.js"));
await writeFile(
  join(pkg, "package.json"),
  JSON.stringify({ type: "module", pi: { extensions: ["alpha.js", "bravo.js"] } }),
);
const settingsPath = join(agentDir, "settings.json");
await writeFile(
  settingsPath,
  JSON.stringify({
    packages: [repo, { source: pkg, extensions: ["-bravo.js"] }],
    piProfiles: {
      version: 1,
      active: "alpha",
      profiles: {
        alpha: { disabled: [join(pkg, "bravo.js")] },
        bravo: { disabled: [join(pkg, "alpha.js")] },
      },
    },
    enableInstallTelemetry: false,
  }),
);
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const sm = SessionManager.inMemory(cwd);
sm.appendMessage({
  role: "user",
  content: [{ type: "text", text: "Preserve this conversation" }],
  timestamp: 1,
});
const { session, extensionsResult } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  sessionManager: sm,
  noTools: "builtin",
});
assert.deepEqual(extensionsResult.errors, []);
const errors = [],
  statuses = [];
const choices = [];
const ui = {
  notify: (message, type) => {
    if (type === "error") errors.push(message);
  },
  setStatus: (_key, text) => statuses.push(text),
  confirm: async () => true,
  custom: async (factory) => {
    let value;
    const menu = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color, text) => text },
      new KeybindingsManager(TUI_KEYBINDINGS),
      (v) => {
        value = v;
      },
    );
    const choice = choices.shift();
    if (choice) menu.onChoose(choice);
    else menu.onCancel();
    assert.notEqual(value, undefined);
    return value;
  },
};
await session.bindExtensions({
  mode: "tui",
  uiContext: ui,
  onError: (error) => errors.push(error),
  commandContextActions: {
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: () => session.reload(),
  },
});
const id = session.sessionId;
const transcript = JSON.stringify(session.messages);
const names = () => session.extensionRunner.getRegisteredCommands().map((command) => command.name);
assert.ok(names().includes("fixture-alpha"));
assert.ok(!names().includes("fixture-bravo"));
assert.ok(session.getAllTools().some((tool) => tool.name === "fixture_alpha"));
await session.prompt("/fixture-alpha");
await session.extensionRunner.emit({ type: "session_info_changed", name: "probe" });
choices.push("apply");
await session.prompt("/profile use bravo");
assert.deepEqual(errors, []);
assert.equal(session.sessionId, id);
assert.equal(JSON.stringify(session.messages), transcript);
assert.ok(!names().includes("fixture-alpha"));
assert.ok(names().includes("fixture-bravo"));
assert.ok(!session.getAllTools().some((tool) => tool.name === "fixture_alpha"));
assert.ok(session.getAllTools().some((tool) => tool.name === "fixture_bravo"));
await session.prompt("/fixture-bravo");
await session.extensionRunner.emit({ type: "session_info_changed", name: "probe2" });
const log = (await readFile(process.env.PI_PROFILES_FIXTURE_LOG, "utf8")).trim().split("\n");
assert.deepEqual(log, [
  "alpha:start",
  "alpha:command",
  "alpha:hook",
  "alpha:shutdown",
  "bravo:start",
  "bravo:command",
  "bravo:hook",
]);
assert.equal(statuses.at(-1), "profile:bravo");
// Newly installed global entrypoints appear in both curated profiles, without membership edits.
await mkdir(join(agentDir, "extensions"), { recursive: true });
await writeFile(
  join(agentDir, "extensions", "new.js"),
  "export default pi => pi.registerCommand('fixture-new', {handler: async () => {}});",
);
await session.prompt("/profile");
assert.match(statuses.at(-1), /reload needed/);
choices.push("apply");
await session.prompt("/profile use bravo");
assert.ok(names().includes("fixture-new"));
choices.push("apply");
await session.prompt("/profile use alpha");
assert.ok(names().includes("fixture-new"));
assert.ok(names().includes("fixture-alpha"));
assert.ok(!names().includes("fixture-bravo"));
assert.deepEqual(errors, []);
assert.equal(session.sessionId, id);
assert.equal(JSON.stringify(session.messages), transcript);
session.dispose();
console.log(
  "Real profile reload preserved transcript and swapped commands, tools, hooks; new extensions default on.",
);

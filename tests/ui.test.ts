import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { editProfile, type EditorEntry } from "../src/ui/profile-editor.ts";
import { pickAction, pickProfile, ProfileMenu } from "../src/ui/profile-picker.ts";

const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const plainTheme = { fg: (_color: string, text: string) => text } as Theme;
const down = "\x1b[B";
const up = "\x1b[A";
const enter = "\r";
const escape = "\x1b";
const tab = "\t";
type View = Component & Focusable;
const input = (view: Component, ...data: string[]) =>
  data.forEach((key) => view.handleInput?.(key));
const text = (view: Component) => view.render(160).join("\n");

function harness(scripts: ((view: View) => void)[], answers: boolean[] = []) {
  const confirmations: string[] = [];
  const terminal = { rows: 24 };
  const tui = { terminal, requestRender() {} } as unknown as TUI;
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (
        factory: (
          tui: TUI,
          theme: Theme,
          keys: KeybindingsManager,
          done: (value: unknown) => void,
        ) => View,
      ) => {
        let result: unknown = undefined;
        const view = factory(tui, plainTheme, keys, (value) => {
          result = value;
        });
        view.focused = true;
        const script = scripts.shift();
        assert.ok(script, "unexpected custom prompt");
        script(view);
        assert.notEqual(result, undefined, "script must close the component");
        return result;
      },
      confirm: async (title: string, message: string) => {
        confirmations.push(`${title} ${message}`);
        assert.ok(answers.length, "unexpected confirmation");
        return answers.shift();
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, terminal, confirmations };
}

const entries: EditorEntry[] = [
  { path: "/pkg/a.ts", source: "npm:pkg", enabled: true, locked: false },
  { path: "/pkg/b.ts", source: "npm:pkg", enabled: false, locked: false },
  { path: "/pkg/manager.ts", source: "npm:pkg", enabled: true, locked: true },
  {
    path: "/pkg/legacy.ts",
    source: "npm:pkg",
    enabled: true,
    locked: false,
    unsupported: "Loose file registration",
  },
  { path: "/other/new.ts", source: "local", enabled: true, locked: false },
];

const state = {
  version: 1 as const,
  active: "stable",
  profiles: {
    stable: { disabled: ["/pkg/b.ts"], description: "Daily work" },
    minimal: { disabled: [], description: "Focused tools" },
  },
};

test("profile picker shows metadata, searches descriptions and returns profile names", async () => {
  const { ctx } = harness([
    (view) => {
      assert.match(text(view), /stable \(active\).*1 excluded.*Daily work/);
      assert.match(text(view), /Create profile/);
      assert.match(text(view), /Manage profiles/);
      input(view, "Focused", enter);
    },
  ]);
  assert.equal(await pickProfile(ctx, state), "minimal");
});

test("main actions have reserved values; shortcut pickers contain only profiles", async () => {
  for (const [query, value] of [
    ["Create", ":new"],
    ["Manage", ":manage"],
  ]) {
    const { ctx } = harness([(view) => input(view, query, enter)]);
    assert.equal(await pickProfile(ctx, state), value);
  }
  const { ctx } = harness([
    (view) => {
      assert.doesNotMatch(text(view), /Create profile|Manage profiles/);
      input(view, escape);
    },
  ]);
  assert.equal(await pickProfile(ctx, state, "edit"), null);
});

test("generic action picker searches labels and cancels an empty result", async () => {
  const { ctx } = harness([
    (view) => {
      input(view, "absent");
      assert.match(text(view), /No matches/);
      input(view, enter, escape);
    },
  ]);
  assert.equal(
    await pickAction(ctx, "Manage", [{ value: "rename", label: "Rename profile" }]),
    null,
  );
});

test("group toggles affect current editable children, not locked/unsupported/other/missing paths", async () => {
  const original = ["/pkg/b.ts", "/absent.ts"];
  const { ctx } = harness([
    (view) => {
      assert.match(text(view), /\[mixed\] npm:pkg/);
      input(view, enter); // Mixed -> all editable children enabled.
      assert.match(text(view), /1 draft changes/);
      input(view, enter); // All -> disabled, without excluding manager or legacy.
      assert.match(text(view), /\[locked\]/);
      assert.match(text(view), /\[unsupported\]/);
      input(view, tab, tab, enter);
    },
  ]);
  assert.deepEqual(await editProfile(ctx, "minimal", original, entries, false), {
    disabled: ["/absent.ts", "/pkg/a.ts", "/pkg/b.ts"],
    activate: false,
  });
  assert.deepEqual(original, ["/pkg/b.ts", "/absent.ts"]);
});

test("filtered source bulk toggle includes hidden current children but no future identities", async () => {
  const { ctx } = harness([
    (view) => {
      input(view, "a.ts", enter, tab, tab, enter);
    },
  ]);
  assert.deepEqual(await editProfile(ctx, "minimal", [], entries, false), {
    disabled: ["/pkg/a.ts", "/pkg/b.ts"],
    activate: false,
  });
});

test("individual toggles are reversible and missing exclusions can be explicitly removed", async () => {
  const { ctx } = harness([
    (view) => {
      input(view, down, enter); // First child, on -> off.
      assert.match(text(view), /1 draft changes/);
      input(view, enter);
      assert.match(text(view), /0 draft changes/);
      input(view, "missing", enter);
      assert.match(text(view), /missing: removed/);
      input(view, tab, tab, enter);
    },
  ]);
  assert.deepEqual(await editProfile(ctx, "minimal", ["/absent.ts"], entries, false), {
    disabled: [],
    activate: false,
  });
});

test("manager and unsupported entries are read-only even when selected directly", async () => {
  const { ctx } = harness([
    (view) => {
      input(view, "manager", down, enter);
      assert.match(text(view), /0 draft changes/);
      input(view, "\x15", "legacy", down, enter);
      assert.match(text(view), /0 draft changes/);
      input(view, tab, enter);
    },
  ]);
  assert.deepEqual(await editProfile(ctx, "minimal", [], entries, false), {
    disabled: [],
    activate: false,
  });
});

test("dirty escape asks before discarding and declining preserves the draft", async () => {
  const { ctx, confirmations } = harness(
    [
      (view) => input(view, down, enter, escape),
      (view) => {
        assert.match(text(view), /1 draft changes/);
        assert.match(text(view), /\[off\] a.ts/);
        input(view, tab, tab, enter);
      },
    ],
    [false],
  );
  assert.deepEqual(await editProfile(ctx, "minimal", [], entries, false), {
    disabled: ["/pkg/a.ts"],
    activate: false,
  });
  assert.match(confirmations[0], /Discard 1 changes/);
});

test("Cancel action confirms dirty discard; clean escape needs no confirmation", async () => {
  const dirty = harness([(view) => input(view, enter, tab, tab, up, enter)], [true]);
  assert.equal(await editProfile(dirty.ctx, "minimal", [], entries, false), null);
  const clean = harness([(view) => input(view, escape)]);
  assert.equal(await editProfile(clean.ctx, "minimal", [], entries, false), null);
  assert.equal(clean.confirmations.length, 0);
});

test("active editor only applies/reloads; inactive Save & activate returns activate", async () => {
  const active = harness([
    (view) => {
      assert.match(text(view), /Apply & reload/);
      assert.doesNotMatch(text(view), /Save/);
      input(view, tab, tab, enter);
    },
  ]);
  assert.deepEqual(await editProfile(active.ctx, "stable", [], entries, true), {
    disabled: [],
    activate: true,
  });
  const inactive = harness([(view) => input(view, tab, tab, down, enter)]);
  assert.deepEqual(await editProfile(inactive.ctx, "minimal", [], entries, false), {
    disabled: [],
    activate: true,
  });
});

test("render bounds follow resize, including narrow/short screens and reachable actions", () => {
  let height = 24;
  const menu = new ProfileMenu(
    "Long title",
    plainTheme,
    keys,
    () => height,
    () => {},
  );
  menu.setItems(
    Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `Extension ${i} 漢字` })),
  );
  menu.actions = [
    { value: "save", label: "Save" },
    { value: "cancel", label: "Cancel" },
  ];
  menu.focused = true;
  for (height of [24, 12, 7, 6, 4, 3, 2, 1]) {
    for (const width of [100, 40, 12, 5, 2, 1, 0]) {
      for (let focus = 0; focus < 3; focus++) {
        const lines = menu.render(width);
        assert.ok(lines.length <= height);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${width}x${height}`,
        );
        input(menu, tab);
      }
    }
  }
  let chosen = "";
  menu.onChoose = (value) => {
    chosen = value;
  };
  input(menu, tab, tab);
  assert.match(text(menu), /Save/);
  input(menu, down);
  assert.match(text(menu), /Cancel/);
  input(menu, enter);
  assert.equal(chosen, "cancel");
});

test("IME cursor follows search focus; theme invalidation renders current colors", () => {
  let color = "31";
  const theme = { fg: (_role: string, value: string) => `\x1b[${color}m${value}\x1b[0m` } as Theme;
  const menu = new ProfileMenu(
    "Profiles",
    theme,
    keys,
    () => 20,
    () => {},
  );
  menu.setItems([{ value: "x", label: "Example" }]);
  menu.focused = true;
  input(menu, "漢字");
  assert.ok(text(menu).includes(CURSOR_MARKER));
  assert.match(text(menu), /漢字/);
  input(menu, tab);
  assert.ok(!text(menu).includes(CURSOR_MARKER));
  input(menu, tab);
  assert.ok(text(menu).includes(CURSOR_MARKER));
  menu.focused = false;
  assert.ok(!text(menu).includes(CURSOR_MARKER));
  color = "32";
  menu.invalidate();
  assert.ok(text(menu).includes("\x1b[32m"));
  assert.ok(!text(menu).includes("\x1b[31m"));
});

test("navigation and displayed hints use injected bindings, not defaults", () => {
  const customKeys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+x",
    "tui.select.cancel": "ctrl+q",
  });
  const menu = new ProfileMenu(
    "Profiles",
    plainTheme,
    customKeys,
    () => 12,
    () => {},
  );
  menu.setItems([
    { value: "one", label: "One" },
    { value: "two", label: "Two" },
  ]);
  let chosen: string | null = null;
  menu.onChoose = (value) => {
    chosen = value;
  };
  assert.match(text(menu), /ctrl\+x.*ctrl\+q.*ctrl\+n/);
  input(menu, "\x0e", "\x18");
  assert.equal(chosen, "two");
});

test("non-TUI modes never open custom prompts", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const ctx = { mode } as ExtensionContext;
    assert.equal(await pickProfile(ctx, state), null);
    assert.equal(await editProfile(ctx, "stable", [], entries, true), null);
  }
});

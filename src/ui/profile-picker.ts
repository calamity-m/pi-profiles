import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  SelectList,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { ProfileState } from "../profiles.ts";

/** Shared, bounded search/list view for the profile picker and draft editor. */
export class ProfileMenu implements Component, Focusable {
  title: string;
  items: SelectItem[] = [];
  actions: SelectItem[] = [];
  onSearch: (query: string) => void = () => {};
  onChoose: (value: string) => void = () => {};
  onCancel: () => void = () => {};
  private input: Input;
  private focus: "search" | "items" | "actions" = "search";
  private index = 0;
  private actionIndex = 0;
  private hasFocus = false;
  private pageSize = 5;
  private theme: Theme;
  private keys: KeybindingsManager;
  private height: () => number;
  private requestRender: () => void;

  constructor(
    title: string,
    theme: Theme,
    keys: KeybindingsManager,
    height: () => number,
    requestRender: () => void,
  ) {
    this.title = title;
    this.theme = theme;
    this.keys = keys;
    this.height = height;
    this.requestRender = requestRender;
    this.input = new Input({
      prompt: "/ ",
      placeholder: "Search",
      placeholderStyle: (text) => theme.fg("dim", text),
    });
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.focus === "search";
  }

  /** Update rows without losing the selected identity after a draft toggle. */
  setItems(items: SelectItem[]): void {
    const selected = this.items[this.index]?.value;
    this.items = items;
    const index = items.findIndex((item) => item.value === selected);
    this.index = index < 0 ? 0 : index;
  }

  private keyHint(
    id:
      | "tui.input.tab"
      | "tui.select.confirm"
      | "tui.select.cancel"
      | "tui.select.up"
      | "tui.select.down",
  ): string {
    return this.keys.getKeys(id).join("/") || "unbound";
  }

  handleInput(data: string): void {
    const keys = this.keys;
    if (keys.matches(data, "tui.select.cancel")) {
      this.onCancel();
    } else if (keys.matches(data, "tui.input.tab")) {
      this.focus =
        this.focus === "search"
          ? "items"
          : this.focus === "items" && this.actions.length
            ? "actions"
            : "search";
    } else if (keys.matches(data, "tui.select.confirm")) {
      const item =
        this.focus === "actions" ? this.actions[this.actionIndex] : this.items[this.index];
      if (item) this.onChoose(item.value);
    } else if (
      keys.matches(data, "tui.select.up") ||
      keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.pageUp") ||
      keys.matches(data, "tui.select.pageDown")
    ) {
      const up = keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.pageUp");
      const page =
        keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown");
      const count = this.focus === "actions" ? this.actions.length : this.items.length;
      if (count) {
        const current = this.focus === "actions" ? this.actionIndex : this.index;
        const next =
          (current + (up ? -1 : 1) * (page ? Math.min(this.pageSize, count) : 1) + count) % count;
        if (this.focus === "actions") this.actionIndex = next;
        else this.index = next;
      }
      if (this.focus === "search") this.focus = "items";
    } else {
      this.focus = "search";
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) {
        this.index = 0;
        this.onSearch(this.input.getValue());
      }
    }
    this.focused = this.hasFocus;
    this.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private list(
    items: SelectItem[],
    index: number,
    rows: number,
    width: number,
    focused: boolean,
  ): string[] {
    const theme = this.theme;
    const list = new SelectList(items, Math.max(1, items.length <= rows ? rows : rows - 1), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg(focused ? "accent" : "muted", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: () => theme.fg("muted", "No matches"),
    });
    list.setSelectedIndex(index);
    return list.render(Math.max(4, width)).slice(0, rows);
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.min(24, this.height()));
    const lines: string[] = [];
    const showTitle = height >= 6;
    const showSearch = height >= 3 || this.focus === "search";
    const showHint = height >= 4;
    const actionRows = this.actions.length && height >= 7 ? Math.min(3, this.actions.length) : 0;
    const listRows = Math.max(
      0,
      height - Number(showTitle) - Number(showSearch) - Number(showHint) - actionRows,
    );
    this.pageSize = Math.max(1, listRows - 1);
    if (showTitle) lines.push(this.theme.fg("accent", this.title));
    if (showSearch) lines.push(...this.input.render(Math.max(4, width)));
    if (listRows) {
      const actionsOnly = this.focus === "actions" && !actionRows;
      lines.push(
        ...this.list(
          actionsOnly ? this.actions : this.items,
          actionsOnly ? this.actionIndex : this.index,
          listRows,
          width,
          this.focus !== "search" && (actionsOnly || this.focus === "items"),
        ),
      );
    }
    if (actionRows)
      lines.push(
        ...this.list(this.actions, this.actionIndex, actionRows, width, this.focus === "actions"),
      );
    if (showHint) {
      lines.push(
        this.theme.fg(
          "dim",
          width < 70
            ? `${this.keys.getKeys("tui.input.tab")[0] ?? "tab"} focus · ${this.keys.getKeys("tui.select.confirm")[0] ?? "enter"} act · ${(this.keys.getKeys("tui.select.cancel")[0] ?? "escape").replace("escape", "esc")} back`
            : `${this.keyHint("tui.input.tab")} focus • ${this.keyHint("tui.select.confirm")} select/toggle • ${this.keyHint("tui.select.cancel")} back • ${this.keyHint("tui.select.up")}/${this.keyHint("tui.select.down")} move`,
        ),
      );
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, Math.max(0, width), ""));
  }
}

/** Search labeled actions, returning their value or null on cancellation. */
export async function pickAction(
  ctx: ExtensionContext,
  title: string,
  items: { value: string; label: string; description?: string }[],
): Promise<string | null> {
  if (ctx.mode !== "tui") return null;
  return ctx.ui.custom<string | null>((tui, theme, keys, done) => {
    const menu = new ProfileMenu(
      title,
      theme,
      keys,
      () => Math.max(1, tui.terminal.rows - 5),
      () => tui.requestRender(),
    );
    menu.setItems(items);
    menu.onSearch = (query) => {
      const text = query.toLowerCase().trim();
      menu.setItems(
        items.filter((item) =>
          `${item.label} ${item.description ?? ""}`.toLowerCase().includes(text),
        ),
      );
    };
    menu.onChoose = done;
    menu.onCancel = () => done(null);
    return menu;
  });
}

/** Pick a profile; the main picker also returns :new and :manage actions. */
export function pickProfile(
  ctx: ExtensionContext,
  state: ProfileState,
  action?: "use" | "edit",
): Promise<string | null> {
  const items: SelectItem[] = Object.entries(state.profiles).map(([name, profile]) => ({
    value: name,
    label: `${name}${name === state.active ? " (active)" : ""}`,
    description: `${profile.disabled.length} excluded${profile.description ? ` • ${profile.description}` : ""}`,
  }));
  if (!action) {
    items.push(
      { value: ":new", label: "Create profile" },
      { value: ":manage", label: "Manage profiles" },
    );
  }
  return pickAction(ctx, action === "edit" ? "Edit profile" : "Global profiles", items);
}

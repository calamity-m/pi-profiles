import { basename, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { ProfileMenu } from "./profile-picker.ts";

/** Catalog-independent entrypoint metadata consumed by the draft editor. */
export interface EditorEntry {
  path: string;
  enabled: boolean;
  locked: boolean;
  source: string;
  unsupported?: string;
}

/** Edit exclusions without writing settings; activate requests application and reload by the caller. */
export async function editProfile(
  ctx: ExtensionContext,
  name: string,
  disabled: readonly string[],
  entries: readonly EditorEntry[],
  active: boolean,
  initialDraft: readonly string[] = disabled,
): Promise<{ disabled: string[]; activate: boolean } | null> {
  if (ctx.mode !== "tui") return null;
  const original = new Set(disabled);
  const draft = new Set(initialDraft);
  const groups = new Map<string, EditorEntry[]>();
  for (const entry of entries) {
    if (entry.locked) draft.delete(entry.path);
    const group = groups.get(entry.source) ?? [];
    group.push(entry);
    groups.set(entry.source, group);
  }
  const discovered = new Set(entries.map((entry) => entry.path));
  const missing = [...original].filter((path) => !discovered.has(path));
  const editable = (entry: EditorEntry) => !entry.locked && entry.unsupported === undefined;
  const enabled = (entry: EditorEntry) =>
    entry.locked || (entry.unsupported !== undefined ? entry.enabled : !draft.has(entry.path));
  const changes = () =>
    [...new Set([...original, ...draft])].filter((path) => original.has(path) !== draft.has(path));
  let query = "";

  while (true) {
    const choice = await ctx.ui.custom<"save" | "activate" | null>((tui, theme, keys, done) => {
      const menu = new ProfileMenu(
        "",
        theme,
        keys,
        () => Math.max(1, tui.terminal.rows - 5),
        () => tui.requestRender(),
      );
      const toggles = new Map<string, () => void>();
      const refresh = () => {
        const rows: SelectItem[] = [];
        toggles.clear();
        const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase().trim());
        for (const [source, children] of groups) {
          const visible = children.filter((entry) =>
            matches(
              `${source} ${entry.path} ${entry.locked ? "locked" : ""} ${entry.unsupported !== undefined ? `unsupported ${entry.unsupported}` : ""}`,
            ),
          );
          if (!visible.length) continue;
          const count = children.filter(enabled).length;
          const state = count === children.length ? "enabled" : count === 0 ? "disabled" : "mixed";
          const value = `group:${source}`;
          const managed = children.filter(editable);
          rows.push({
            value,
            label: `[${state}] ${isAbsolute(source) ? basename(source) : source}`,
            description: managed.length
              ? `${source} • Toggle ${managed.length} current children; future children stay on`
              : `${source} • Read-only source`,
          });
          toggles.set(value, () => {
            const turnOn = managed.some((entry) => draft.has(entry.path));
            for (const entry of managed) {
              if (turnOn) draft.delete(entry.path);
              else draft.add(entry.path);
            }
          });
          for (const entry of visible) {
            const value = `entry:${entry.path}`;
            const marker = entry.locked
              ? "locked"
              : entry.unsupported !== undefined
                ? "unsupported"
                : enabled(entry)
                  ? "on"
                  : "off";
            rows.push({
              value,
              label: `  [${marker}] ${basename(entry.path)}`,
              description: entry.locked
                ? "Manager stays enabled"
                : entry.unsupported !== undefined
                  ? `${entry.enabled ? "Enabled" : "Disabled"}; read-only: ${entry.unsupported}. Use settings.extensions instead.`
                  : `${entry.path} • ${source} • ${original.has(entry.path) !== draft.has(entry.path) ? "changed" : "unchanged"}`,
            });
            toggles.set(value, () => {
              if (!editable(entry)) return;
              if (draft.has(entry.path)) draft.delete(entry.path);
              else draft.add(entry.path);
            });
          }
        }
        for (const path of missing) {
          if (!matches(`missing ${path}`)) continue;
          const value = `missing:${path}`;
          rows.push({
            value,
            label: `[missing${draft.has(path) ? "" : ": removed"}] ${basename(path)}`,
            description: draft.has(path)
              ? `Remove retained exclusion: ${path}`
              : `Restore retained exclusion: ${path}`,
          });
          toggles.set(value, () => {
            if (draft.has(path)) draft.delete(path);
            else draft.add(path);
          });
        }
        menu.title = `${name}${active ? " (active)" : ""} • ${changes().length} draft changes`;
        menu.setItems(rows);
      };
      menu.actions = active
        ? [
            { value: ":activate", label: "Apply & reload" },
            { value: ":cancel", label: "Cancel" },
          ]
        : [
            { value: ":save", label: "Save" },
            { value: ":activate", label: "Save & activate" },
            { value: ":cancel", label: "Cancel" },
          ];
      menu.onSearch = (text) => {
        query = text;
        refresh();
      };
      menu.onChoose = (value) => {
        if (value === ":cancel") done(null);
        else if (value === ":save") done("save");
        else if (value === ":activate") done("activate");
        else {
          toggles.get(value)?.();
          refresh();
        }
      };
      menu.onCancel = () => done(null);
      // Each custom prompt owns fresh components; the draft lives outside their lifecycle.
      query = "";
      refresh();
      return menu;
    });
    if (choice === null) {
      if (
        !changes().length ||
        (await ctx.ui.confirm("Discard draft?", `Discard ${changes().length} changes to ${name}?`))
      )
        return null;
      continue;
    }
    return { disabled: [...draft], activate: active || choice === "activate" };
  }
}

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ProfileState } from "./profiles.ts";

const actions = {
  use: "Switch global profile and reload extensions",
  edit: "Edit a profile's extension exclusions",
  new: "Create a profile from the current exclusions",
  manage: "Create, duplicate, rename, describe or delete profiles",
} as const;

export type ProfileCommand = { action: "pick" | keyof typeof actions; name?: string };

/** Parse the deliberately small, unquoted /profile command grammar. */
export function parseCommand(args: string): ProfileCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { action: "pick" };
  const [action, name] = parts;
  if (!Object.hasOwn(actions, action) || parts.length > 2 || (action === "manage" && name)) {
    throw new Error(
      "Use /profile, /profile use <name>, /profile edit <name>, /profile new [name], or /profile manage.",
    );
  }
  return { action: action as keyof typeof actions, ...(name ? { name } : {}) };
}

/** Complete full argument replacements without discovery or settings mutations. */
export function completeArguments(prefix: string, state?: ProfileState): AutocompleteItem[] | null {
  const input = prefix.trimStart();
  const match = /^(use|edit)\s+([^\s]*)$/.exec(input);
  const items: AutocompleteItem[] = match
    ? Object.entries(state?.profiles ?? {})
        .filter(([name]) => name.startsWith(match[2]))
        .map(([name, profile]) => ({
          value: `${match[1]} ${name}`,
          label: name,
          description: `${name === state?.active ? "Global active · " : ""}${profile.disabled.length} excluded${profile.description ? ` · ${profile.description}` : ""}`,
        }))
    : Object.entries(actions)
        .filter(([action]) => action.startsWith(input))
        .map(([action, description]) => ({ value: action, label: action, description }));
  return items.length ? items : null;
}

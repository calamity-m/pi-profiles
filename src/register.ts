import { basename, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discover, type Catalog } from "./catalog.ts";
import { completeArguments, parseCommand } from "./commands.ts";
import {
  createProfile,
  deleteProfile,
  duplicateProfile,
  reconcileProfile,
  renameProfile,
  validateState,
  type ProfileState,
} from "./profiles.ts";
import { projectSelection } from "./selection.ts";
import { commitSettings, readSettings, type SettingsSnapshot } from "./settings.ts";
import { pickAction, pickProfile } from "./ui/profile-picker.ts";
import { editProfile, type EditorEntry } from "./ui/profile-editor.ts";

function idle(ctx: ExtensionContext): void {
  if (!ctx.isIdle())
    throw new Error("Pi is busy. Wait for the agent to finish, then retry /profile.");
}

function requireProfile(state: ProfileState, name: string): void {
  if (!Object.hasOwn(state.profiles, name)) {
    throw new Error(`Unknown profile '${name}'. Open /profile to choose a profile.`);
  }
}

/** Register global profile commands. agentDir is injectable for isolated SDK sessions/tests. */
export function register(pi: ExtensionAPI, managerPath: string, agentDir = getAgentDir()): void {
  const settingsPath = join(agentDir, "settings.json");
  let observedSignature: string | undefined;
  let running = false;
  let reloadNeeded = false;

  function footer(ctx: ExtensionContext, state?: ProfileState): void {
    ctx.ui.setStatus(
      "pi-profiles",
      state ? `profile:${state.active}${reloadNeeded ? " · reload needed" : ""}` : undefined,
    );
  }

  async function save(
    ctx: ExtensionContext,
    snapshot: SettingsSnapshot,
    proposed: Record<string, unknown>,
    catalog: Catalog,
  ) {
    idle(ctx);
    const current = await discover(snapshot.document, agentDir, managerPath);
    if (
      JSON.stringify([current.extensions, current.nonExtensions]) !==
      JSON.stringify([catalog.extensions, catalog.nonExtensions])
    ) {
      throw new Error("Extension inventory changed; reopen the stale profile draft.");
    }
    idle(ctx);
    return commitSettings(snapshot, proposed);
  }

  async function refresh(ctx: ExtensionContext, startup = false) {
    let snapshot = await readSettings(settingsPath);
    if (!Object.hasOwn(snapshot.document, "piProfiles")) {
      if (startup) {
        // Observe without onboarding or writes; incomplete inventory is reported on first use.
        try {
          observedSignature = (await discover(snapshot.document, agentDir, managerPath)).signature;
        } catch {
          observedSignature = undefined;
        }
      }
      footer(ctx);
      return { snapshot, state: undefined, catalog: undefined };
    }
    let catalog = await discover(snapshot.document, agentDir, managerPath);
    if (startup) observedSignature = catalog.signature;
    reloadNeeded = observedSignature !== catalog.signature;
    const saved = validateState(snapshot.document.piProfiles);
    const tombstones = new Set((snapshot.document.extensions ?? []) as string[]);
    const savedExclusions = new Set(saved.profiles[saved.active].disabled);
    // An uninstalled package leaves exact top-level tombstones. Promote them on
    // reinstall before treating the package's default-on state as an external edit.
    const state = reconcileProfile(
      saved,
      catalog.extensions.map((entry) => ({
        ...entry,
        enabled:
          entry.owner !== "global" &&
          savedExclusions.has(entry.path) &&
          tombstones.has(`-${entry.path}`)
            ? false
            : entry.enabled,
      })),
    );
    const proposed = await projectSelection(
      snapshot.document,
      catalog,
      state.profiles[state.active].disabled,
    );
    proposed.piProfiles = state;
    if (JSON.stringify(proposed) !== JSON.stringify(snapshot.document)) {
      snapshot = await save(ctx, snapshot, proposed, catalog);
      catalog = await discover(snapshot.document, agentDir, managerPath);
      reloadNeeded = observedSignature !== catalog.signature;
    }
    footer(ctx, state);
    return { snapshot, state, catalog };
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      await refresh(ctx, true);
    } catch (error) {
      ctx.ui.notify(`Profiles: ${String(error)}`, "error");
    }
  });

  pi.registerCommand("profile", {
    description: "Choose and manage global extension profiles",
    getArgumentCompletions: async (prefix) => {
      try {
        const { document } = await readSettings(settingsPath);
        return completeArguments(
          prefix,
          Object.hasOwn(document, "piProfiles") ? validateState(document.piProfiles) : undefined,
        );
      } catch {
        return completeArguments(prefix);
      }
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (running) {
        ctx.ui.notify("A profile dialog is already open.", "warning");
        return;
      }
      running = true;
      let reloading = false;
      try {
        idle(ctx);
        let command = parseCommand(args);
        workflow: for (;;) {
          let { snapshot, state, catalog } = await refresh(ctx);
          if (!state || !catalog) {
            catalog = await discover(snapshot.document, agentDir, managerPath);
            if (
              !(await ctx.ui.confirm(
                "Capture global selection as default?",
                "Profiles store exclusions. Existing allowlists, wildcards and disable-all filters become exact exclusions of current extensions; new extensions will be on by default. No packages are installed or removed.",
              ))
            )
              return;
            state = reconcileProfile(
              { version: 1, active: "default", profiles: { default: { disabled: [] } } },
              catalog.extensions,
            );
            const proposed = await projectSelection(
              snapshot.document,
              catalog,
              state.profiles.default.disabled,
            );
            proposed.piProfiles = state;
            snapshot = await save(ctx, snapshot, proposed, catalog);
            catalog = await discover(snapshot.document, agentDir, managerPath);
            // First capture preserves current selection, but is not a runtime observation.
            reloadNeeded = observedSignature !== catalog.signature;
            footer(ctx, state);
          }

          let action = command.action;
          let name = command.name;
          command = { action: "pick" };
          if (action === "pick") {
            const choice = await pickProfile(ctx, state);
            if (!choice) return;
            if (choice === ":new") action = "new";
            else if (choice === ":manage") action = "manage";
            else {
              action = "use";
              name = choice;
            }
          }
          if ((action === "use" || action === "edit") && !name) {
            name = (await pickProfile(ctx, state, action)) ?? undefined;
            if (!name) continue;
          }
          if (action === "manage") {
            const operation = await pickAction(ctx, "Manage profiles", [
              { value: "new", label: "Create profile" },
              { value: "duplicate", label: "Duplicate profile" },
              { value: "rename", label: "Rename profile" },
              { value: "description", label: "Edit description" },
              { value: "edit", label: "Edit extensions" },
              { value: "delete", label: "Delete profile" },
            ]);
            if (!operation) continue;
            if (operation === "new") {
              command = { action: "new" };
              continue;
            }
            name = (await pickProfile(ctx, state, "edit")) ?? undefined;
            if (!name) continue;
            requireProfile(state, name);
            if (operation === "edit") {
              command = { action: "edit", name };
              continue;
            }
            let next = state;
            if (operation === "duplicate" || operation === "rename") {
              const target = await ctx.ui.input(
                operation === "rename" ? "New profile name" : "Duplicate as",
                "lowercase-slug",
              );
              if (target === undefined) continue;
              next =
                operation === "rename"
                  ? renameProfile(state, name, target)
                  : duplicateProfile(state, name, target);
            } else if (operation === "description") {
              const description = await ctx.ui.input(
                `Description for ${name}`,
                state.profiles[name].description ?? "",
              );
              if (description === undefined) continue;
              next = validateState(state);
              next.profiles[name] = { ...next.profiles[name], description };
            } else if (operation === "delete") {
              next = deleteProfile(state, name);
              if (
                !(await ctx.ui.confirm(
                  `Delete ${name}?`,
                  "The saved profile will be removed. Installed extensions are not removed.",
                ))
              )
                continue;
            }
            await save(ctx, snapshot, { ...snapshot.document, piProfiles: next }, catalog);
            footer(ctx, next);
            continue;
          }
          if (action === "new") {
            name ??= await ctx.ui.input("New profile name", "lowercase-slug");
            if (name === undefined) continue;
            state = createProfile(state, name);
            action = "edit";
          }
          if (!name) continue;
          requireProfile(state, name);
          const originalDisabled = state.profiles[name].disabled;
          let draftDisabled = originalDisabled;
          for (;;) {
            if (action === "edit") {
              const entries: EditorEntry[] = catalog.extensions.map((entry) => ({
                path: entry.path,
                enabled: entry.enabled,
                locked: entry.locked,
                source: entry.source,
                unsupported: entry.unsupportedReason,
              }));
              const draft = await editProfile(
                ctx,
                name,
                originalDisabled,
                entries,
                name === state.active,
                draftDisabled,
              );
              if (!draft) continue workflow;
              draftDisabled = draft.disabled;
              state = validateState(state);
              state.profiles[name].disabled = draft.disabled;
              if (!draft.activate) {
                await save(ctx, snapshot, { ...snapshot.document, piProfiles: state }, catalog);
                footer(ctx, state);
                continue workflow;
              }
            } else if (name === state.active && !reloadNeeded) {
              return;
            }
            const disabled = new Set(state.profiles[name].disabled);
            const changes = catalog.extensions.filter(
              (entry) =>
                !entry.locked && entry.supported && entry.enabled === disabled.has(entry.path),
            );
            const diff = changes.map((entry) => ({
              label: `${disabled.has(entry.path) ? "Disable" : "Enable"}: ${basename(entry.path)}`,
              description: entry.path,
            }));
            let confirmation: string | null;
            do {
              confirmation = await pickAction(
                ctx,
                `${name === state.active ? "Reload current profile" : `Use ${name}`}?`,
                [
                  ...diff.map((item, index) => ({ value: `diff:${index}`, ...item })),
                  {
                    value: "apply",
                    label: "Apply & reload",
                    description: `${changes.length} changes · conversation retained; extension memory resets`,
                  },
                  { value: "cancel", label: "Cancel" },
                ],
              );
            } while (confirmation?.startsWith("diff:"));
            if (confirmation !== "apply") {
              if (action === "edit") continue;
              continue workflow;
            }
            const proposed = await projectSelection(
              snapshot.document,
              catalog,
              state.profiles[name].disabled,
            );
            proposed.piProfiles = { ...state, active: name };
            await save(ctx, snapshot, proposed, catalog);
            reloading = true;
            await ctx.reload();
            return;
          }
        }
      } catch (error) {
        if (!reloading) ctx.ui.notify(`Profiles: ${String(error)}`, "error");
      } finally {
        running = false;
      }
    },
  });
}

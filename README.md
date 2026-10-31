# pi-profiles

Named, curated **global extension profiles** for Pi. Profiles share installed packages and remember exclusions—not allowlists. Newly installed extensions and new package entrypoints are enabled by default in every profile.

Requires Node >=22.19.0. Developed and tested against Pi **1.4.0**; discovery/filter compatibility is version-sensitive.

## Install

From this checkout:

```sh
npm ci
pi install /absolute/path/to/pi-profiles
```

Restart Pi or use `/reload`. Install globally: project-only installation or `pi -e` alone cannot provide persistent profile management. The manager is locked on in every profile.

## Use

- `/profile` opens a searchable picker with **Create profile** and **Manage profiles**.
- `/profile use <name>` switches profile and reloads the extension runtime.
- `/profile edit <name>` opens a draft extension editor.
- `/profile new [name]` creates a profile from the current exclusions.
- `/profile manage` offers create, duplicate, rename, description, edit and delete.

Type `/profile ` or `/profile use ` to see action descriptions or profile-name completions. Missing names open a picker/input. Names are lowercase slugs, up to 64 characters, using letters, digits, `_` and `-` (first character must be a letter or digit).

On first use, choose whether to capture your global selection as `default`. Loading an uninitialized manager does not write settings or open onboarding. Capture normalizes existing allowlists, wildcard exclusions and disable-all filters into exclusions of **current** candidates. Consequently future extensions become enabled by default.

Search the editor by extension or source. Toggle individual entries or a package's currently discovered children. Group toggles do not exclude future entrypoints. Missing exclusions remain visible and can be removed explicitly. Unsupported package registrations are read-only; the manager is visibly locked. Editing is a draft until saved/applied; cancelling a dirty draft asks before discarding it.

Inactive profiles offer **Save**, **Save & activate**, and **Cancel**. Active profiles offer **Apply & reload** and **Cancel**. Activation previews enable/disable changes and asks before reload. New profiles inherit active exclusions; duplicate also copies the description. Rename preserves selection and does not reload. Switch away before deleting the active profile; the last profile cannot be deleted.

## What a profile means

The footer `profile:stable` identifies the **global configured profile**, not every loaded extension. Project settings and CLI `-e` resources are unmanaged and can override/add to the global selection. Pi's built-in extensions (`codemode`, `tool_search`, MCP) are also unmanaged: explicit `builtin:` selectors are preserved unchanged, not stored per profile. Use `pi config` to manage them. Other running Pi instances keep their loaded runtime until they reload.

Global changes made through `pi config` or `settings.json` become part of the disk-selected profile at the next TUI session start or profile interaction. Inactive profiles are not overwritten. There is no file watcher. If a changed selection is observed after session start, the footer adds `reload needed`; selecting the current profile offers a reload even when its saved-settings diff is empty. Renaming a profile alone does not require reload.

Exclusions use normalized absolute entrypoint paths. Reinstalling the same identity retains exclusions; moved/renamed paths are new identities. Exact selectors are retained for missing paths. When an entire package registration is removed, its exclusions remain as top-level `-path` markers; reconciliation moves those markers back into package filters if the same identity returns. Profiles are not portable across machines. A package with no extensions is fine; unresolved or incompatible packages, malformed configuration, conflicting ownership/aliases, or an unrepresentable selection block writes rather than erase saved exclusions.

Non-extension resources and unrelated settings are preserved. Package sources, versions, order and `autoload` are not managed. This extension never installs, removes or updates packages during inventory. Pi's normal reload can perform its own resource resolution. Legacy npm lookup may execute your configured `npmCommand` wrapper to locate global storage.

## Persistence and safety

Metadata lives under `piProfiles` in global `settings.json`, alongside the extension selectors it describes:

```json
{
  "piProfiles": {
    "version": 1,
    "active": "default",
    "profiles": {
      "default": { "disabled": [] }
    }
  }
}
```

Settings changes require an idle agent. Stale editors fail rather than overwrite concurrent edits to packages, extension selectors, npm lookup configuration or profiles; reopen the editor and retry. Writes lock Pi's logical global settings path, reread fresh unrelated settings, then atomically replace the settings document. Symlinks and existing permissions are preserved. This is atomic replacement, **not power-loss durability**, and noncooperating manual writers can still race.

**Upstream first-creation limitation:** Pi 1.4.0 computes an absent settings file's update before acquiring its lock. Simultaneous first creation by Pi and this manager can therefore lose an update despite cooperative locking. Create the settings file before concurrent use. Existing-file cooperative writes are covered by integration tests.

Pi 1.4.0 cannot normally filter loose local files registered in `packages`; converting fallback extension-directory packages to filter objects also changes loading semantics. These registrations remain unchanged/read-only. To manage them, manually register the extension file/directory in global `settings.extensions` instead. The manager does not silently migrate them.

Reload retains the conversation but resets extension memory. Cleanup of resources/processes is cooperative. A resolved reload promise is not proof every extension loaded successfully: Pi reports extension loading errors. Profiles are **not a security boundary**; extensions run with your permissions.

## Recovery

Fix invalid JSON, malformed `piProfiles`, or unknown schema versions in global `settings.json`; they are never silently replaced with defaults. Resolve missing packages using Pi's normal package commands, then retry. If an extension prevents profile switching, use `pi config` to disable it, fix settings, or restart Pi. Settings represent committed selection; runtime failures do not cause automatic transactional rollback.

Profile management is interactive-TUI-only. Print, JSON and RPC sessions neither prompt nor mutate profile settings.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm run lint
npm run format:check
npm run pack:dry-run
node scripts/tui-smoke.mjs
```

Tests use temporary directories, offline/provider-free fixtures, and public Pi APIs. The real SDK reload test invokes `/profile use` and checks conversation preservation, commands, tools, hooks and default-on discovery. The smoke script launches Pi with isolated HOME, agent directory and cwd, globally registers the manager and fixtures, and prints its temporary paths. Never point smoke checks at your real settings. See `.agents/plans/pi-profiles-092126.md` for the acceptance checklist.

## License

MIT

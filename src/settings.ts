import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { serializeState, validateState } from "./profiles.ts";

/** Global JSON settings; unknown Pi and extension keys are preserved. */
export type GlobalSettings = Record<string, unknown>;

/** A draft's managed-field version and canonical destination (not its replaceable inode). */
export interface SettingsSnapshot {
  path: string;
  document: GlobalSettings;
  fingerprint: string;
  target: string;
  profiles: JsonFile;
  globalFingerprint: string;
}

interface JsonFile {
  path: string;
  target: string;
  value: unknown;
  exists: boolean;
}

/** Profile metadata sits beside Pi's logical settings path, including with symlinked settings. */
export function profilesPath(settingsPath: string): string {
  return join(dirname(resolve(settingsPath)), "pi-profiles.json");
}

const managedKeys = ["packages", "extensions", "npmCommand", "piProfiles"] as const;
const resourceKeys = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`Invalid settings: ${field} must be a non-empty string without NUL characters`);
  }
}

function selectors(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid settings: ${field} must be a string array`);
  for (const [index, entry] of value.entries()) {
    text(entry, `${field}[${index}]`);
    if (/^[!+-]\s*$/.test(entry))
      throw new Error(`Invalid settings: ${field}[${index}] has an empty selector`);
  }
}

/** Validate managed settings before passing them to Pi; unrelated keys remain opaque. */
export function validateDocument(value: unknown): asserts value is GlobalSettings {
  if (!isObject(value)) throw new Error("Invalid settings: JSON root must be an object");
  for (const key of resourceKeys) {
    if (Object.hasOwn(value, key)) selectors(value[key], key);
  }
  if (Object.hasOwn(value, "packages")) {
    if (!Array.isArray(value.packages))
      throw new Error("Invalid settings: packages must be an array");
    for (const [index, entry] of value.packages.entries()) {
      const field = `packages[${index}]`;
      const source: unknown =
        isObject(entry) && Object.hasOwn(entry, "source") ? entry.source : entry;
      text(source, `${field}.source`);
      if (/^(npm|git):\s*$/.test(source))
        throw new Error(`Invalid settings: ${field}.source is empty`);
      if (isObject(entry)) {
        if (Object.hasOwn(entry, "autoload") && typeof entry.autoload !== "boolean") {
          throw new Error(`Invalid settings: ${field}.autoload must be a boolean`);
        }
        for (const key of resourceKeys) {
          if (Object.hasOwn(entry, key)) selectors(entry[key], `${field}.${key}`);
        }
      }
    }
  }
  if (Object.hasOwn(value, "npmCommand")) {
    const command = value.npmCommand;
    if (
      !Array.isArray(command) ||
      command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    ) {
      throw new Error("Invalid settings: npmCommand must be a string array");
    }
    // Pi treats an empty argv as its default npm command.
    if (command.length) text(command[0], "npmCommand[0]");
  }
  if (Object.hasOwn(value, "piProfiles")) validateState(value.piProfiles);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** Hash only selection/source/profile fields; object key order and unrelated settings do not conflict. */
export function fingerprint(document: GlobalSettings): string {
  const managed = Object.fromEntries(
    managedKeys.filter((key) => Object.hasOwn(document, key)).map((key) => [key, document[key]]),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(managed)))
    .digest("hex");
}

function missing(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

// realpath alone cannot resolve an absent file, a dangling link, or a not-yet-created parent.
async function resolveTarget(path: string, links = 0): Promise<string> {
  if (links > 40) throw new Error("Settings symlink chain is too long");
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) {
      return resolveTarget(resolve(dirname(path), await fs.readlink(path)), links + 1);
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`Cannot resolve settings target: ${path}`);
  return join(await resolveTarget(parent, links), basename(path));
}

async function readJson(path: string): Promise<JsonFile> {
  path = resolve(path);
  const target = await resolveTarget(path);
  let value: unknown;
  let exists = false;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Settings target is not a regular file: ${target}`);
    const content = await fs.readFile(target, "utf8");
    value = JSON.parse(content.replace(/^\uFEFF/, ""));
    exists = true;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if ((await resolveTarget(path)) !== target)
    throw new Error("Settings symlink target changed; reopen the profile draft");
  return { path, target, value, exists };
}

/** Read both files without creating or migrating anything. piProfiles is an internal merged view. */
export async function readSettings(path: string): Promise<SettingsSnapshot> {
  const global = await readJson(path);
  const document = global.exists ? global.value : {};
  validateDocument(document);
  const profiles = await readJson(profilesPath(global.path));
  if (profiles.target === global.target)
    throw new Error("Profile metadata and Pi settings must be separate files");
  if (profiles.exists) {
    validateState(profiles.value);
    if (
      Object.hasOwn(document, "piProfiles") &&
      JSON.stringify(canonical(document.piProfiles)) !== JSON.stringify(canonical(profiles.value))
    ) {
      throw new Error(
        "Conflicting profile metadata in settings.json and pi-profiles.json; remove the legacy piProfiles key after choosing which to keep",
      );
    }
  }
  const merged = { ...document };
  if (profiles.exists) merged.piProfiles = profiles.value;
  return {
    path: global.path,
    target: global.target,
    document: merged,
    fingerprint: fingerprint(merged),
    profiles,
    globalFingerprint: fingerprint(document),
  };
}

/** Atomic replacement of one JSON document, retaining links and permissions. */
async function replaceJson(file: JsonFile, value: unknown): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await fs.stat(file.target)).mode & 0o7777;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  await fs.mkdir(dirname(file.target), { recursive: true });
  const temporary = join(dirname(file.target), `.${basename(file.target)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    if ((await resolveTarget(file.path)) !== file.target)
      throw new Error("Settings symlink target changed; reopen the profile draft");
    await fs.rename(temporary, file.target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Lock both logical paths, reject stale drafts and replace each file atomically.
 * Metadata is written first so migration never removes the only copy.
 * The pair is not crash-atomic; a failed settings write restores the old metadata.
 */
export async function commitSettings(
  snapshot: SettingsSnapshot,
  proposed: GlobalSettings,
): Promise<SettingsSnapshot> {
  validateDocument(proposed);
  const patch = JSON.parse(JSON.stringify(proposed)) as GlobalSettings;
  if (Object.hasOwn(patch, "piProfiles"))
    patch.piProfiles = JSON.parse(JSON.stringify(serializeState(patch.piProfiles)));
  await fs.mkdir(dirname(snapshot.path), { recursive: true });
  const options = {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 50, factor: 1.2 },
  };
  const release = await lockfile.lock(snapshot.path, options);
  try {
    const releaseProfiles = await lockfile.lock(snapshot.profiles.path, options);
    try {
      const fresh = await readSettings(snapshot.path);
      if (fresh.target !== snapshot.target || fresh.profiles.target !== snapshot.profiles.target)
        throw new Error("Settings symlink target changed; reopen the profile draft");
      if (
        fresh.fingerprint !== snapshot.fingerprint ||
        fresh.globalFingerprint !== snapshot.globalFingerprint ||
        fresh.profiles.exists !== snapshot.profiles.exists
      )
        throw new Error("Settings changed; reopen the stale profile draft");
      const document = { ...fresh.document };
      for (const key of managedKeys) {
        if (Object.hasOwn(patch, key)) document[key] = patch[key];
        else delete document[key];
      }
      const state = document.piProfiles;
      delete document.piProfiles;
      // Profile deletion is not a supported operation (the last profile cannot be deleted).
      if (state === undefined && fresh.profiles.exists)
        throw new Error("Cannot remove initialized profile metadata");
      const metadataChanged =
        state !== undefined &&
        (!fresh.profiles.exists ||
          JSON.stringify(canonical(state)) !== JSON.stringify(canonical(fresh.profiles.value)));
      if (metadataChanged) await replaceJson(fresh.profiles, state);
      try {
        const global = await readJson(fresh.path);
        if (global.target !== snapshot.target)
          throw new Error("Settings symlink target changed; reopen the profile draft");
        // No need to rewrite settings for metadata-only edits.
        if (
          JSON.stringify(canonical(global.exists ? global.value : {})) !==
          JSON.stringify(canonical(document))
        ) {
          await replaceJson(global, document);
        }
      } catch (error) {
        if (metadataChanged) {
          try {
            if (fresh.profiles.exists) await replaceJson(fresh.profiles, fresh.profiles.value);
            else await fs.unlink(fresh.profiles.target);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Settings write and profile rollback failed; inspect settings.json and pi-profiles.json",
            );
          }
        }
        throw error;
      }
      return await readSettings(snapshot.path);
    } finally {
      await releaseProfiles();
    }
  } finally {
    await release();
  }
}

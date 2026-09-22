import { isAbsolute, normalize } from "node:path";

/** A curated selection expressed as exclusions of logical entrypoint paths. */
export interface Profile {
  description?: string;
  disabled: string[];
}

/** Global profile metadata stored in the piProfiles settings namespace. */
export interface ProfileState {
  version: 1;
  active: string;
  profiles: Record<string, Profile>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error(`Unknown ${label} field: ${String(key)}`);
    }
  }
}

/** Validate a profile slug without trimming or changing its identity. */
export function validateName(name: string): void {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      "Profile names must be 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit",
    );
  }
}

/** Normalize logical absolute paths and deduplicate without resolving symlinks. */
export function normalizeExclusions(paths: readonly string[]): string[] {
  if (!Array.isArray(paths)) throw new Error("Profile disabled must be an array");
  const result = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
      throw new Error("Exclusions must be absolute entrypoint paths without NUL characters");
    }
    result.add(normalize(path));
  }
  return [...result];
}

/** Validate an initialized namespace and return an independent, normalized copy. */
export function validateState(input: unknown): ProfileState {
  const state = object(input, "piProfiles");
  keys(state, ["version", "active", "profiles"], "piProfiles");
  if (!Object.hasOwn(state, "version") || state.version !== 1) {
    throw new Error("Unsupported piProfiles version; expected 1");
  }
  if (!Object.hasOwn(state, "active") || typeof state.active !== "string") {
    throw new Error("piProfiles active must be a profile name");
  }
  validateName(state.active);
  if (!Object.hasOwn(state, "profiles")) throw new Error("piProfiles profiles is required");
  const source = object(state.profiles, "piProfiles profiles");
  const profiles: Record<string, Profile> = Object.create(null);
  for (const name of Reflect.ownKeys(source)) {
    if (typeof name !== "string") throw new Error("Profile names must be strings");
    validateName(name);
    const profile = object(source[name], `Profile ${name}`);
    keys(profile, ["description", "disabled"], `profile ${name}`);
    if (!Object.hasOwn(profile, "disabled")) {
      throw new Error(`Profile ${name} disabled is required`);
    }
    const disabled = normalizeExclusions(profile.disabled as string[]);
    if (Object.hasOwn(profile, "description")) {
      if (typeof profile.description !== "string") {
        throw new Error(`Profile ${name} description must be a string`);
      }
      profiles[name] = { description: profile.description, disabled };
    } else {
      profiles[name] = { disabled };
    }
  }
  if (!Object.hasOwn(profiles, state.active)) {
    throw new Error(`Active profile does not exist: ${state.active}`);
  }
  return { version: 1, active: state.active, profiles };
}

function requireProfile(state: ProfileState, name: string): Profile {
  validateName(name);
  if (!Object.hasOwn(state.profiles, name)) throw new Error(`Profile does not exist: ${name}`);
  return state.profiles[name]!;
}

function requireAvailable(state: ProfileState, name: string): void {
  validateName(name);
  if (Object.hasOwn(state.profiles, name)) throw new Error(`Profile already exists: ${name}`);
}

/** Create a profile from active exclusions, without copying its description or selecting it. */
export function createProfile(state: ProfileState, name: string): ProfileState {
  const next = validateState(state);
  requireAvailable(next, name);
  next.profiles[name] = { disabled: [...requireProfile(next, next.active).disabled] };
  return next;
}

/** Duplicate exclusions and description without changing the selected profile. */
export function duplicateProfile(state: ProfileState, from: string, name: string): ProfileState {
  const next = validateState(state);
  const source = requireProfile(next, from);
  requireAvailable(next, name);
  next.profiles[name] = { ...source, disabled: [...source.disabled] };
  return next;
}

/** Rename a profile, preserving selection when renaming the active profile. */
export function renameProfile(state: ProfileState, from: string, to: string): ProfileState {
  const next = validateState(state);
  const profile = requireProfile(next, from);
  if (from === to) return next;
  requireAvailable(next, to);
  next.profiles[to] = profile;
  delete next.profiles[from];
  if (next.active === from) next.active = to;
  return next;
}

/** Delete an inactive profile; the last profile cannot be deleted. */
export function deleteProfile(state: ProfileState, name: string): ProfileState {
  const next = validateState(state);
  requireProfile(next, name);
  if (Object.keys(next.profiles).length === 1) throw new Error("Cannot delete the last profile");
  if (next.active === name) throw new Error("Cannot delete the active profile; switch first");
  delete next.profiles[name];
  return next;
}

/** Capture actual selection into only the active profile, retaining absent identities. */
export function reconcileProfile(
  state: ProfileState,
  candidates: { path: string; enabled: boolean; locked?: boolean }[],
): ProfileState {
  const next = validateState(state);
  const active = requireProfile(next, next.active);
  const disabled = new Set(active.disabled);
  const locked = new Set<string>();
  for (const candidate of candidates) {
    const path = normalizeExclusions([candidate.path])[0]!;
    if (candidate.enabled) disabled.delete(path);
    else disabled.add(path);
    if (candidate.locked) locked.add(path);
  }
  // A locked manager identity must win even if it appears through multiple registrations.
  for (const path of locked) disabled.delete(path);
  active.disabled = [...disabled];
  return next;
}

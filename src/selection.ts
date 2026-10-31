import { isAbsolute, normalize, relative, sep } from "node:path";
import type { PackageSource } from "@earendil-works/pi-coding-agent";
import {
  discover,
  isBuiltinSelector,
  isDiscoveryRoot,
  selectionSettingsSignature,
  type Catalog,
  type CatalogResource,
} from "./catalog.ts";

const nonExtensionTypes = ["skills", "prompts", "themes"] as const;

function identity(resource: CatalogResource): string {
  return JSON.stringify([
    resource.path,
    resource.canonicalPath,
    resource.owner,
    resource.source,
    resource.root,
  ]);
}

/**
 * Project exact extension opt-outs while preserving discovery roots and other resources.
 * Re-resolves the proposal without imports/installations and refuses unrepresentable changes.
 */
export async function projectSelection(
  document: Record<string, unknown>,
  catalog: Catalog,
  disabled: string[],
): Promise<Record<string, unknown>> {
  if (selectionSettingsSignature(document) !== catalog.settingsSignature) {
    throw new Error("Settings changed since discovery. Refresh the profile catalog and try again.");
  }
  if (disabled.some((path) => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error("Profile exclusions must be absolute extension paths.");
  }
  const exclusions = new Set(disabled.map((path) => normalize(path)));
  const desired = new Map(
    catalog.extensions.map((entry) => [entry.path, entry.locked || !exclusions.has(entry.path)]),
  );
  for (const entry of catalog.extensions) {
    if (!entry.supported && desired.get(entry.path) !== entry.enabled) {
      throw new Error(
        entry.unsupportedReason ??
          `Cannot change read-only registration ${entry.path}. Use settings.extensions instead.`,
      );
    }
  }

  const proposal = structuredClone(document);
  const roots = ((document.extensions ?? []) as string[]).filter(
    (entry) => isDiscoveryRoot(entry) || isBuiltinSelector(entry),
  );
  const lockedPaths = new Set(
    catalog.extensions.filter((entry) => entry.locked).map((entry) => entry.path),
  );
  for (const path of lockedPaths) exclusions.delete(path);
  const ownerOf = (path: string) => {
    const existing = catalog.extensions.find((entry) => entry.path === path);
    if (existing) return existing.owner;
    return (
      catalog.packages
        .filter((pkg) => pkg.supported && path.startsWith(`${pkg.root}${sep}`))
        .sort((a, b) => b.root.length - a.root.length)[0]?.owner ?? "global"
    );
  };
  // Retain exact selectors for missing identities too. Orphan package paths stay
  // as top-level tombstones until the same installed owner returns.
  const topLevelExclusions = [...exclusions]
    .filter((path) => ownerOf(path) === "global")
    .map((path) => `-${path}`);
  if (document.extensions !== undefined || topLevelExclusions.length) {
    proposal.extensions = [...roots, ...topLevelExclusions];
  }
  if (document.packages !== undefined) {
    proposal.packages = catalog.packages.map((pkg): PackageSource => {
      if (!pkg.supported) return structuredClone(pkg.registration);
      const exactExclusions = [...exclusions]
        .filter((path) => ownerOf(path) === pkg.owner)
        .map((path) => `-${relative(pkg.root, path).split(sep).join("/")}`);
      if (typeof pkg.registration === "string" && exactExclusions.length === 0)
        return pkg.registration;
      const entry: Exclude<PackageSource, string> =
        typeof pkg.registration === "string"
          ? { source: pkg.source }
          : structuredClone(pkg.registration);
      // Pi string manifests omit undeclared types; object registrations otherwise
      // fall back to conventional directories, unexpectedly enabling new resources.
      if (typeof pkg.registration === "string" && pkg.manifest !== undefined) {
        for (const type of nonExtensionTypes) {
          if (pkg.manifest[type] === undefined) entry[type] = [];
        }
      }
      if (entry.autoload === false) entry.extensions = ["**/*", ...exactExclusions];
      else if (exactExclusions.length) entry.extensions = exactExclusions;
      else delete entry.extensions;
      return entry;
    });
  }

  const verified = await discover(proposal, catalog.agentDir, catalog.managerPath);
  const actual = new Map(verified.extensions.map((entry) => [entry.path, entry]));
  if (actual.size !== catalog.extensions.length) {
    throw new Error(
      "Projection changed the extension inventory. Refresh discovery; this package's manifest/filter combination may not support exact opt-outs.",
    );
  }
  for (const entry of catalog.extensions) {
    const projected = actual.get(entry.path);
    if (
      !projected ||
      identity(projected) !== identity(entry) ||
      projected.enabled !== desired.get(entry.path)
    ) {
      throw new Error(
        `Cannot represent the requested selection for ${entry.path} without changing its source or discovery behavior. Use settings.extensions or repair the package manifest.`,
      );
    }
    if (entry.locked && !projected.enabled)
      throw new Error("The profile manager must stay enabled.");
  }
  for (const type of nonExtensionTypes) {
    const before = catalog.nonExtensions[type];
    const after = verified.nonExtensions[type];
    const previous = new Map(before.map((entry) => [identity(entry), entry.enabled]));
    const next = new Map(after.map((entry) => [identity(entry), entry.enabled]));
    const changedExisting = [...previous].some(([key, enabled]) => next.get(key) !== enabled);
    const newlyEnabled = after.some((entry) => entry.enabled && !previous.has(identity(entry)));
    const beforeOrder = before.filter((entry) => entry.enabled).map(identity);
    const afterOrder = after.filter((entry) => entry.enabled).map(identity);
    if (
      changedExisting ||
      newlyEnabled ||
      JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder)
    ) {
      throw new Error(
        `Projection would change non-extension ${type} resources or their load order. No settings were written.`,
      );
    }
  }
  const retained = new Set(
    catalog.extensions
      .filter((entry) => entry.enabled && desired.get(entry.path))
      .map((entry) => entry.path),
  );
  const beforeOrder = catalog.extensions
    .filter((entry) => retained.has(entry.path))
    .map((entry) => entry.path);
  const afterOrder = verified.extensions
    .filter((entry) => retained.has(entry.path))
    .map((entry) => entry.path);
  if (JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder)) {
    throw new Error(
      "Projection would reorder retained enabled extensions. Simplify order-sensitive autoload selectors before applying a profile.",
    );
  }
  return proposal;
}

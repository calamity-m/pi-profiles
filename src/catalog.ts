import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants, globSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { satisfies, valid, validRange } from "semver";
import { validateDocument } from "./settings.ts";

const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
type ResourceType = (typeof resourceTypes)[number];
export type NonExtensionType = Exclude<ResourceType, "extensions">;

export interface CatalogResource {
  path: string;
  canonicalPath: string;
  enabled: boolean;
  owner: string;
  source: string;
  root: string;
  relativePath: string;
}

export interface CatalogExtension extends CatalogResource {
  locked: boolean;
  supported: boolean;
  unsupportedReason?: string;
}

export interface CatalogPackage {
  index: number;
  owner: string;
  source: string;
  root: string;
  canonicalRoot: string;
  registration: PackageSource;
  manifest: Partial<Record<ResourceType, string[]>> | undefined;
  supported: boolean;
  unsupportedReason?: string;
}

export interface Catalog {
  agentDir: string;
  managerPath: string;
  extensions: CatalogExtension[];
  packages: CatalogPackage[];
  nonExtensions: Record<NonExtensionType, CatalogResource[]>;
  diagnostics: string[];
  /** Ordered effective global source/selection identity, independent of profile metadata. */
  signature: string;
  /** Guards against projecting a catalog onto a different source/selector document. */
  settingsSignature: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fingerprint only resolver inputs; profile names and unrelated settings do not affect it. */
export function selectionSettingsSignature(document: Record<string, unknown>): string {
  return JSON.stringify([
    document.packages ?? [],
    ...resourceTypes.map((type) => document[type] ?? []),
    document.npmCommand ?? null,
  ]);
}

/** Built-in extension identities are not filesystem paths and remain unmanaged. */
export function isBuiltinSelector(entry: string): boolean {
  return /^[!+-]?builtin:/.test(entry);
}

/** Pi's top-level plain entries discover resources; all other entries only select them. */
export function isDiscoveryRoot(entry: string): boolean {
  return (
    !isBuiltinSelector(entry) &&
    !/^[!+-]/.test(entry) &&
    !entry.includes("*") &&
    !entry.includes("?")
  );
}

function absolutePath(input: string, base: string): string {
  const trimmed = input.trim();
  const home = process.env.HOME || homedir();
  return resolve(
    base,
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed,
  );
}

async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function manifestAt(root: string): Promise<CatalogPackage["manifest"]> {
  const path = join(root, "package.json");
  if (!(await optionalStat(path))) return undefined;
  const value: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  if (!isObject(value)) throw new Error(`${path} must contain a JSON object.`);
  if (value.pi === undefined) return undefined;
  if (!isObject(value.pi)) throw new Error(`${path}: pi must be an object.`);
  const manifest: NonNullable<CatalogPackage["manifest"]> = {};
  for (const type of resourceTypes) {
    const entries = value.pi[type];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`${path}: pi.${type} must be an array of strings.`);
    }
    manifest[type] = entries as string[];
  }
  return manifest;
}

function packageManager(document: Record<string, unknown>, agentDir: string) {
  return new DefaultPackageManager({
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.inMemory(document, { projectTrusted: false }),
  });
}

async function resolveOnly(
  document: Record<string, unknown>,
  agentDir: string,
): Promise<ResolvedPaths> {
  const missing: string[] = [];
  const result = await packageManager(document, agentDir).resolve(async (source) => {
    missing.push(source);
    return "skip";
  });
  if (missing.length)
    throw new Error(
      `Missing or incompatible packages: ${missing.join(", ")}. Install/repair them with pi install before managing profiles.`,
    );
  return result;
}

/**
 * Discover global resources without importing extension modules or installing packages.
 * Throws on incomplete inventories, aliases, or conflicting owners; never treat errors as exclusions.
 */
export async function discover(
  document: Record<string, unknown>,
  agentDir: string,
  managerPath: string,
): Promise<Catalog> {
  validateDocument(document);
  agentDir = resolve(agentDir);
  managerPath = resolve(managerPath);
  const diagnostics: string[] = [];
  const managerCanonical = await realpath(managerPath);
  const manager = packageManager(document, agentDir);
  const packages: CatalogPackage[] = [];
  const canonicalRoots = new Map<string, string>();
  const auditAliases = new Map<string, string>();
  const audited = new Set<string>();

  // Pi intentionally swallows some filesystem/manifest errors. Check resource trees first
  // so a partial read cannot silently become a saved profile's new selection.
  const auditTree = async (path: string, ancestors = new Set<string>()): Promise<void> => {
    const canonical = await realpath(path);
    if (ancestors.has(canonical))
      throw new Error(`Cyclic resource directory: ${path}. Remove the symlink cycle.`);
    const previous = auditAliases.get(canonical);
    if (previous && previous !== path)
      throw new Error(`Resource alias: ${previous} and ${path}. Keep one logical discovery path.`);
    auditAliases.set(canonical, path);
    if (audited.has(path)) return;
    audited.add(path);
    await access(path, constants.R_OK);
    const info = await stat(path);
    if (!info.isDirectory()) return;
    await manifestAt(path);
    const nextAncestors = new Set([...ancestors, canonical]);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await auditTree(join(path, entry.name), nextAncestors);
    }
  };

  for (const [index, registration] of ((document.packages ?? []) as PackageSource[]).entries()) {
    const source = typeof registration === "string" ? registration : registration.source;
    const rootPath = manager.getInstalledPath(source, "user");
    if (!rootPath)
      throw new Error(
        `Missing package ${source}. Install it with pi install or remove its registration before managing profiles.`,
      );
    const root = resolve(rootPath);
    const info = await stat(root);
    const canonicalRoot = await realpath(root);
    const previous = canonicalRoots.get(canonicalRoot);
    if (previous !== undefined)
      throw new Error(
        `Conflicting package ownership: ${previous} and ${source} resolve to ${root}. Keep one registration.`,
      );
    canonicalRoots.set(canonicalRoot, source);
    const manifest = info.isDirectory() ? await manifestAt(root) : undefined;
    if (source.startsWith("npm:")) {
      const spec = source.slice(4).trim();
      const versionAt = spec.lastIndexOf("@");
      const requested = versionAt > 0 ? spec.slice(versionAt + 1) : undefined;
      const pkg: unknown = JSON.parse(
        (await readFile(join(root, "package.json"), "utf8")).replace(/^\uFEFF/, ""),
      );
      const installed = isObject(pkg) ? pkg.version : undefined;
      if (
        typeof installed !== "string" ||
        !valid(installed) ||
        (requested && validRange(requested) && !satisfies(installed, requested))
      ) {
        throw new Error(
          `Missing or incompatible npm package ${source} at ${root}. Run pi install ${source} before managing profiles.`,
        );
      }
    }
    const hasConventions =
      info.isDirectory() &&
      (await Promise.all(resourceTypes.map((type) => optionalStat(join(root, type))))).some(
        Boolean,
      );
    const local =
      !source.startsWith("npm:") && !/^(git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source);
    const supported = !local || (info.isDirectory() && (manifest !== undefined || hasConventions));
    const unsupportedReason = supported
      ? undefined
      : `Read-only ${info.isFile() ? "loose-file" : "fallback-directory"} package ${source}: Pi cannot filter it reliably. Register it in settings.extensions instead.`;
    if (unsupportedReason) diagnostics.push(unsupportedReason);
    packages.push({
      index,
      owner: `package:${index}`,
      source,
      root,
      canonicalRoot,
      registration,
      manifest,
      supported,
      ...(unsupportedReason ? { unsupportedReason } : {}),
    });
    if (info.isFile()) await auditTree(root);
    else {
      for (const type of resourceTypes) {
        const conventional = join(root, type);
        if (await optionalStat(conventional)) await auditTree(conventional);
        for (const entry of manifest?.[type] ?? []) {
          if (/^[!+-]/.test(entry)) continue;
          if (entry.includes("*") || entry.includes("?")) {
            for (const match of globSync(entry, { cwd: root }))
              await auditTree(resolve(root, match));
          } else {
            const target = resolve(root, entry);
            if (!(await optionalStat(target)))
              throw new Error(
                `Missing manifest resource ${target} in ${source}. Repair the package before managing profiles.`,
              );
            await auditTree(target);
          }
        }
      }
      if (!supported) await auditTree(root);
    }
  }
  for (const type of resourceTypes) {
    const automatic = join(agentDir, type);
    if (await optionalStat(automatic)) await auditTree(automatic);
    for (const entry of (document[type] ?? []) as string[]) {
      if (!isDiscoveryRoot(entry)) continue;
      const path = absolutePath(entry, agentDir);
      if (!(await optionalStat(path)))
        throw new Error(
          `Missing ${type} discovery root ${path}. Restore it or remove the stale settings entry.`,
        );
      await auditTree(path);
    }
  }
  const userSkills = join(process.env.HOME || homedir(), ".agents", "skills");
  if (await optionalStat(userSkills)) await auditTree(userSkills);

  const actual = await resolveOnly(document, agentDir);
  const enumerationDocument = {
    ...document,
    packages: packages.map(({ registration }) =>
      typeof registration === "object" && registration.autoload === false
        ? { ...registration, extensions: ["**/*"] }
        : registration,
    ),
  };
  const enumerated = packages.some(
    ({ registration }) => typeof registration === "object" && registration.autoload === false,
  )
    ? await resolveOnly(enumerationDocument, agentDir)
    : actual;

  // Resolve each owner in isolation: Pi deduplicates paths before returning them, which
  // otherwise hides multiple packages (or package/top-level roots) claiming a resource.
  const claims = new Map<string, { path: string; owner: string }>();
  const claim = async (resource: ResolvedResource, owner: string) => {
    const path = resolve(resource.path);
    const canonical = await realpath(path);
    const previous = claims.get(canonical);
    if (previous && (previous.path !== path || previous.owner !== owner)) {
      throw new Error(
        `Conflicting resource ownership or alias: ${previous.path} (${previous.owner}) and ${path} (${owner}). Remove the duplicate registration.`,
      );
    }
    claims.set(canonical, { path, owner });
  };
  const probeDir = join(agentDir, `.pi-profiles-inventory-${randomUUID()}`);
  for (const pkg of packages) {
    let registration: PackageSource =
      typeof pkg.registration === "string" ? pkg.root : { ...pkg.registration, source: pkg.root };
    if (typeof registration === "object" && registration.autoload === false)
      registration = { ...registration, extensions: ["**/*"] };
    const probe = await resolveOnly({ packages: [registration] }, probeDir);
    for (const type of resourceTypes) {
      for (const resource of probe[type]) {
        if (resource.metadata.origin !== "package") continue;
        // Unlike local directories, empty remote packages have no extension fallback.
        if (resource.path === pkg.root && pkg.supported) continue;
        await claim(resource, pkg.owner);
      }
    }
  }
  for (const type of resourceTypes) {
    const roots = ((document[type] ?? []) as string[])
      .filter(isDiscoveryRoot)
      .map((entry) => absolutePath(entry, agentDir));
    const automatic = join(agentDir, type);
    if (await optionalStat(automatic)) roots.push(automatic);
    for (const root of roots) {
      const probe = await resolveOnly({ [type]: [root] }, probeDir);
      for (const resource of probe[type]) {
        if (resource.metadata.source === "local") await claim(resource, "global");
      }
    }
  }

  const describe = async (resource: ResolvedResource): Promise<CatalogResource> => {
    const path = resolve(resource.path);
    const pkg =
      resource.metadata.origin === "package"
        ? packages.find((entry) => entry.source === resource.metadata.source)
        : undefined;
    if (resource.metadata.scope !== "user" || (resource.metadata.origin === "package" && !pkg)) {
      throw new Error(`Unexpected resource owner for ${path}; global inventory is incomplete.`);
    }
    const root = pkg?.root ?? resource.metadata.baseDir ?? agentDir;
    return {
      path,
      canonicalPath: await realpath(path),
      enabled: resource.enabled,
      owner: pkg?.owner ?? "global",
      source: resource.metadata.source,
      root,
      relativePath: relative(root, path).split(sep).join("/"),
    };
  };
  const actualStates = new Map(
    actual.extensions.map((entry) => [resolve(entry.path), entry.enabled]),
  );
  const candidates = new Map(
    [...actual.extensions, ...enumerated.extensions].map((entry) => [resolve(entry.path), entry]),
  );
  const extensions: CatalogExtension[] = [];
  for (const resource of candidates.values()) {
    const entry = await describe(resource);
    const pkg = packages.find((candidate) => candidate.owner === entry.owner);
    let locked = entry.canonicalPath === managerCanonical;
    if (!locked && (await stat(entry.path)).isDirectory()) {
      for (const index of ["index.ts", "index.js"]) {
        const path = join(entry.path, index);
        if (await optionalStat(path)) locked ||= (await realpath(path)) === managerCanonical;
      }
    }
    extensions.push({
      ...entry,
      enabled: actualStates.get(entry.path) ?? false,
      locked,
      supported: pkg?.supported ?? true,
      ...(pkg?.unsupportedReason ? { unsupportedReason: pkg.unsupportedReason } : {}),
    });
  }
  if (!extensions.some((entry) => entry.locked)) {
    throw new Error(
      "pi-profiles is not globally discoverable. Install/register the manager globally; a CLI-only -e load cannot manage persistent profiles.",
    );
  }
  const nonExtensions = {
    skills: await Promise.all(actual.skills.map(describe)),
    prompts: await Promise.all(actual.prompts.map(describe)),
    themes: await Promise.all(actual.themes.map(describe)),
  };
  const effective = [
    packages.map((pkg) => [
      pkg.source,
      pkg.root,
      typeof pkg.registration === "object" ? (pkg.registration.autoload ?? true) : true,
    ]),
    ((document.extensions ?? []) as string[]).filter(
      (entry) => isDiscoveryRoot(entry) || isBuiltinSelector(entry),
    ),
    extensions
      .filter((entry) => entry.enabled)
      .map((entry) => [entry.path, entry.canonicalPath, entry.owner]),
  ];
  return {
    agentDir,
    managerPath,
    extensions,
    packages,
    nonExtensions,
    diagnostics,
    signature: createHash("sha256").update(JSON.stringify(effective)).digest("hex"),
    settingsSignature: selectionSettingsSignature(document),
  };
}

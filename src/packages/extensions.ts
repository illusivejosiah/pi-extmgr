import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, PackageExtensionEntry, PackageResourceEntry, ResourceType, Scope, State } from "../types/index.js";
import { fileExists, readSummary } from "../utils/fs.js";

interface PackageSettingsObject {
  source: string;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

interface SettingsFile {
  packages?: (string | PackageSettingsObject)[];
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized;
}

function normalizeSource(source: string): string {
  return source
    .trim()
    .replace(/\s+\((filtered|pinned)\)$/i, "")
    .trim();
}

function toPackageRoot(pkg: InstalledPackage, cwd: string): string | undefined {
  if (pkg.resolvedPath) {
    return resolve(pkg.resolvedPath);
  }

  if (pkg.source.startsWith("file://")) {
    try {
      return resolve(fileURLToPath(pkg.source));
    } catch {
      return undefined;
    }
  }

  if (
    pkg.source.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(pkg.source) ||
    pkg.source.startsWith("\\\\")
  ) {
    return resolve(pkg.source);
  }

  if (
    pkg.source.startsWith("./") ||
    pkg.source.startsWith("../") ||
    pkg.source.startsWith(".\\") ||
    pkg.source.startsWith("..\\")
  ) {
    return resolve(cwd, pkg.source);
  }

  if (pkg.source.startsWith("~/")) {
    return resolve(join(homedir(), pkg.source.slice(2)));
  }

  return undefined;
}

function getSettingsPath(scope: Scope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".pi", "settings.json");
  }
  return join(getAgentDir(), "settings.json");
}

async function readSettingsFile(
  path: string,
  options?: { strict?: boolean }
): Promise<SettingsFile> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (options?.strict) {
        throw new Error(
          `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (options?.strict) {
        throw new Error(`Invalid settings format in ${path}: expected a JSON object`);
      }
      return {};
    }

    return parsed as SettingsFile;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    if (options?.strict) {
      throw error;
    }

    return {};
  }
}

async function writeSettingsFile(path: string, settings: SettingsFile): Promise<void> {
  const settingsDir = dirname(path);
  await mkdir(settingsDir, { recursive: true });

  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, path);
  } catch {
    await writeFile(path, content, "utf8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function getPackageFilterState(filters: string[] | undefined, extensionPath: string): State {
  if (!filters || filters.length === 0) {
    return "enabled";
  }

  const normalizedTarget = normalizeRelativePath(extensionPath);
  let state: State = "enabled";

  for (const token of filters) {
    if (!token || (token[0] !== "+" && token[0] !== "-")) continue;
    const sign = token[0];
    const path = normalizeRelativePath(token.slice(1));
    if (path !== normalizedTarget) continue;
    state = sign === "+" ? "enabled" : "disabled";
  }

  return state;
}

async function getPackageExtensionState(
  packageSource: string,
  extensionPath: string,
  scope: Scope,
  cwd: string
): Promise<State> {
  const settingsPath = getSettingsPath(scope, cwd);
  const settings = await readSettingsFile(settingsPath);
  const packages = settings.packages ?? [];
  const normalizedSource = normalizeSource(packageSource);

  const entry = packages.find((pkg) => {
    if (typeof pkg === "string") {
      return normalizeSource(pkg) === normalizedSource;
    }
    return normalizeSource(pkg.source) === normalizedSource;
  });

  if (!entry || typeof entry === "string") {
    return "enabled";
  }

  return getPackageFilterState(entry.extensions, extensionPath);
}

async function discoverEntrypoints(packageRoot: string): Promise<string[]> {
  const packageJsonPath = join(packageRoot, "package.json");
  let manifestExtensions: string[] | undefined;

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
    const ext = parsed.pi?.extensions;
    if (Array.isArray(ext)) {
      const entries = ext.filter((value): value is string => typeof value === "string");
      if (entries.length > 0) {
        manifestExtensions = entries;
      }
    }
  } catch {
    // Ignore invalid/missing package.json and fall back.
  }

  if (manifestExtensions && manifestExtensions.length > 0) {
    return manifestExtensions.map((entry) => normalizeRelativePath(entry));
  }

  const indexTs = join(packageRoot, "index.ts");
  if (await fileExists(indexTs)) {
    return ["index.ts"];
  }

  const indexJs = join(packageRoot, "index.js");
  if (await fileExists(indexJs)) {
    return ["index.js"];
  }

  return [];
}

export async function discoverPackageExtensions(
  packages: InstalledPackage[],
  cwd: string
): Promise<PackageExtensionEntry[]> {
  const entries: PackageExtensionEntry[] = [];

  for (const pkg of packages) {
    const packageRoot = toPackageRoot(pkg, cwd);
    if (!packageRoot) continue;

    const extensionPaths = await discoverEntrypoints(packageRoot);
    for (const extensionPath of extensionPaths) {
      const normalizedPath = normalizeRelativePath(extensionPath);
      const absolutePath = resolve(packageRoot, extensionPath);
      const summary = (await fileExists(absolutePath))
        ? await readSummary(absolutePath)
        : "package extension";
      const state = await getPackageExtensionState(pkg.source, normalizedPath, pkg.scope, cwd);

      entries.push({
        id: `pkg-ext:${pkg.scope}:${pkg.source}:${normalizedPath}`,
        packageSource: pkg.source,
        packageName: pkg.name,
        packageScope: pkg.scope,
        extensionPath: normalizedPath,
        absolutePath,
        displayName: `${pkg.name}/${normalizedPath}`,
        summary,
        state,
      });
    }
  }

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

export async function setPackageExtensionState(
  packageSource: string,
  extensionPath: string,
  scope: Scope,
  target: State,
  cwd: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const settingsPath = getSettingsPath(scope, cwd);
    const settings = await readSettingsFile(settingsPath, { strict: true });

    const normalizedSource = normalizeSource(packageSource);
    const normalizedPath = normalizeRelativePath(extensionPath);
    const marker = `${target === "enabled" ? "+" : "-"}${normalizedPath}`;

    const packages = [...(settings.packages ?? [])];
    let index = packages.findIndex((pkg) => {
      if (typeof pkg === "string") {
        return normalizeSource(pkg) === normalizedSource;
      }
      return normalizeSource(pkg.source) === normalizedSource;
    });

    let packageEntry: PackageSettingsObject;
    if (index === -1) {
      packageEntry = { source: packageSource, extensions: [marker] };
      packages.push(packageEntry);
      index = packages.length - 1;
    } else {
      const existing = packages[index];
      if (typeof existing === "string") {
        packageEntry = { source: existing, extensions: [] };
      } else if (existing && typeof existing.source === "string") {
        packageEntry = {
          source: existing.source,
          extensions: Array.isArray(existing.extensions) ? [...existing.extensions] : [],
        };
      } else {
        packageEntry = { source: packageSource, extensions: [] };
      }

      packageEntry.extensions = (packageEntry.extensions ?? []).filter((token) => {
        if (typeof token !== "string") return false;
        if (token[0] !== "+" && token[0] !== "-") return true;
        return normalizeRelativePath(token.slice(1)) !== normalizedPath;
      });
      packageEntry.extensions.push(marker);
      packages[index] = packageEntry;
    }

    settings.packages = packages;

    await writeSettingsFile(settingsPath, settings);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Discover non-extension resources (skills, agents, prompts, themes) from packages.
 */
export async function discoverPackageResources(
  packages: InstalledPackage[],
  cwd: string
): Promise<PackageResourceEntry[]> {
  const entries: PackageResourceEntry[] = [];
  const typeMap: Record<string, ResourceType> = {
    skills: "skill",
    agents: "agent",
    prompts: "prompt",
    themes: "theme",
  };

  for (const pkg of packages) {
    const packageRoot = toPackageRoot(pkg, cwd);
    if (!packageRoot) continue;

    let piManifest: Record<string, unknown> = {};
    try {
      const raw = await readFile(join(packageRoot, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { pi?: Record<string, unknown> };
      piManifest = parsed.pi ?? {};
    } catch {
      continue;
    }

    for (const [key, resourceType] of Object.entries(typeMap)) {
      const declared = piManifest[key];
      if (!declared) continue;

      const paths = Array.isArray(declared) ? declared.filter((v): v is string => typeof v === "string") : typeof declared === "string" ? [declared] : [];

      for (const p of paths) {
        const normalizedPath = normalizeRelativePath(p);
        const absolutePath = resolve(packageRoot, p);

        // Read skill name from SKILL.md if it's a directory
        let summary = resourceType;
        try {
          const { existsSync: es } = await import("node:fs");
          const skillMd = join(absolutePath, "SKILL.md");
          if (es(skillMd)) {
            const content = await readFile(skillMd, "utf8");
            const descMatch = content.match(/description:\s*(.+)/);
            if (descMatch) summary = descMatch[1].trim().slice(0, 80);
          } else if (es(absolutePath)) {
            const content = await readFile(absolutePath, "utf8");
            const descMatch = content.match(/description:\s*(.+)/);
            if (descMatch) summary = descMatch[1].trim().slice(0, 80);
          }
        } catch { /* ignore */ }

        entries.push({
          id: `pkg-res:${pkg.scope}:${pkg.source}:${resourceType}:${normalizedPath}`,
          packageSource: pkg.source,
          packageName: pkg.name,
          packageScope: pkg.scope,
          resourceType,
          resourcePath: normalizedPath,
          displayName: `${pkg.name}/${normalizedPath}`,
          summary,
        });
      }
    }
  }

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

/**
 * Apply defaultDisabled for newly installed packages.
 * If a package declares `pi.defaultDisabled: true` in its package.json
 * and its settings.json entry is still a plain string (never configured),
 * convert it to the disabled format with all resource types set to [].
 */
export async function applyDefaultDisabled(cwd: string): Promise<number> {
  let applied = 0;

  for (const scope of ["global", "project"] as const) {
    const settingsPath = getSettingsPath(scope, cwd);
    let settings: SettingsFile;
    try {
      settings = await readSettingsFile(settingsPath, { strict: true });
    } catch {
      continue;
    }

    const packages = [...(settings.packages ?? [])];
    let changed = false;

    for (let i = 0; i < packages.length; i++) {
      const entry = packages[i];
      // Only process plain string entries (never configured)
      if (typeof entry !== "string") continue;

      const packageRoot = resolvePackageRoot(entry, scope, cwd);
      if (!packageRoot) continue;

      try {
        const raw = await readFile(join(packageRoot, "package.json"), "utf8");
        const parsed = JSON.parse(raw) as { pi?: { defaultDisabled?: boolean } };
        if (parsed.pi?.defaultDisabled === true) {
          packages[i] = {
            source: entry,
            extensions: [],
            skills: [],
            prompts: [],
            themes: [],
          };
          changed = true;
          applied++;
        }
      } catch { /* skip unreadable */ }
    }

    if (changed) {
      settings.packages = packages;
      await writeSettingsFile(settingsPath, settings);
    }
  }

  return applied;
}

function resolvePackageRoot(source: string, scope: "global" | "project", cwd: string): string | null {
  const agentDir = scope === "global" ? getAgentDir() : join(cwd, ".pi", "agent");

  if (source.startsWith("git:")) {
    // git:git@github.com:org/repo.git → ~/.pi/agent/git/github.com/org/repo
    const url = source.slice(4);
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) {
      const repoPath = match[1];
      return join(agentDir, "git", "github.com", repoPath);
    }
  } else if (source.startsWith("npm:")) {
    const name = source.slice(4);
    return join(agentDir, "npm", "node_modules", name);
  }

  return null;
}

export function toProjectRelativePath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith("..") ? path : normalizeRelativePath(rel);
}

/**
 * Check if an entire package is disabled (all resource types set to empty arrays).
 */
export async function isPackageDisabled(
  packageSource: string,
  scope: Scope,
  cwd: string
): Promise<boolean> {
  const settingsPath = getSettingsPath(scope, cwd);
  const settings = await readSettingsFile(settingsPath);
  const packages = settings.packages ?? [];
  const normalizedSource = normalizeSource(packageSource);

  const entry = packages.find((pkg) => {
    if (typeof pkg === "string") return normalizeSource(pkg) === normalizedSource;
    return normalizeSource(pkg.source) === normalizedSource;
  });

  if (!entry || typeof entry === "string") return false;

  // Disabled = all four resource types are explicitly set to empty arrays
  const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;
  return resourceTypes.every((rt) => {
    const val = entry[rt];
    return Array.isArray(val) && val.length === 0;
  });
}

/**
 * Disable an entire package by setting all resource types to empty arrays.
 * The package stays installed on disk but nothing loads.
 */
export async function setPackageDisabled(
  packageSource: string,
  scope: Scope,
  disabled: boolean,
  cwd: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const settingsPath = getSettingsPath(scope, cwd);
    const settings = await readSettingsFile(settingsPath, { strict: true });
    const packages = [...(settings.packages ?? [])];
    const normalizedSource = normalizeSource(packageSource);

    const index = packages.findIndex((pkg) => {
      if (typeof pkg === "string") return normalizeSource(pkg) === normalizedSource;
      return normalizeSource(pkg.source) === normalizedSource;
    });

    if (disabled) {
      // Set all resource types to empty arrays (pi loader treats [] as "load nothing")
      const disabledEntry: PackageSettingsObject = {
        source: typeof packages[index] === "string" ? packages[index] : (packages[index] as PackageSettingsObject).source,
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
      if (index === -1) {
        packages.push(disabledEntry);
      } else {
        packages[index] = disabledEntry;
      }
    } else {
      // Re-enable: revert to plain string source
      if (index !== -1) {
        const existing = packages[index];
        const source = typeof existing === "string" ? existing : existing.source;
        packages[index] = source;
      }
    }

    settings.packages = packages;
    await writeSettingsFile(settingsPath, settings);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

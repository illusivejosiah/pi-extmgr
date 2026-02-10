/**
 * Local extension discovery
 */
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import type { Dirent } from "node:fs";
import type { ExtensionEntry, Scope, State } from "../types/index.js";
import { DISABLED_SUFFIX } from "../constants.js";
import { fileExists, readSummary } from "../utils/fs.js";

interface RootConfig {
  root: string;
  scope: Scope;
  label: string;
}

export async function discoverExtensions(cwd: string): Promise<ExtensionEntry[]> {
  const roots: RootConfig[] = [
    {
      root: join(homedir(), ".pi", "agent", "extensions"),
      scope: "global",
      label: "~/.pi/agent/extensions",
    },
    { root: join(cwd, ".pi", "extensions"), scope: "project", label: ".pi/extensions" },
  ];

  const all: ExtensionEntry[] = [];
  for (const root of roots) {
    all.push(...(await discoverInRoot(root.root, root.scope, root.label)));
  }

  all.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return dedupeExtensions(all);
}

async function discoverInRoot(
  root: string,
  scope: Scope,
  label: string
): Promise<ExtensionEntry[]> {
  let dirEntries: Dirent[];
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // Silently ignore ENOENT (directory doesn't exist) - this is expected
    // for project scope when .pi/extensions doesn't exist yet
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Log other errors for debugging
    console.error(`[extensions-manager] Error reading ${root}:`, error);
    return [];
  }

  const found: ExtensionEntry[] = [];

  for (const item of dirEntries) {
    const name = item.name;

    // Skip hidden files and directories (e.g., .temp, .git, etc.)
    if (name.startsWith(".")) continue;

    if (item.isFile()) {
      const entry = await parseTopLevelFile(root, label, scope, name);
      if (entry) found.push(entry);
      continue;
    }

    if (item.isDirectory()) {
      const entry = await parseDirectoryIndex(root, label, scope, name);
      if (entry) found.push(entry);
    }
  }

  return found;
}

async function parseTopLevelFile(
  root: string,
  label: string,
  scope: Scope,
  fileName: string
): Promise<ExtensionEntry | undefined> {
  const isEnabledTsJs = /\.(ts|js)$/i.test(fileName) && !fileName.endsWith(DISABLED_SUFFIX);
  const isDisabledTsJs = /\.(ts|js)\.disabled$/i.test(fileName);

  if (!isEnabledTsJs && !isDisabledTsJs) return undefined;

  const currentPath = join(root, fileName);
  const activePath = isDisabledTsJs ? currentPath.slice(0, -DISABLED_SUFFIX.length) : currentPath;
  const disabledPath = `${activePath}${DISABLED_SUFFIX}`;
  const state: State = isDisabledTsJs ? "disabled" : "enabled";
  const summary = await readSummary(state === "enabled" ? activePath : disabledPath);

  const relativePath = relative(root, activePath).replace(/\.disabled$/i, "");

  return {
    id: `${scope}:${activePath}`,
    scope,
    state,
    activePath,
    disabledPath,
    displayName: `${label}/${relativePath}`,
    summary,
  };
}

async function parseDirectoryIndex(
  root: string,
  label: string,
  scope: Scope,
  dirName: string
): Promise<ExtensionEntry | undefined> {
  const dir = join(root, dirName);

  for (const ext of [".ts", ".js"]) {
    const activePath = join(dir, `index${ext}`);
    const disabledPath = `${activePath}${DISABLED_SUFFIX}`;

    if (await fileExists(activePath)) {
      return {
        id: `${scope}:${activePath}`,
        scope,
        state: "enabled",
        activePath,
        disabledPath,
        displayName: `${label}/${dirName}/index${ext}`,
        summary: await readSummary(activePath),
      };
    }

    if (await fileExists(disabledPath)) {
      return {
        id: `${scope}:${activePath}`,
        scope,
        state: "disabled",
        activePath,
        disabledPath,
        displayName: `${label}/${dirName}/index${ext}`,
        summary: await readSummary(disabledPath),
      };
    }
  }

  return undefined;
}

function dedupeExtensions(entries: ExtensionEntry[]): ExtensionEntry[] {
  const byId = new Map<string, ExtensionEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return Array.from(byId.values());
}

export async function setExtensionState(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
  target: State
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!entry.activePath || !entry.disabledPath) {
      return { ok: false, error: "Missing paths" };
    }
    if (target === "enabled") {
      await rename(entry.disabledPath, entry.activePath);
    } else {
      await rename(entry.activePath, entry.disabledPath);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeLocalExtension(
  entry: Pick<ExtensionEntry, "activePath" | "disabledPath">,
  cwd: string
): Promise<
  { ok: true; removedPath: string; removedDirectory: boolean } | { ok: false; error: string }
> {
  try {
    const globalRoot = join(homedir(), ".pi", "agent", "extensions");
    const projectRoot = join(cwd, ".pi", "extensions");

    const activeExists = await fileExists(entry.activePath);
    const disabledExists = await fileExists(entry.disabledPath);

    if (!activeExists && !disabledExists) {
      return { ok: false, error: "Extension file no longer exists" };
    }

    const existingPath = activeExists ? entry.activePath : entry.disabledPath;
    const parentDir = dirname(existingPath);
    const normalizedBase = basename(existingPath).replace(/\.disabled$/i, "");
    const isIndexFile = /^index\.(ts|js)$/i.test(normalizedBase);
    const isInsideExtensionDir = parentDir !== globalRoot && parentDir !== projectRoot;

    if (isIndexFile && isInsideExtensionDir) {
      await rm(parentDir, { recursive: true, force: true });
      return { ok: true, removedPath: parentDir, removedDirectory: true };
    }

    await rm(existingPath, { force: true });
    return { ok: true, removedPath: existingPath, removedDirectory: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

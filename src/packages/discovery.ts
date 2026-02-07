/**
 * Package discovery and listing
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { InstalledPackage, NpmPackage, SearchCache } from "../types/index.js";
import { PAGE_SIZE, CACHE_TTL } from "../constants.js";
import { readSummary } from "../utils/fs.js";

let searchCache: SearchCache | null = null;

export function getSearchCache(): SearchCache | null {
  return searchCache;
}

export function setSearchCache(cache: SearchCache | null): void {
  searchCache = cache;
}

export function clearSearchCache(): void {
  searchCache = null;
}

export function isCacheValid(query: string): boolean {
  if (!searchCache) return false;
  if (searchCache.query !== query) return false;
  return Date.now() - searchCache.timestamp < CACHE_TTL;
}

// Import persistent cache
import {
  getCachedSearch,
  setCachedSearch,
  getCachedPackage,
  setCachedPackage,
  getPackageDescriptions,
  getCachedPackageSize,
  setCachedPackageSize,
} from "../utils/cache.js";

export async function searchNpmPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<NpmPackage[]> {
  const searchLimit = Math.min(PAGE_SIZE + 10, 50);

  // Check persistent cache first
  const cached = await getCachedSearch(query);
  if (cached && cached.length > 0) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Using ${cached.length} cached results`, "info");
    }
    return cached;
  }

  if (ctx.hasUI) {
    ctx.ui.notify(`Searching npm for "${query}"...`, "info");
  }

  const res = await pi.exec("npm", ["search", "--json", `--searchlimit=${searchLimit}`, query], {
    timeout: 20000,
    cwd: ctx.cwd,
  });

  if (res.code !== 0) {
    throw new Error(`npm search failed: ${res.stderr || res.stdout || `exit ${res.code}`}`);
  }

  try {
    const parsed = JSON.parse(res.stdout || "[]") as NpmPackage[];
    // Filter to only pi packages when browsing
    const filtered = parsed.filter((p) => {
      if (!p?.name) return false;
      if (query.includes("keywords:pi-package")) {
        return p.keywords?.includes("pi-package");
      }
      return true;
    });

    // Cache the results
    await setCachedSearch(query, filtered);

    return filtered;
  } catch {
    throw new Error("Failed to parse npm search output");
  }
}

export async function getInstalledPackages(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<InstalledPackage[]> {
  const res = await pi.exec("pi", ["list"], { timeout: 10000, cwd: ctx.cwd });
  if (res.code !== 0) return [];

  const text = res.stdout || "";
  if (!text.trim() || /No packages installed/i.test(text)) {
    return [];
  }

  const packages: InstalledPackage[] = [];
  const seenSources = new Set<string>();
  const seenNames = new Set<string>();

  const lines = text.split("\n");
  let currentScope: "global" | "project" = "global";

  for (const line of lines) {
    // Skip empty lines and indented continuation lines (resolved paths)
    // Package lines start with "  " (2 spaces), resolved paths start with "    " (4 spaces)
    if (!line.trim() || line.startsWith("    ")) continue;

    const trimmed = line.trim();

    // Detect scope headers - must be standalone headers, not paths containing these words
    const lowerTrimmed = trimmed.toLowerCase();
    if (
      lowerTrimmed === "global" ||
      lowerTrimmed.startsWith("global packages") ||
      lowerTrimmed.startsWith("global:")
    ) {
      currentScope = "global";
      continue;
    }
    if (
      lowerTrimmed === "project" ||
      lowerTrimmed === "local" ||
      lowerTrimmed.startsWith("project packages") ||
      lowerTrimmed.startsWith("project:") ||
      lowerTrimmed.startsWith("local packages") ||
      lowerTrimmed.startsWith("local:")
    ) {
      currentScope = "project";
      continue;
    }

    // Parse package lines
    const match = trimmed.match(/^[-•]?\s*(npm:|git:|https?:|\/|\.\/|\.\.\/)(.+)$/);
    if (match?.[1] && match[2]) {
      const fullSource = match[1] + match[2];

      // Deduplicate by source
      if (seenSources.has(fullSource)) continue;
      seenSources.add(fullSource);

      // Extract name and version
      let name = fullSource;
      let version: string | undefined;
      let source = fullSource;

      if (fullSource.startsWith("npm:")) {
        const npmPart = fullSource.slice(4);
        // Scoped packages: @scope/name@version
        const scopedMatch = npmPart.match(/^(@[^@]+\/[^@]+)@(.+)$/);
        if (scopedMatch?.[1] && scopedMatch[2]) {
          name = scopedMatch[1];
          version = scopedMatch[2];
        } else {
          // Regular packages: name@version
          const simpleMatch = npmPart.match(/^([^@]+)@(.+)$/);
          if (simpleMatch?.[1] && simpleMatch[2]) {
            name = simpleMatch[1];
            version = simpleMatch[2];
          } else {
            name = npmPart;
          }
        }
      } else if (fullSource.startsWith("git:")) {
        name = fullSource.slice(4).split("@")[0] || fullSource;
      } else if (fullSource.includes("node_modules/")) {
        // Handle full paths like /home/user/.fnm/.../node_modules/package-name
        const nmMatch = fullSource.match(/node_modules\/(.+)$/);
        if (nmMatch?.[1]) {
          // Handle scoped packages: node_modules/@scope/name
          const pkgPart = nmMatch[1];
          if (pkgPart.startsWith("@")) {
            // @scope/name format
            name = pkgPart;
          } else {
            name = pkgPart;
          }
        }
      } else {
        // For local file paths, extract just the filename
        const pathParts = fullSource.split("/");
        const fileName = pathParts[pathParts.length - 1];
        if (fileName) {
          name = fileName;
        }
      }

      // Deduplicate by package name (handles same pkg in both npm: and node_modules/ path formats)
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      const pkg: InstalledPackage = { source, name, scope: currentScope };
      if (version !== undefined) {
        pkg.version = version;
      }
      packages.push(pkg);
    }
  }

  // Fetch metadata (descriptions and sizes) for packages in parallel
  await addPackageMetadata(packages, ctx, pi);

  return packages;
}

/**
 * Fetch package size from npm view
 */
async function fetchPackageSize(
  pkgName: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<number | undefined> {
  // Check cache first
  const cachedSize = await getCachedPackageSize(pkgName);
  if (cachedSize !== undefined) return cachedSize;

  try {
    // Try to get unpacked size from npm view
    const res = await pi.exec("npm", ["view", pkgName, "dist.unpackedSize", "--json"], {
      timeout: 5000,
      cwd: ctx.cwd,
    });
    if (res.code === 0) {
      try {
        const size = JSON.parse(res.stdout) as number;
        if (typeof size === "number" && size > 0) {
          await setCachedPackageSize(pkgName, size);
          return size;
        }
      } catch {
        // Ignore parse errors
      }
    }
  } catch {
    // Silently ignore errors
  }
  return undefined;
}

async function addPackageMetadata(
  packages: InstalledPackage[],
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  // First, try to get descriptions from cache
  const cachedDescriptions = await getPackageDescriptions(packages);
  for (const [source, description] of cachedDescriptions) {
    const pkg = packages.find((p) => p.source === source);
    if (pkg) pkg.description = description;
  }

  // Process remaining packages in batches
  const batchSize = 5;
  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (pkg) => {
        // Skip if already has description from cache
        const needsDescription = !pkg.description;
        const needsSize = pkg.size === undefined && pkg.source.startsWith("npm:");

        if (!needsDescription && !needsSize) return;

        try {
          if (pkg.source.endsWith(".ts") || pkg.source.endsWith(".js")) {
            // For local files, read description from file
            if (needsDescription) {
              pkg.description = await readSummary(pkg.source);
            }
          } else if (pkg.source.startsWith("npm:")) {
            const pkgName = pkg.source.slice(4).split("@")[0];
            if (pkgName) {
              // Get description
              if (needsDescription) {
                const cached = await getCachedPackage(pkgName);
                if (cached?.description) {
                  pkg.description = cached.description;
                } else {
                  // Fetch from npm and cache it
                  const res = await pi.exec("npm", ["view", pkgName, "description", "--json"], {
                    timeout: 5000,
                    cwd: ctx.cwd,
                  });
                  if (res.code === 0) {
                    try {
                      const desc = JSON.parse(res.stdout) as string;
                      if (typeof desc === "string" && desc) {
                        pkg.description = desc;
                        // Cache the description
                        await setCachedPackage(pkgName, { name: pkgName, description: desc });
                      }
                    } catch {
                      // Ignore parse errors
                    }
                  }
                }
              }

              // Get size
              if (needsSize) {
                pkg.size = await fetchPackageSize(pkgName, ctx, pi);
              }
            }
          } else if (pkg.source.startsWith("git:")) {
            if (needsDescription) pkg.description = "git repository";
          } else {
            if (needsDescription) pkg.description = "local package";
          }
        } catch {
          // Silently ignore fetch errors
        }
      })
    );
  }
}

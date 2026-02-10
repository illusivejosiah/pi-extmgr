/**
 * Persistent cache for package metadata to reduce npm API calls
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { NpmPackage, InstalledPackage } from "../types/index.js";
import { CACHE_LIMITS } from "../constants.js";

const CACHE_DIR = join(homedir(), ".pi", "agent", ".extmgr-cache");
const CACHE_FILE = join(CACHE_DIR, "metadata.json");

interface CachedPackageData {
	name: string;
	description?: string | undefined;
	version?: string | undefined;
	size?: number | undefined;
	timestamp: number;
}

interface CacheData {
	version: number;
	packages: Map<string, CachedPackageData>;
	lastSearch?:
		| {
				query: string;
				results: string[];
				timestamp: number;
		  }
		| undefined;
}

let memoryCache: CacheData | null = null;

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir(): Promise<void> {
	try {
		await access(CACHE_DIR);
	} catch {
		await mkdir(CACHE_DIR, { recursive: true });
	}
}

/**
 * Load cache from disk
 */
async function loadCache(): Promise<CacheData> {
	if (memoryCache) return memoryCache;

	try {
		await ensureCacheDir();
		const data = await readFile(CACHE_FILE, "utf8");
		const parsed = JSON.parse(data) as {
			version: number;
			packages: Record<string, CachedPackageData>;
			lastSearch?: CacheData["lastSearch"];
		};

		memoryCache = {
			version: parsed.version,
			packages: new Map(Object.entries(parsed.packages)),
			lastSearch: parsed.lastSearch ?? undefined,
		};
	} catch (error) {
		// Cache doesn't exist or is corrupted, start fresh
		if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
			// Only log actual errors, not missing file
			console.warn("[extmgr] Cache load failed, resetting:", error.message);
		}
		memoryCache = {
			version: 1,
			packages: new Map(),
		};
	}

	return memoryCache;
}

/**
 * Save cache to disk
 */
async function saveCache(): Promise<void> {
	if (!memoryCache) return;

	try {
		await ensureCacheDir();
		const data: {
			version: number;
			packages: Record<string, CachedPackageData>;
			lastSearch?: { query: string; results: string[]; timestamp: number } | undefined;
		} = {
			version: memoryCache.version,
			packages: Object.fromEntries(memoryCache.packages),
			lastSearch: memoryCache.lastSearch,
		};

		await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
	} catch (error) {
		console.warn("[extmgr] Cache save failed:", error instanceof Error ? error.message : error);
	}
}

/**
 * Check if cached data is still valid (within TTL)
 */
function isCacheValid(timestamp: number): boolean {
	return Date.now() - timestamp < CACHE_LIMITS.metadataTTL;
}

/**
 * Get cached package data
 */
export async function getCachedPackage(name: string): Promise<CachedPackageData | null> {
	const cache = await loadCache();
	const data = cache.packages.get(name);

	if (!data || !isCacheValid(data.timestamp)) {
		return null;
	}

	return data;
}

/**
 * Set cached package data
 */
export async function setCachedPackage(
	name: string,
	data: Omit<CachedPackageData, "timestamp">
): Promise<void> {
	const cache = await loadCache();
	cache.packages.set(name, {
		...data,
		timestamp: Date.now(),
	});
	await saveCache();
}

/**
 * Get cached search results
 */
export async function getCachedSearch(query: string): Promise<NpmPackage[] | null> {
	const cache = await loadCache();

	if (!cache.lastSearch || cache.lastSearch.query !== query) {
		return null;
	}

	if (Date.now() - cache.lastSearch.timestamp >= CACHE_LIMITS.searchTTL) {
		return null;
	}

	// Reconstruct packages from cached names
	const packages: NpmPackage[] = [];
	for (const name of cache.lastSearch.results) {
		const pkg = cache.packages.get(name);
		if (pkg) {
			packages.push({
				name: pkg.name,
				description: pkg.description ?? undefined,
				version: pkg.version ?? undefined,
			});
		}
	}

	return packages;
}

/**
 * Set cached search results
 */
export async function setCachedSearch(query: string, packages: NpmPackage[]): Promise<void> {
	const cache = await loadCache();

	// Update cache with new packages
	for (const pkg of packages) {
		cache.packages.set(pkg.name, {
			name: pkg.name,
			description: pkg.description ?? undefined,
			version: pkg.version ?? undefined,
			timestamp: Date.now(),
		});
	}

	// Store search results
	cache.lastSearch = {
		query,
		results: packages.map((p) => p.name),
		timestamp: Date.now(),
	};

	await saveCache();
}

/**
 * Clear all cached data
 */
export async function clearCache(): Promise<void> {
	memoryCache = {
		version: 1,
		packages: new Map(),
	};
	await saveCache();
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
	totalPackages: number;
	validEntries: number;
	expiredEntries: number;
}> {
	const cache = await loadCache();
	let valid = 0;
	let expired = 0;

	for (const [, data] of cache.packages) {
		if (isCacheValid(data.timestamp)) {
			valid++;
		} else {
			expired++;
		}
	}

	return {
		totalPackages: cache.packages.size,
		validEntries: valid,
		expiredEntries: expired,
	};
}

/**
 * Batch get descriptions for installed packages (uses cache first)
 */
export async function getPackageDescriptions(
	packages: InstalledPackage[]
): Promise<Map<string, string>> {
	const descriptions = new Map<string, string>();
	const cache = await loadCache();

	for (const pkg of packages) {
		if (pkg.source.startsWith("npm:")) {
			const pkgName = pkg.source.slice(4).split("@")[0];
			if (pkgName) {
				const cached = cache.packages.get(pkgName);
				if (cached?.description && isCacheValid(cached.timestamp)) {
					descriptions.set(pkg.source, cached.description);
				}
			}
		}
	}

	return descriptions;
}

/**
 * Get package size from cache
 */
export async function getCachedPackageSize(name: string): Promise<number | undefined> {
	const cache = await loadCache();
	const data = cache.packages.get(name);

	if (data && isCacheValid(data.timestamp)) {
		return data.size;
	}

	return undefined;
}

/**
 * Set package size in cache
 */
export async function setCachedPackageSize(name: string, size: number): Promise<void> {
	const cache = await loadCache();
	const existing = cache.packages.get(name);

	if (existing) {
		existing.size = size;
		existing.timestamp = Date.now();
	} else {
		cache.packages.set(name, {
			name,
			size,
			timestamp: Date.now(),
		});
	}

	await saveCache();
}

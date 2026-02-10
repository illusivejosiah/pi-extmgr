/**
 * Constants for pi-extmgr
 */

export const DISABLED_SUFFIX = ".disabled";
export const PAGE_SIZE = 20;
export const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Timeout values for various operations (in milliseconds)
 */
export const TIMEOUTS = {
	npmSearch: 20000,
	npmView: 10000,
	packageInstall: 180000,
	packageUpdate: 120000,
	packageRemove: 60000,
	listPackages: 10000,
	fetchPackageInfo: 30000,
	extractPackage: 30000,
	weeklyDownloads: 5000,
} as const;

export type TimeoutKey = keyof typeof TIMEOUTS;

/**
 * Cache limits (in milliseconds or count)
 */
export const CACHE_LIMITS = {
	packageInfoMaxSize: 100,
	metadataTTL: 24 * 60 * 60 * 1000, // 24 hours
	searchTTL: 15 * 60 * 1000, // 15 minutes
	packageInfoTTL: 6 * 60 * 60 * 1000, // 6 hours
} as const;

export type CacheLimitKey = keyof typeof CACHE_LIMITS;

/**
 * UI Constants
 */
export const UI = {
	maxListHeight: 16,
	searchThreshold: 8, // Enable search when items exceed this
	confirmTimeout: 30000,
	longConfirmTimeout: 60000,
} as const;

export type UIKey = keyof typeof UI;

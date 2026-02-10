/**
 * Auto-update settings storage
 * Persists to disk so config survives across pi sessions.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AutoUpdateConfig {
	intervalMs: number;
	lastCheck?: number;
	nextCheck?: number;
	enabled: boolean;
	displayText: string; // Human-readable description
	updatesAvailable?: string[];
}

const DEFAULT_CONFIG: AutoUpdateConfig = {
	intervalMs: 0,
	enabled: false,
	displayText: "off",
};

const SETTINGS_KEY = "extmgr-auto-update";
const SETTINGS_DIR = process.env.PI_EXTMGR_CACHE_DIR
	? process.env.PI_EXTMGR_CACHE_DIR
	: join(homedir(), ".pi", "agent", ".extmgr-cache");
const SETTINGS_FILE = join(SETTINGS_DIR, "auto-update.json");

function getSessionConfig(ctx: ExtensionCommandContext | ExtensionContext): AutoUpdateConfig | undefined {
	const entries =
		typeof ctx.sessionManager.getBranch === "function"
			? ctx.sessionManager.getBranch()
			: ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === SETTINGS_KEY && entry.data) {
			return { ...DEFAULT_CONFIG, ...(entry.data as AutoUpdateConfig) };
		}
	}

	return undefined;
}

/**
 * Checks if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensures the settings directory exists
 */
async function ensureSettingsDir(): Promise<void> {
	try {
		await mkdir(SETTINGS_DIR, { recursive: true });
	} catch (error) {
		console.warn("[extmgr] Failed to create settings directory:", error);
	}
}

/**
 * Reads config from disk asynchronously
 */
async function readConfigFromDisk(): Promise<AutoUpdateConfig | undefined> {
	try {
		if (!(await fileExists(SETTINGS_FILE))) {
			return undefined;
		}
		const raw = await readFile(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<AutoUpdateConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch (error) {
		console.warn("[extmgr] Failed to read settings:", error);
		return undefined;
	}
}

/**
 * Writes config to disk asynchronously
 */
async function writeConfigToDisk(config: AutoUpdateConfig): Promise<void> {
	try {
		await ensureSettingsDir();
		await writeFile(SETTINGS_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch (error) {
		console.warn("[extmgr] Failed to write settings:", error);
	}
}

/**
 * Hydrate session state from persisted disk settings.
 * This ensures sync reads can still work after startup/session switch.
 */
export async function hydrateAutoUpdateConfig(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext
): Promise<AutoUpdateConfig> {
	const fromSession = getSessionConfig(ctx);
	if (fromSession) return fromSession;

	const fromDisk = await readConfigFromDisk();
	const config = fromDisk ?? { ...DEFAULT_CONFIG };

	pi.appendEntry(SETTINGS_KEY, config);
	return config;
}

/**
 * Get auto-update config.
 * Priority:
 *  1) latest value in current session branch entries
 *  2) persisted value on disk
 *  3) defaults
 */
export async function getAutoUpdateConfigAsync(
	ctx: ExtensionCommandContext | ExtensionContext
): Promise<AutoUpdateConfig> {
	const fromSession = getSessionConfig(ctx);
	if (fromSession) return fromSession;

	const persisted = await readConfigFromDisk();
	if (persisted) return persisted;

	return { ...DEFAULT_CONFIG };
}

/**
 * Synchronous version for contexts where async is not practical.
 * Falls back to defaults if disk read would be required.
 */
export function getAutoUpdateConfig(
	ctx: ExtensionCommandContext | ExtensionContext
): AutoUpdateConfig {
	return getSessionConfig(ctx) ?? { ...DEFAULT_CONFIG };
}

/**
 * Save auto-update config to session + disk.
 */
export function saveAutoUpdateConfig(pi: ExtensionAPI, config: Partial<AutoUpdateConfig>): void {
	const fullConfig: AutoUpdateConfig = {
		...DEFAULT_CONFIG,
		...config,
	};

	pi.appendEntry(SETTINGS_KEY, fullConfig);

	// Write to disk asynchronously (fire and forget)
	writeConfigToDisk(fullConfig).catch((err) => {
		console.warn("[extmgr] Failed to save settings:", err);
	});
}

/**
 * Parse duration string to milliseconds
 * Supports: 1h, 2h, 1d, 7d, 1m, 3m, etc.
 * Also supports: never, off, disable, daily, weekly
 */
export function parseDuration(input: string): { ms: number; display: string } | undefined {
	const normalized = input.toLowerCase().trim();

	// Special cases for disabling
	if (normalized === "never" || normalized === "off" || normalized === "disable") {
		return { ms: 0, display: "off" };
	}

	// Named schedules
	if (normalized === "daily" || normalized === "day" || normalized === "1d") {
		return { ms: 24 * 60 * 60 * 1000, display: "daily" };
	}
	if (normalized === "weekly" || normalized === "week" || normalized === "1w") {
		return { ms: 7 * 24 * 60 * 60 * 1000, display: "weekly" };
	}

	// Parse duration patterns: 1h, 2h, 3d, 7d, 1m, etc.
	const durationMatch = normalized.match(
		/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|m|mo|mos|month|months)$/
	);
	if (durationMatch) {
		const value = parseInt(durationMatch[1]!, 10);
		const unit = durationMatch[2]![0]; // First character of unit

		let ms: number;
		let display: string;

		switch (unit) {
			case "h":
				ms = value * 60 * 60 * 1000;
				display = value === 1 ? "1 hour" : `${value} hours`;
				break;
			case "d":
				ms = value * 24 * 60 * 60 * 1000;
				display = value === 1 ? "1 day" : `${value} days`;
				break;
			case "w":
				ms = value * 7 * 24 * 60 * 60 * 1000;
				display = value === 1 ? "1 week" : `${value} weeks`;
				break;
			case "m":
				// Approximate months as 30 days
				ms = value * 30 * 24 * 60 * 60 * 1000;
				display = value === 1 ? "1 month" : `${value} months`;
				break;
			default:
				return undefined;
		}

		return { ms, display };
	}

	return undefined;
}

/**
 * Get interval in milliseconds
 */
export function getScheduleInterval(config: AutoUpdateConfig): number | undefined {
	if (!config.enabled || config.intervalMs === 0) {
		return undefined;
	}
	return config.intervalMs;
}

/**
 * Calculate next check time
 */
export function calculateNextCheck(intervalMs: number): number {
	return Date.now() + intervalMs;
}

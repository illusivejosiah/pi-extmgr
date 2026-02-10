/**
 * Unified extension manager UI
 * Displays local extensions and installed packages in one view
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme, DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	SettingsList,
	Text,
	Spacer,
	type SettingItem,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import type { UnifiedItem, State, UnifiedAction, InstalledPackage } from "../types/index.js";
import {
	discoverExtensions,
	removeLocalExtension,
	setExtensionState,
} from "../extensions/discovery.js";
import { getInstalledPackages } from "../packages/discovery.js";
import {
	showPackageActions,
	updatePackage,
	removePackage,
	updatePackages,
} from "../packages/management.js";
import { showRemote } from "./remote.js";
import { showHelp } from "./help.js";
import { formatEntry as formatExtEntry, dynamicTruncate, formatBytes } from "../utils/format.js";
import {
	getStatusIcon,
	getPackageIcon,
	getScopeIcon,
	getChangeMarker,
	formatSize,
} from "./theme.js";
import { logExtensionToggle } from "../utils/history.js";
import { getKnownUpdates, promptAutoUpdateWizard } from "../utils/auto-update.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { parseChoiceByLabel } from "../utils/command.js";
import { UI } from "../constants.js";

// Type guard for SettingsList with selectedIndex
interface SelectableList {
	selectedIndex?: number;
	handleInput?(data: string): void;
}

/**
 * Safely gets the selected index from a SettingsList component
 * Returns undefined if the component doesn't have the expected interface
 */
function getSelectedIndex(settingsList: unknown): number | undefined {
	if (settingsList && typeof settingsList === "object") {
		const selectable = settingsList as SelectableList;
		if (typeof selectable.selectedIndex === "number") {
			return selectable.selectedIndex;
		}
	}
	return undefined;
}

export async function showInteractive(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI
): Promise<void> {
	// Main loop - keeps showing the menu until user explicitly exits
	while (true) {
		const shouldExit = await showInteractiveOnce(ctx, pi);
		if (shouldExit) break;
	}
}

async function showInteractiveOnce(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI
): Promise<boolean> {
	// Load both local extensions and installed packages in parallel for performance
	const [localEntries, installedPackages] = await Promise.all([
		discoverExtensions(ctx.cwd),
		getInstalledPackages(ctx, pi),
	]);

	// Build unified items list
	const knownUpdates = getKnownUpdates(ctx);
	const items = buildUnifiedItems(localEntries, installedPackages, knownUpdates);

	// If nothing found, show quick actions
	if (items.length === 0) {
		const choice = await ctx.ui.select("No extensions or packages found", [
			"Browse community packages",
			"Cancel",
		]);

		if (choice === "Browse community packages") {
			await showRemote("", ctx, pi);
			return false;
		}
		return true;
	}

	// Staged changes tracking for local extensions
	const staged = new Map<string, State>();
	const byId = new Map(items.map((item) => [item.id, item]));

	const result = await ctx.ui.custom<UnifiedAction>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const hasLocals = items.some((i) => i.type === "local");
		const hasPackages = items.some((i) => i.type === "package");

		// Header
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Extensions Manager")), 2, 0));
		container.addChild(
			new Text(
				theme.fg(
					"muted",
					`${items.length} item${items.length === 1 ? "" : "s"} • Space/Enter toggle locals • Enter/A actions • u update pkg • x remove selected`
				),
				2,
				0
			)
		);
		container.addChild(
			new Text(
				theme.fg("dim", "Quick: i Install | f Search | U Update all | t Auto-update | p Palette"),
				2,
				0
			)
		);
		container.addChild(new Spacer(1));

		// Build settings items
		const settingsItems = buildSettingsItems(items, staged, theme);

		const settingsList = new SettingsList(
			settingsItems,
			Math.min(items.length + 2, UI.maxListHeight),
			getSettingsListTheme(),
			(id: string, newValue: string) => {
				const item = byId.get(id);
				if (!item || item.type !== "local") return;

				const state = newValue as State;
				staged.set(id, state);

				const settingsItem = settingsItems.find((x) => x.id === id);
				if (settingsItem) {
					const changed = state !== item.originalState;
					settingsItem.label = formatUnifiedItemLabel(item, state, theme, changed);
				}
				tui.requestRender();
			},
			() => done({ type: "cancel" }),
			{ enableSearch: items.length > UI.searchThreshold }
		);

		container.addChild(settingsList);
		container.addChild(new Spacer(1));

		// Footer with keyboard shortcuts
		const footerParts = buildFooter(hasLocals, hasPackages, staged, byId);
		container.addChild(new Text(theme.fg("dim", footerParts.join(" | ")), 2, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const selIdx = getSelectedIndex(settingsList) ?? 0;
				const selectedId = settingsItems[selIdx]?.id ?? settingsItems[0]?.id;
				const selectedItem = selectedId ? byId.get(selectedId) : undefined;

				if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
					done({ type: "apply" });
					return;
				}

				// Enter on a package opens its action menu (fewer clicks)
				if ((data === "\r" || data === "\n") && selectedId && selectedItem?.type === "package") {
					done({ type: "action", itemId: selectedId, action: "menu" });
					return;
				}

				if (data === "a" || data === "A") {
					if (selectedId) {
						done({ type: "action", itemId: selectedId, action: "menu" });
					}
					return;
				}

				// Quick actions (global)
				if (data === "i") {
					done({ type: "quick", action: "install" });
					return;
				}
				if (data === "f") {
					done({ type: "quick", action: "search" });
					return;
				}
				if (data === "U") {
					done({ type: "quick", action: "update-all" });
					return;
				}
				if (data === "t" || data === "T") {
					done({ type: "quick", action: "auto-update" });
					return;
				}

				// Fast actions on selected row
				if (selectedId && selectedItem?.type === "package") {
					if (data === "u") {
						done({ type: "action", itemId: selectedId, action: "update" });
						return;
					}
					if (data === "x" || data === "X") {
						done({ type: "action", itemId: selectedId, action: "remove" });
						return;
					}
					if (data === "v" || data === "V") {
						done({ type: "action", itemId: selectedId, action: "details" });
						return;
					}
				}

				if (selectedId && selectedItem?.type === "local") {
					if (data === "x" || data === "X") {
						done({ type: "action", itemId: selectedId, action: "remove" });
						return;
					}
				}

				if (data === "r" || data === "R") {
					done({ type: "remote" });
					return;
				}
				if (data === "?" || data === "h" || data === "H") {
					done({ type: "help" });
					return;
				}
				if (data === "m" || data === "M" || data === "p" || data === "P") {
					done({ type: "menu" });
					return;
				}
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});

	return await handleUnifiedAction(result, items, staged, byId, ctx, pi);
}

function buildUnifiedItems(
	localEntries: Awaited<ReturnType<typeof discoverExtensions>>,
	installedPackages: InstalledPackage[],
	knownUpdates: Set<string>
): UnifiedItem[] {
	const items: UnifiedItem[] = [];
	const localPaths = new Set<string>();

	// Add local extensions
	for (const entry of localEntries) {
		localPaths.add(entry.activePath?.toLowerCase() ?? "");
		items.push({
			type: "local",
			id: entry.id,
			displayName: entry.displayName,
			summary: entry.summary,
			scope: entry.scope,
			state: entry.state,
			activePath: entry.activePath,
			disabledPath: entry.disabledPath,
			originalState: entry.state,
		});
	}

	// Add installed packages (filter out duplicates that exist as local extensions)
	for (const pkg of installedPackages) {
		const pkgPath = pkg.source.toLowerCase();
		if (localPaths.has(pkgPath)) continue;

		items.push({
			type: "package",
			id: `pkg:${pkg.source}`,
			displayName: pkg.name,
			summary: pkg.description || `${pkg.source} (${pkg.scope})`,
			scope: pkg.scope,
			source: pkg.source,
			version: pkg.version,
			description: pkg.description,
			size: pkg.size,
			updateAvailable: knownUpdates.has(pkg.name),
		});
	}

	// Sort: locals first, then packages, both alphabetically
	items.sort((a, b) => {
		if (a.type !== b.type) return a.type === "local" ? -1 : 1;
		return a.displayName.localeCompare(b.displayName);
	});

	return items;
}

function buildSettingsItems(
	items: UnifiedItem[],
	staged: Map<string, State>,
	theme: Theme
): SettingItem[] {
	return items.map((item) => {
		if (item.type === "local") {
			const currentState = staged.get(item.id) ?? item.state!;
			const changed = staged.has(item.id) && staged.get(item.id) !== item.originalState;
			return {
				id: item.id,
				label: formatUnifiedItemLabel(item, currentState, theme, changed),
				currentValue: currentState,
				values: ["enabled", "disabled"],
			};
		} else {
			return {
				id: item.id,
				label: formatUnifiedItemLabel(item, "enabled", theme, false),
				currentValue: "enabled",
				values: ["enabled"],
			};
		}
	});
}

function buildFooter(
	hasLocals: boolean,
	hasPackages: boolean,
	staged: Map<string, State>,
	byId: Map<string, UnifiedItem>
): string[] {
	const hasChanges = getPendingLocalChangeCount(staged, byId) > 0;

	const footerParts: string[] = [];
	footerParts.push("↑↓ Navigate");
	if (hasLocals) footerParts.push("Space/Enter Toggle");
	if (hasLocals) footerParts.push(hasChanges ? "S Save*" : "S Save");
	if (hasPackages) footerParts.push("Enter/A Actions");
	if (hasPackages) footerParts.push("u Update");
	if (hasPackages || hasLocals) footerParts.push("X Remove");
	footerParts.push("i Install");
	footerParts.push("f Search");
	footerParts.push("U Update all");
	footerParts.push("t Auto-update");
	footerParts.push("P Palette");
	footerParts.push("R Browse");
	footerParts.push("? Help");
	footerParts.push("Esc Cancel");

	return footerParts;
}

function formatUnifiedItemLabel(
	item: UnifiedItem,
	state: State,
	theme: Theme,
	changed = false
): string {
	if (item.type === "local") {
		const statusIcon = getStatusIcon(theme, state === "enabled" ? "enabled" : "disabled");
		const scopeIcon = getScopeIcon(theme, item.scope);
		const changeMarker = getChangeMarker(theme, changed);
		const name = theme.bold(item.displayName);
		const summary = theme.fg("dim", item.summary);
		return `${statusIcon} [${scopeIcon}] ${name} - ${summary}${changeMarker}`;
	} else {
		const pkgIcon = getPackageIcon(theme, item.source?.startsWith("npm:") ? "npm" : "git");
		const scopeIcon = getScopeIcon(theme, item.scope as "global" | "project");
		const name = theme.bold(item.displayName);
		const version = item.version ? theme.fg("dim", `@${item.version}`) : "";
		const updateBadge = item.updateAvailable ? ` ${theme.fg("warning", "[update]")}` : "";

		// Build info parts
		const infoParts: string[] = [];

		// Show description if available
		// Reserved space: icon (2) + scope (3) + name (~25) + version (~10) + separator (3) = ~43 chars
		if (item.description) {
			infoParts.push(dynamicTruncate(item.description, 43));
		} else if (item.source?.startsWith("npm:")) {
			infoParts.push("npm");
		} else if (item.source?.startsWith("git:")) {
			infoParts.push("git");
		} else {
			infoParts.push("local");
		}

		// Show size if available
		if (item.size !== undefined) {
			infoParts.push(formatSize(theme, item.size));
		}

		const summary = theme.fg("dim", infoParts.join(" • "));
		return `${pkgIcon} [${scopeIcon}] ${name}${version}${updateBadge} - ${summary}`;
	}
}

function getPendingLocalChangeCount(
	staged: Map<string, State>,
	byId: Map<string, UnifiedItem>
): number {
	let count = 0;
	for (const [id, state] of staged.entries()) {
		const item = byId.get(id);
		if (item?.type === "local" && item.originalState !== state) {
			count += 1;
		}
	}
	return count;
}

function getLocalItemsForApply(items: UnifiedItem[]): UnifiedItem[] {
	return items.filter(
		(
			i
		): i is UnifiedItem & {
			type: "local";
			activePath: string;
			disabledPath: string;
			originalState: State;
		} => i.type === "local" && !!i.activePath
	);
}

async function applyLocalChangesFromManager(
	items: UnifiedItem[],
	staged: Map<string, State>,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	options?: { promptReload?: boolean }
): Promise<{ changed: number; reloaded: boolean }> {
	const localItems = getLocalItemsForApply(items);
	const apply = await applyStagedChanges(localItems, staged, pi);

	if (apply.errors.length > 0) {
		ctx.ui.notify(
			`Applied ${apply.changed} change(s), ${apply.errors.length} failed.\n${apply.errors.join("\n")}`,
			"warning"
		);
	} else if (apply.changed === 0) {
		ctx.ui.notify("No changes to apply.", "info");
	} else {
		ctx.ui.notify(`Applied ${apply.changed} extension change(s).`, "info");
	}

	if (apply.changed > 0) {
		const shouldPromptReload = options?.promptReload ?? true;

		if (shouldPromptReload) {
			const shouldReload = await ctx.ui.confirm(
				"Reload Required",
				"Extensions changed. Reload pi now?"
			);

			if (shouldReload) {
				await (ctx as ExtensionCommandContext & { reload: () => Promise<void> }).reload();
				return { changed: apply.changed, reloaded: true };
			}
		} else {
			ctx.ui.notify(
				"Changes saved. Reload pi later to fully apply extension state updates.",
				"info"
			);
		}
	}

	return { changed: apply.changed, reloaded: false };
}

async function resolvePendingChangesBeforeLeave(
	items: UnifiedItem[],
	staged: Map<string, State>,
	byId: Map<string, UnifiedItem>,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	destinationLabel: string
): Promise<"continue" | "stay" | "exit"> {
	const pendingCount = getPendingLocalChangeCount(staged, byId);
	if (pendingCount === 0) return "continue";

	const choice = await ctx.ui.select(`Unsaved changes (${pendingCount})`, [
		`Save and continue to ${destinationLabel}`,
		"Discard changes",
		"Stay in manager",
	]);

	if (!choice || choice === "Stay in manager") {
		return "stay";
	}

	if (choice === "Discard changes") {
		return "continue";
	}

	const result = await applyLocalChangesFromManager(items, staged, ctx, pi, {
		promptReload: false,
	});
	return result.reloaded ? "exit" : "continue";
}

const PALETTE_OPTIONS = {
	install: "📥 Install package",
	search: "🔎 Search packages",
	browse: "🌐 Browse community packages",
	updateAll: "⬆️ Update all packages",
	autoUpdate: "🔁 Auto-update settings",
	help: "❓ Help",
	back: "Back",
} as const;

type PaletteAction = keyof typeof PALETTE_OPTIONS;

type QuickDestination = "install" | "search" | "browse" | "update-all" | "auto-update" | "help";

const QUICK_DESTINATION_LABELS: Record<QuickDestination, string> = {
	install: "Install",
	search: "Search",
	browse: "Remote",
	"update-all": "Update",
	"auto-update": "Auto-update",
	help: "Help",
};

async function navigateWithPendingGuard(
	destination: QuickDestination,
	items: UnifiedItem[],
	staged: Map<string, State>,
	byId: Map<string, UnifiedItem>,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI
): Promise<"done" | "stay" | "exit"> {
	const pending = await resolvePendingChangesBeforeLeave(
		items,
		staged,
		byId,
		ctx,
		pi,
		QUICK_DESTINATION_LABELS[destination]
	);
	if (pending === "stay") return "stay";
	if (pending === "exit") return "exit";

	switch (destination) {
		case "install":
			await showRemote("install", ctx, pi);
			return "done";
		case "search":
			await showRemote("search", ctx, pi);
			return "done";
		case "browse":
			await showRemote("", ctx, pi);
			return "done";
		case "update-all":
			await updatePackages(ctx, pi);
			return "done";
		case "auto-update":
			await promptAutoUpdateWizard(pi, ctx, (packages) => {
				ctx.ui.notify(
					`Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
					"info"
				);
			});
			void updateExtmgrStatus(ctx, pi);
			return "done";
		case "help":
			showHelp(ctx);
			return "done";
	}
}

async function handleUnifiedAction(
	result: UnifiedAction,
	items: UnifiedItem[],
	staged: Map<string, State>,
	byId: Map<string, UnifiedItem>,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI
): Promise<boolean> {
	if (result.type === "cancel") {
		const pendingCount = getPendingLocalChangeCount(staged, byId);
		if (pendingCount > 0) {
			const choice = await ctx.ui.select(`Unsaved changes (${pendingCount})`, [
				"Save and exit",
				"Exit without saving",
				"Stay in manager",
			]);

			if (!choice || choice === "Stay in manager") {
				return false;
			}

			if (choice === "Save and exit") {
				const apply = await applyLocalChangesFromManager(items, staged, ctx, pi);
				if (apply.reloaded) return true;
			}
		}

		return true;
	}

	if (result.type === "remote") {
		const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Remote");
		if (pending === "stay") return false;
		if (pending === "exit") return true;

		await showRemote("", ctx, pi);
		return false;
	}

	if (result.type === "help") {
		const pending = await resolvePendingChangesBeforeLeave(items, staged, byId, ctx, pi, "Help");
		if (pending === "stay") return false;
		if (pending === "exit") return true;

		showHelp(ctx);
		return false;
	}

	if (result.type === "menu") {
		const choice = parseChoiceByLabel(
			PALETTE_OPTIONS,
			await ctx.ui.select("Quick Actions", Object.values(PALETTE_OPTIONS))
		);

		const destinationByAction: Partial<Record<PaletteAction, QuickDestination>> = {
			install: "install",
			search: "search",
			browse: "browse",
			updateAll: "update-all",
			autoUpdate: "auto-update",
			help: "help",
		};

		const destination = choice ? destinationByAction[choice] : undefined;
		if (!destination) {
			return false;
		}

		const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
		return outcome === "exit";
	}

	if (result.type === "quick") {
		const quickDestinationMap: Record<(typeof result)["action"], QuickDestination> = {
			install: "install",
			search: "search",
			"update-all": "update-all",
			"auto-update": "auto-update",
		};

		const destination = quickDestinationMap[result.action];
		const outcome = await navigateWithPendingGuard(destination, items, staged, byId, ctx, pi);
		return outcome === "exit";
	}

	if (result.type === "action") {
		const item = byId.get(result.itemId);
		if (!item) return false;

		const pendingDestination = item.type === "local" ? "remove extension" : "package actions";
		const pending = await resolvePendingChangesBeforeLeave(
			items,
			staged,
			byId,
			ctx,
			pi,
			pendingDestination
		);
		if (pending === "stay") return false;
		if (pending === "exit") return true;

		if (item.type === "local") {
			if (result.action !== "remove") return false;

			const confirmed = await ctx.ui.confirm(
				"Delete Local Extension",
				`Delete ${item.displayName} from disk?\n\nThis cannot be undone.`
			);
			if (!confirmed) return false;

			const removal = await removeLocalExtension(
				{ activePath: item.activePath!, disabledPath: item.disabledPath! },
				ctx.cwd
			);
			if (!removal.ok) {
				ctx.ui.notify(`Failed to remove extension: ${removal.error}`, "error");
				return false;
			}

			ctx.ui.notify(
				`Removed ${item.displayName}${removal.removedDirectory ? " (directory)" : ""}.`,
				"info"
			);

			const shouldReload = await ctx.ui.confirm(
				"Reload Recommended",
				"Extension removed. Reload pi now?"
			);
			if (shouldReload) {
				await (ctx as ExtensionCommandContext & { reload: () => Promise<void> }).reload();
				return true;
			}

			return false;
		}

		const pkg: InstalledPackage = {
			source: item.source!,
			name: item.displayName,
			...(item.version ? { version: item.version } : {}),
			scope: item.scope as "global" | "project",
			...(item.description ? { description: item.description } : {}),
			...(item.size !== undefined ? { size: item.size } : {}),
		};

		switch (result.action) {
			case "update":
				await updatePackage(pkg.source, ctx, pi);
				return false;
			case "remove":
				await removePackage(pkg.source, ctx, pi);
				return false;
			case "details": {
				const sizeStr = pkg.size !== undefined ? `\nSize: ${formatBytes(pkg.size)}` : "";
				ctx.ui.notify(
					`Name: ${pkg.name}\nVersion: ${pkg.version || "unknown"}\nSource: ${pkg.source}\nScope: ${pkg.scope}${sizeStr}${pkg.description ? `\nDescription: ${pkg.description}` : ""}`,
					"info"
				);
				return false;
			}
			case "menu":
			default: {
				const exitManager = await showPackageActions(pkg, ctx, pi);
				return exitManager;
			}
		}
	}

	const apply = await applyLocalChangesFromManager(items, staged, ctx, pi);
	return apply.reloaded;
}

async function applyStagedChanges(
	items: UnifiedItem[],
	staged: Map<string, State>,
	pi: ExtensionAPI
) {
	let changed = 0;
	const errors: string[] = [];

	for (const item of items) {
		if (item.type !== "local" || !item.activePath || !item.disabledPath || !item.originalState)
			continue;

		const target = staged.get(item.id) ?? item.originalState;
		if (target === item.originalState) continue;

		const result = await setExtensionState(
			{ activePath: item.activePath, disabledPath: item.disabledPath },
			target
		);

		if (result.ok) {
			changed++;
			// Log the successful toggle
			logExtensionToggle(pi, item.id, item.originalState, target, true);
		} else {
			errors.push(`${item.id}: ${result.error}`);
			// Log the failed toggle
			logExtensionToggle(pi, item.id, item.originalState, target, false, result.error);
		}
	}

	return { changed, errors };
}

// Legacy redirect
export async function showInstalledPackagesLegacy(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI
): Promise<void> {
	ctx.ui.notify(
		"📦 Use /extensions for the unified view.\nInstalled packages are now shown alongside local extensions.",
		"info"
	);
	// Small delay then open the main manager
	await new Promise((r) => setTimeout(r, 1500));
	await showInteractive(ctx, pi);
}

// List-only view for non-interactive mode
export async function showListOnly(ctx: ExtensionCommandContext): Promise<void> {
	const entries = await discoverExtensions(ctx.cwd);
	if (entries.length === 0) {
		const msg = "No extensions found in ~/.pi/agent/extensions or .pi/extensions";
		if (ctx.hasUI) {
			ctx.ui.notify(msg, "info");
		} else {
			console.log(msg);
		}
		return;
	}

	const lines = entries.map(formatExtEntry);
	const output = lines.join("\n");

	if (ctx.hasUI) {
		ctx.ui.notify(output, "info");
	} else {
		console.log(output);
	}
}

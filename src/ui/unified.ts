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
import { discoverExtensions, setExtensionState } from "../extensions/discovery.js";
import { getInstalledPackages } from "../packages/discovery.js";
import { showPackageActions } from "../packages/management.js";
import { showRemote } from "./remote.js";
import { showHelp } from "./help.js";
import { discoverExtensions as discoverExt } from "../extensions/discovery.js";
import { formatEntry as formatExtEntry, dynamicTruncate } from "../utils/format.js";
import {
  getStatusIcon,
  getPackageIcon,
  getScopeIcon,
  getChangeMarker,
  formatSize,
} from "./theme.js";
import { logExtensionToggle } from "../utils/history.js";

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
  const items = buildUnifiedItems(localEntries, installedPackages);

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
          `${items.length} item${items.length === 1 ? "" : "s"} • Space/Enter to toggle local extensions, A for actions on packages`
        ),
        2,
        0
      )
    );
    container.addChild(new Spacer(1));

    // Build settings items
    const settingsItems = buildSettingsItems(items, staged, theme);

    const settingsList = new SettingsList(
      settingsItems,
      Math.min(items.length + 2, 16),
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
      { enableSearch: items.length > 8 }
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
        if (matchesKey(data, Key.ctrl("s")) || data === "s" || data === "S") {
          done({ type: "apply" });
          return;
        }
        if (data === "a" || data === "A") {
          // Get currently selected item and show actions
          const selIdx = (settingsList as unknown as { selectedIndex: number }).selectedIndex ?? 0;
          const selectedId = settingsItems[selIdx]?.id ?? settingsItems[0]?.id;
          if (selectedId) {
            done({ type: "action", itemId: selectedId });
          }
          return;
        }
        if (data === "r" || data === "R") {
          done({ type: "remote" });
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done({ type: "help" });
          return;
        }
        if (data === "m" || data === "M") {
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
  installedPackages: InstalledPackage[]
): UnifiedItem[] {
  const items: UnifiedItem[] = [];

  // Add local extensions
  for (const entry of localEntries) {
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
  const localPaths = new Set(
    localEntries.map((e: { activePath?: string }) => e.activePath?.toLowerCase())
  );
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
  const hasChanges = Array.from(staged.entries()).some(([id, state]) => {
    const item = byId.get(id);
    return item?.type === "local" && item.originalState !== state;
  });

  const footerParts: string[] = [];
  footerParts.push("↑↓ Navigate");
  if (hasLocals) footerParts.push("Space/Enter Toggle");
  if (hasLocals) footerParts.push(hasChanges ? "S Save*" : "S Save");
  if (hasPackages) footerParts.push("A Actions");
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
    return `${pkgIcon} [${scopeIcon}] ${name}${version} - ${summary}`;
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
  // Handle results
  if (result.type === "cancel") {
    if (staged.size > 0) {
      ctx.ui.notify("No changes applied.", "info");
    }
    return true;
  }

  if (result.type === "remote") {
    await showRemote("", ctx, pi);
    return false;
  }

  if (result.type === "help") {
    showHelp(ctx);
    return false;
  }

  if (result.type === "menu") {
    return false;
  }

  if (result.type === "action") {
    const item = byId.get(result.itemId);
    if (item?.type === "package") {
      const pkg: InstalledPackage = {
        source: item.source!,
        name: item.displayName,
        ...(item.version ? { version: item.version } : {}),
        scope: item.scope as "global" | "project",
      };
      const exitManager = await showPackageActions(pkg, ctx, pi);
      return exitManager;
    }
    return false;
  }

  // Apply changes for local extensions
  const localItems = items.filter(
    (
      i
    ): i is UnifiedItem & {
      type: "local";
      activePath: string;
      disabledPath: string;
      originalState: State;
    } => i.type === "local" && !!i.activePath
  );

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

  // Prompt for reload if changes were made
  if (apply.changed > 0) {
    const shouldReload = await ctx.ui.confirm(
      "Reload Required",
      "Extensions changed. Reload pi now?"
    );

    if (shouldReload) {
      ctx.ui.setEditorText("/reload");
      return true;
    }
  }

  return false;
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
  const entries = await discoverExt(ctx.cwd);
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

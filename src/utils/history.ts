/**
 * Extension change history tracking using pi.appendEntry()
 * This persists extension management actions to the session
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export type ChangeAction =
  | "extension_toggle"
  | "package_install"
  | "package_update"
  | "package_remove"
  | "cache_clear";

export interface ExtensionChangeEntry {
  action: ChangeAction;
  timestamp: number;
  // Extension toggle fields
  extensionId?: string | undefined;
  fromState?: "enabled" | "disabled" | undefined;
  toState?: "enabled" | "disabled" | undefined;
  // Package fields
  packageSource?: string | undefined;
  packageName?: string | undefined;
  version?: string | undefined;
  scope?: "global" | "project" | undefined;
  // Result
  success: boolean;
  error?: string | undefined;
}

/**
 * Log an extension change to the session
 */
export function logChange(pi: ExtensionAPI, change: Omit<ExtensionChangeEntry, "timestamp">): void {
  const entry: ExtensionChangeEntry = {
    ...change,
    timestamp: Date.now(),
  };

  pi.appendEntry("extmgr-change", entry);
}

/**
 * Log extension state toggle
 */
export function logExtensionToggle(
  pi: ExtensionAPI,
  extensionId: string,
  fromState: "enabled" | "disabled",
  toState: "enabled" | "disabled",
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "extension_toggle",
    extensionId,
    fromState,
    toState,
    success,
    error,
  });
}

/**
 * Log package installation
 */
export function logPackageInstall(
  pi: ExtensionAPI,
  source: string,
  name: string,
  version: string | undefined,
  scope: "global" | "project",
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_install",
    packageSource: source,
    packageName: name,
    version,
    scope,
    success,
    error,
  });
}

/**
 * Log package update
 */
export function logPackageUpdate(
  pi: ExtensionAPI,
  source: string,
  name: string,
  _fromVersion: string | undefined,
  toVersion: string | undefined,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_update",
    packageSource: source,
    packageName: name,
    version: toVersion,
    scope: source.includes("node_modules") ? "global" : "project",
    success,
    error,
  });
}

/**
 * Log package removal
 */
export function logPackageRemove(
  pi: ExtensionAPI,
  source: string,
  name: string,
  success: boolean,
  error?: string
): void {
  logChange(pi, {
    action: "package_remove",
    packageSource: source,
    packageName: name,
    success,
    error,
  });
}

/**
 * Get recent changes from session entries
 */
export function getRecentChanges(ctx: ExtensionCommandContext, limit = 10): ExtensionChangeEntry[] {
  const entries = ctx.sessionManager.getEntries();
  const changes: ExtensionChangeEntry[] = [];

  for (let i = entries.length - 1; i >= 0 && changes.length < limit; i--) {
    const entry = entries[i];
    if (entry && entry.type === "custom" && entry.customType === "extmgr-change" && entry.data) {
      changes.unshift(entry.data as ExtensionChangeEntry);
    }
  }

  return changes;
}

/**
 * Format a change entry for display
 */
export function formatChangeEntry(entry: ExtensionChangeEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const icon = entry.success ? "✓" : "✗";

  switch (entry.action) {
    case "extension_toggle":
      return `[${time}] ${icon} ${entry.extensionId}: ${entry.fromState} → ${entry.toState}`;

    case "package_install":
      return `[${time}] ${icon} Installed ${entry.packageName}${entry.version ? `@${entry.version}` : ""}`;

    case "package_update":
      return `[${time}] ${icon} Updated ${entry.packageName}${entry.version ? ` → @${entry.version}` : ""}`;

    case "package_remove":
      return `[${time}] ${icon} Removed ${entry.packageName}`;

    case "cache_clear":
      return `[${time}] ${icon} Cache cleared`;

    default:
      return `[${time}] ${icon} Unknown action`;
  }
}

/**
 * Get summary stats of changes
 */
export function getChangeStats(ctx: ExtensionCommandContext): {
  total: number;
  successful: number;
  failed: number;
  byAction: Record<ChangeAction, number>;
} {
  const entries = ctx.sessionManager.getEntries();
  const stats = {
    total: 0,
    successful: 0,
    failed: 0,
    byAction: {
      extension_toggle: 0,
      package_install: 0,
      package_update: 0,
      package_remove: 0,
      cache_clear: 0,
    },
  };

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "extmgr-change" && entry.data) {
      const change = entry.data as ExtensionChangeEntry;
      stats.total++;
      if (change.success) {
        stats.successful++;
      } else {
        stats.failed++;
      }
      stats.byAction[change.action]++;
    }
  }

  return stats;
}

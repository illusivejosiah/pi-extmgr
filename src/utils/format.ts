/**
 * Formatting utilities
 */
import type { ExtensionEntry, InstalledPackage } from "../types/index.js";

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Get the terminal width, with a minimum fallback
 */
export function getTerminalWidth(minWidth = 80): number {
  return Math.max(minWidth, process.stdout.columns || minWidth);
}

/**
 * Calculate available space for description based on fixed-width elements
 */
export function getDescriptionWidth(
  totalWidth: number,
  reservedSpace: number,
  minDescWidth = 20
): number {
  return Math.max(minDescWidth, totalWidth - reservedSpace);
}

/**
 * Dynamic truncate that adapts to available terminal width
 * @param text - Text to truncate
 * @param reservedSpace - Space taken by fixed elements (icons, name, version, etc.)
 * @param minWidth - Minimum terminal width to consider
 */
export function dynamicTruncate(text: string, reservedSpace: number, minWidth = 80): string {
  const termWidth = getTerminalWidth(minWidth);
  const maxDescWidth = getDescriptionWidth(termWidth, reservedSpace);
  return truncate(text, maxDescWidth);
}

export function formatEntry(entry: ExtensionEntry): string {
  const state = entry.state === "enabled" ? "on " : "off";
  const scope = entry.scope === "global" ? "G" : "P";
  return `[${state}] [${scope}] ${entry.displayName} - ${entry.summary}`;
}

export function formatInstalledPackageLabel(pkg: InstalledPackage, index?: number): string {
  const base = `${pkg.name}${pkg.version ? ` @${pkg.version}` : ""} (${pkg.scope})`;
  return index !== undefined ? `[${index + 1}] ${base}` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function isPackageSource(str: string): boolean {
  return (
    str.startsWith("npm:") ||
    str.startsWith("git:") ||
    str.startsWith("http") ||
    str.startsWith("/") ||
    str.startsWith("./") ||
    str.startsWith("../")
  );
}

export function normalizePackageSource(source: string): string {
  if (
    source.startsWith("npm:") ||
    source.startsWith("git:") ||
    source.startsWith("http") ||
    source.startsWith("/") ||
    source.startsWith(".")
  ) {
    return source;
  }
  return `npm:${source}`;
}

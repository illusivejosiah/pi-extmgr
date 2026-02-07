/**
 * Formatting utilities
 */
import type { ExtensionEntry, InstalledPackage } from "../types/index.js";

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
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

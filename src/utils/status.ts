/**
 * Status bar helpers for extmgr
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getInstalledPackages } from "../packages/discovery.js";
import { getAutoUpdateStatus } from "./auto-update.js";
import { getAutoUpdateConfig } from "./settings.js";

export async function updateExtmgrStatus(
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) return;

  try {
    const packages = await getInstalledPackages(ctx, pi);
    const statusParts: string[] = [];

    if (packages.length > 0) {
      statusParts.push(`${packages.length} pkg${packages.length === 1 ? "" : "s"}`);
    }

    const autoUpdateStatus = getAutoUpdateStatus(ctx);
    if (autoUpdateStatus) {
      statusParts.push(autoUpdateStatus);
    }

    const knownUpdates = getAutoUpdateConfig(ctx).updatesAvailable ?? [];
    if (knownUpdates.length > 0) {
      statusParts.push(`${knownUpdates.length} update${knownUpdates.length === 1 ? "" : "s"}`);
    }

    if (statusParts.length > 0) {
      ctx.ui.setStatus("extmgr", ctx.ui.theme.fg("dim", statusParts.join(" • ")));
    } else {
      ctx.ui.setStatus("extmgr", undefined);
    }
  } catch {
    // Best-effort status updates only
  }
}

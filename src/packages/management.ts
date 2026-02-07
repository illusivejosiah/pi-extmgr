/**
 * Package management (update, remove)
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { InstalledPackage } from "../types/index.js";
import { getInstalledPackages, clearSearchCache } from "./discovery.js";
import { formatInstalledPackageLabel } from "../utils/format.js";

export async function updatePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify(`Updating ${source}...`, "info");
  } else {
    console.log(`Updating ${source}...`);
  }

  const res = await pi.exec("pi", ["update", source], { timeout: 120000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.includes("pinned")) {
    const msg = `${source} is already up to date (or pinned).`;
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  } else {
    if (ctx.hasUI) {
      ctx.ui.notify(`Updated ${source}`, "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Package updated. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log(`Updated ${source}`);
      console.log("Run /reload to apply changes.");
    }
  }
}

export async function updatePackages(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify("Updating all packages...", "info");
  } else {
    console.log("Updating all packages...");
  }

  const res = await pi.exec("pi", ["update"], { timeout: 300000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Update failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  const stdout = res.stdout || "";
  if (stdout.includes("already up to date") || stdout.trim() === "") {
    const msg = "All packages are already up to date.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
  } else {
    if (ctx.hasUI) {
      ctx.ui.notify("Packages updated", "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Packages updated. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log("Packages updated");
      console.log("Run /reload to apply changes.");
    }
  }
}

export async function removePackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  // Confirm removal (interactive only)
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Remove Package", `Remove ${source}?`, {
      timeout: 10000,
    });

    if (!confirmed) {
      ctx.ui.notify("Removal cancelled.", "info");
      return;
    }

    ctx.ui.notify(`Removing ${source}...`, "info");
  } else {
    console.log(`Removing ${source}...`);
  }

  const res = await pi.exec("pi", ["remove", source], { timeout: 60000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Remove failed: ${res.stderr || res.stdout || `exit ${res.code}`}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  clearSearchCache();

  if (ctx.hasUI) {
    ctx.ui.notify(`Removed ${source}`, "info");

    const shouldReload = await ctx.ui.confirm("Reload Required", "Package removed. Reload pi now?");

    if (shouldReload) {
      ctx.ui.setEditorText("/reload");
    }
  } else {
    console.log(`Removed ${source}`);
    console.log("Run /reload to apply changes.");
  }
}

export async function promptRemove(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    console.log("Interactive selection not available in non-interactive mode.");
    console.log("Usage: /extensions remove <npm:package|git:url|path>");
    return;
  }

  const packages = await getInstalledPackages(ctx, pi);
  if (packages.length === 0) {
    const msg = "No packages installed.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  const items = packages.map((p: InstalledPackage, index: number) =>
    formatInstalledPackageLabel(p, index)
  );

  const toRemove = await ctx.ui.select("Remove package", items);
  if (!toRemove) return;

  const indexMatch = toRemove.match(/^\[(\d+)\]\s+/);
  const selectedIndex = indexMatch ? Number(indexMatch[1]) - 1 : -1;
  const pkg = selectedIndex >= 0 ? packages[selectedIndex] : undefined;
  if (pkg) {
    await removePackage(pkg.source, ctx, pi);
  }
}

export async function showPackageActions(
  pkg: InstalledPackage,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  if (!ctx.hasUI) {
    console.log(`Package: ${pkg.name}`);
    console.log(`Version: ${pkg.version || "unknown"}`);
    console.log(`Source: ${pkg.source}`);
    console.log(`Scope: ${pkg.scope}`);
    return true;
  }

  const choice = await ctx.ui.select(pkg.name, [
    `Remove ${pkg.name}`,
    `Update ${pkg.name}`,
    "View details",
    "Back to manager",
  ]);

  if (!choice || choice.includes("Back")) {
    return false; // Stay in manager
  }

  if (choice.startsWith("Remove")) {
    await removePackage(pkg.source, ctx, pi);
  } else if (choice.startsWith("Update")) {
    await updatePackage(pkg.source, ctx, pi);
  } else if (choice.includes("details")) {
    ctx.ui.notify(
      `Name: ${pkg.name}\nVersion: ${pkg.version || "unknown"}\nSource: ${pkg.source}\nScope: ${pkg.scope}`,
      "info"
    );
    // Show actions again
    return showPackageActions(pkg, ctx, pi);
  }

  return false; // Stay in manager
}

// Legacy list view for non-interactive mode and backward compatibility
export async function showInstalledPackagesList(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const packages = await getInstalledPackages(ctx, pi);

  if (packages.length === 0) {
    const msg = "No packages installed.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  // Non-interactive mode: just list packages
  const lines = packages.map((p: InstalledPackage, index: number) =>
    formatInstalledPackageLabel(p, index)
  );

  if (ctx.hasUI) {
    ctx.ui.notify(lines.join("\n"), "info");
  } else {
    console.log(lines.join("\n"));
  }
}

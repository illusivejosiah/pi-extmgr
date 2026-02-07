/**
 * Extensions Manager - Enhanced UI/UX for managing Pi extensions and packages
 *
 * Entry point - exports the main extension function
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { isPackageSource } from "./utils/format.js";
import { showInteractive, showListOnly, showInstalledPackagesLegacy } from "./ui/unified.js";
import { showRemote } from "./ui/remote.js";
import { showHelp } from "./ui/help.js";
import { installPackage } from "./packages/install.js";
import { removePackage, promptRemove, showInstalledPackagesList } from "./packages/management.js";
import { getInstalledPackages } from "./packages/discovery.js";
import { getRecentChanges, formatChangeEntry, getChangeStats } from "./utils/history.js";
import { clearCache } from "./utils/cache.js";

export default function extensionsManager(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "Manage local extensions and browse/install community packages",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const commands = [
        { value: "list", description: "List local extensions" },
        { value: "local", description: "Open interactive manager (default)" },
        { value: "remote", description: "Browse community packages" },
        { value: "packages", description: "Browse community packages (alias)" },
        { value: "installed", description: "List installed packages" },
        { value: "search", description: "Search npm for packages" },
        { value: "install", description: "Install a package" },
        { value: "remove", description: "Remove an installed package" },
        { value: "uninstall", description: "Remove an installed package (alias)" },
        { value: "history", description: "View extension change history" },
        { value: "stats", description: "View extension manager statistics" },
        { value: "clear-cache", description: "Clear metadata cache" },
      ];

      const safePrefix = (prefix ?? "").toLowerCase();
      const filtered = commands.filter(
        (c) => c.value.startsWith(safePrefix) || c.description.toLowerCase().includes(safePrefix)
      );

      return filtered.length > 0
        ? filtered.map((c) => ({ value: c.value, label: `${c.value} - ${c.description}` }))
        : null;
    },
    handler: async (args, ctx) => {
      // Check if we have UI support
      if (!ctx.hasUI) {
        await handleNonInteractive(args, ctx, pi);
        return;
      }

      const input = args.trim();
      const [subcommand, ...rest] = input.split(/\s+/).filter(Boolean);
      const sub = (subcommand ?? "").toLowerCase();

      switch (sub) {
        case "":
        case "local":
          await showInteractive(ctx, pi);
          break;
        case "list":
          await showListOnly(ctx);
          break;
        case "remote":
        case "packages":
          await showRemote(rest.join(" "), ctx, pi);
          break;
        case "installed":
          await showInstalledPackagesLegacy(ctx, pi);
          break;
        case "search":
          await showRemote(`search ${rest.join(" ")}`, ctx, pi);
          break;
        case "install":
          if (rest.length > 0) {
            await installPackage(rest.join(" "), ctx, pi);
          } else {
            await showRemote("install", ctx, pi);
          }
          break;
        case "remove":
        case "uninstall":
          if (rest.length > 0) {
            await removePackage(rest.join(" "), ctx, pi);
          } else {
            await promptRemove(ctx, pi);
          }
          break;
        case "history":
          showHistory(ctx, pi);
          break;
        case "stats":
          await showStats(ctx, pi);
          break;
        case "clear-cache":
          await clearMetadataCache(ctx, pi);
          break;
        default:
          // If it looks like a package source, try to install it
          if (subcommand && isPackageSource(subcommand)) {
            await installPackage(input, ctx, pi);
          } else {
            ctx.ui.notify(
              `Unknown command: ${subcommand ?? "(empty)"}. Try: local, remote, installed, search, install, remove`,
              "warning"
            );
          }
      }
    },
  });

  // Status bar integration - show installed package count
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Defer status update to avoid interfering with extension loading lifecycle
    // This prevents race conditions during reload where commands might not appear
    setImmediate(() => {
      void (async () => {
        try {
          const packages = await getInstalledPackages(ctx, pi);
          if (packages.length > 0) {
            ctx.ui.setStatus(
              "extmgr",
              ctx.ui.theme.fg("dim", `${packages.length} pkg${packages.length === 1 ? "" : "s"}`)
            );
          }
        } catch {
          // Silently ignore status bar errors
        }
      })();
    });
  });
}

async function handleNonInteractive(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const input = args.trim();
  const [subcommand, ...rest] = input.split(/\s+/).filter(Boolean);
  const sub = (subcommand ?? "").toLowerCase();

  switch (sub) {
    case "list":
      await showListOnly(ctx);
      break;
    case "installed":
      await showInstalledPackagesList(ctx, pi);
      break;
    case "remote":
    case "packages":
      // Non-interactive: just show help
      console.log("Extensions Manager (non-interactive mode)");
      console.log("Remote package browsing requires interactive mode.");
      console.log("");
      console.log("Available commands:");
      console.log("  /extensions list      - List local extensions");
      console.log("  /extensions installed - List installed packages");
      console.log("  /extensions install <source> - Install a package");
      console.log("  /extensions remove <source>  - Remove a package");
      break;
    case "search":
      console.log("Search requires interactive mode.");
      break;
    case "install":
      if (rest.length > 0) {
        await installPackage(rest.join(" "), ctx, pi);
      } else {
        console.log("Usage: /extensions install <npm:package|git:url|path>");
      }
      break;
    case "remove":
    case "uninstall":
      if (rest.length > 0) {
        await removePackage(rest.join(" "), ctx, pi);
      } else {
        console.log("Usage: /extensions remove <npm:package|git:url|path>");
      }
      break;
    default:
      // If it looks like a package source, try to install it
      if (subcommand && isPackageSource(subcommand)) {
        await installPackage(input, ctx, pi);
      } else {
        console.log("Extensions Manager (non-interactive mode)");
        console.log("");
        console.log("Commands:");
        console.log("  /extensions list      - List local extensions");
        console.log("  /extensions installed - List installed packages");
        console.log("");
        console.log("For full functionality, run in interactive mode.");
      }
  }
}

export { showHelp };

function showHistory(ctx: ExtensionCommandContext, _pi: ExtensionAPI): void {
  const changes = getRecentChanges(ctx, 20);

  if (changes.length === 0) {
    const msg = "No extension changes recorded in this session.";
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  const lines = changes.map(formatChangeEntry);
  const output = ["Extension Change History (recent 20):", "", ...lines].join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}

async function showStats(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const stats = getChangeStats(ctx);
  const packages = await getInstalledPackages(ctx, pi);

  const lines = [
    "Extension Manager Statistics",
    "",
    `Installed packages: ${packages.length}`,
    `Session changes: ${stats.total}`,
    `  - Successful: ${stats.successful}`,
    `  - Failed: ${stats.failed}`,
    "",
    "Changes by type:",
    `  - Extension toggles: ${stats.byAction.extension_toggle}`,
    `  - Package installs: ${stats.byAction.package_install}`,
    `  - Package updates: ${stats.byAction.package_update}`,
    `  - Package removals: ${stats.byAction.package_remove}`,
  ];

  const output = lines.join("\n");

  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}

async function clearMetadataCache(ctx: ExtensionCommandContext, _pi: ExtensionAPI): Promise<void> {
  await clearCache();

  const msg = "Metadata cache cleared.";
  if (ctx.hasUI) {
    ctx.ui.notify(msg, "info");
  } else {
    console.log(msg);
  }
}

/**
 * Remote package browsing UI
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, Spacer, type SelectItem } from "@mariozechner/pi-tui";
import type { BrowseAction, MenuAction, NpmPackage } from "../types/index.js";
import { PAGE_SIZE } from "../constants.js";
import { truncate } from "../utils/format.js";
import {
  searchNpmPackages,
  getSearchCache,
  setSearchCache,
  isCacheValid,
} from "../packages/discovery.js";
import { installPackage, installPackageLocally } from "../packages/install.js";
import { showHelp } from "./help.js";

export async function showRemote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const sub = (subcommand ?? "").toLowerCase();
  const query = rest.join(" ").trim();

  switch (sub) {
    case "list":
    case "installed":
      // Legacy: redirect to unified view
      ctx.ui.notify("📦 Use /extensions for the unified view.", "info");
      return;
    case "install":
      if (query) {
        await installPackage(query, ctx, pi);
      } else {
        await promptInstall(ctx, pi);
      }
      return;
    case "search":
      await searchPackages(query, ctx, pi);
      return;
    case "browse":
    case "":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      return;
  }

  // Show remote menu
  await showRemoteMenu(ctx, pi);
}

async function showRemoteMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const result = await ctx.ui.custom<MenuAction>((tui, theme, _kb, done) => {
    const container = new Container();

    // Header
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Community Packages")), 2, 1));
    container.addChild(
      new Text(theme.fg("muted", "Use /extensions for unified view of installed items"), 2, 0)
    );
    container.addChild(new Spacer(1));

    const menuItems: SelectItem[] = [
      {
        value: "browse",
        label: "🔍 Browse pi packages",
        description: "Discover community packages",
      },
      { value: "search", label: "🔎 Search packages", description: "Search npm with custom query" },
      { value: "install", label: "📥 Install by source", description: "npm:, git:, or local path" },
    ];

    const selectList = new SelectList(menuItems, menuItems.length + 2, {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", theme.bold(t)),
      description: (t: string) => theme.fg("dim", t),
      scrollInfo: (t: string) => theme.fg("muted", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item: SelectItem) => done(item.value as MenuAction);
    selectList.onCancel = () => done("cancel");

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ Navigate • Enter Select • M Main Menu • ? Help • Esc Cancel"),
        2,
        0
      )
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (data === "m" || data === "M") {
          done("main");
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done("help");
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  switch (result) {
    case "browse":
      await browseRemotePackages(ctx, "keywords:pi-package", pi);
      break;
    case "search":
      await promptSearch(ctx, pi);
      break;
    case "install":
      await promptInstall(ctx, pi);
      break;
    case "main":
      return;
    case "help":
      showHelp(ctx);
      break;
    case "cancel":
      return;
  }
}

export async function browseRemotePackages(
  ctx: ExtensionCommandContext,
  query: string,
  pi: ExtensionAPI,
  offset = 0
): Promise<void> {
  // Check cache first
  let allPackages: NpmPackage[] = [];

  if (isCacheValid(query) && offset > 0) {
    const cache = getSearchCache();
    if (cache) allPackages = cache.results;
  } else {
    // Show searching notification
    ctx.ui.notify(`Searching npm for: ${truncate(query, 40)}...`, "info");

    // Perform search
    allPackages = await searchNpmPackages(query, ctx, pi);

    // Cache results for pagination
    setSearchCache({
      query,
      results: allPackages,
      timestamp: Date.now(),
    });
  }

  // Apply pagination from cached/filtered results
  const totalResults = allPackages.length;
  const packages = allPackages.slice(offset, offset + PAGE_SIZE);

  if (packages.length === 0) {
    const msg = offset > 0 ? "No more packages to show." : `No packages found for: ${query}`;
    ctx.ui.notify(msg, "info");

    if (offset > 0) {
      await browseRemotePackages(ctx, query, pi, 0);
    }
    return;
  }

  // Build selection items with descriptions
  const selectItems: SelectItem[] = packages.map((p) => ({
    value: p.name,
    label: themeLabel("accent", `${p.name}${p.version ? ` @${p.version}` : ""}`),
    description: truncate(p.description || "No description", 60),
  }));

  // Add navigation options
  const showLoadMore = totalResults >= PAGE_SIZE && packages.length === PAGE_SIZE;
  const showPrevious = offset > 0;

  if (showPrevious) {
    selectItems.push({
      value: "__prev",
      label: themeLabel("warning", "◀  Previous page"),
      description: "",
    });
  }
  if (showLoadMore) {
    selectItems.push({
      value: "__next",
      label: themeLabel("success", "▶  Next page"),
      description: `Showing ${offset + 1}-${offset + packages.length}`,
    });
  }
  selectItems.push({
    value: "__refresh",
    label: themeLabel("muted", "🔄 Refresh search"),
    description: "",
  });
  selectItems.push({
    value: "__menu",
    label: themeLabel("muted", "◀  Back to menu"),
    description: "",
  });

  const titleText =
    offset > 0
      ? `Search Results (${offset + 1}-${offset + packages.length})`
      : `Search: ${truncate(query, 40)}`;

  // Use custom SelectList for better visuals
  const result = await ctx.ui.custom<BrowseAction>((tui, theme, _kb, done) => {
    const container = new Container();

    // Header with border
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(titleText)), 2, 1));
    container.addChild(new Spacer(1));

    // SelectList with themed options
    const selectList = new SelectList(selectItems, Math.min(selectItems.length, 15), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", theme.bold(t)),
      description: (t: string) => theme.fg("dim", t),
      scrollInfo: (t: string) => theme.fg("muted", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });

    selectList.onSelect = (item: SelectItem) => {
      if (item.value === "__prev") {
        done({ type: "prev" });
      } else if (item.value === "__next") {
        done({ type: "next" });
      } else if (item.value === "__refresh") {
        done({ type: "refresh" });
      } else if (item.value === "__menu") {
        done({ type: "menu" });
      } else {
        done({ type: "package", name: item.value });
      }
    };

    selectList.onCancel = () => done({ type: "cancel" });

    container.addChild(selectList);
    container.addChild(new Spacer(1));

    // Help text
    container.addChild(
      new Text(theme.fg("dim", "↑↓ Navigate • Enter Select • M Main • ? Help • Esc Cancel"), 2, 0)
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (data === "m" || data === "M") {
          done({ type: "main" });
          return;
        }
        if (data === "?" || data === "h" || data === "H") {
          done({ type: "help" });
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  // Handle result
  switch (result.type) {
    case "cancel":
      return;
    case "prev":
      await browseRemotePackages(ctx, query, pi, Math.max(0, offset - PAGE_SIZE));
      return;
    case "next":
      await browseRemotePackages(ctx, query, pi, offset + PAGE_SIZE);
      return;
    case "refresh":
      setSearchCache(null);
      await browseRemotePackages(ctx, query, pi, 0);
      return;
    case "menu":
      await showRemoteMenu(ctx, pi);
      return;
    case "main":
      return;
    case "help":
      showHelp(ctx);
      return;
    case "package":
      await showPackageDetails(result.name, ctx, pi);
      return;
  }
}

async function showPackageDetails(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) {
    console.log(`Package: ${packageName}`);
    return;
  }

  const choice = await ctx.ui.select(packageName, [
    `Install via npm (managed)`,
    `Install locally (standalone)`,
    "View npm info",
    "Back to results",
  ]);

  if (!choice) return;

  if (choice.includes("via npm")) {
    await installPackage(`npm:${packageName}`, ctx, pi);
  } else if (choice.includes("locally")) {
    await installPackageLocally(packageName, ctx, pi);
  } else if (choice.includes("npm info")) {
    const infoRes = await pi.exec("npm", ["view", packageName, "--json"], {
      timeout: 10000,
      cwd: ctx.cwd,
    });
    if (infoRes.code === 0) {
      try {
        interface NpmViewInfo {
          description?: string;
          version?: string;
          author?: { name?: string } | string;
          homepage?: string;
        }
        const info = JSON.parse(infoRes.stdout) as NpmViewInfo;
        const description = info.description ?? "No description";
        const version = info.version ?? "unknown";
        const author =
          typeof info.author === "object" ? info.author?.name : (info.author ?? "unknown");
        const homepage = info.homepage ?? "";

        ctx.ui.notify(
          `${packageName}@${version}\n${description}\nAuthor: ${author}${homepage ? `\n${homepage}` : ""}`,
          "info"
        );
      } catch {
        ctx.ui.notify(`Package: ${packageName}\n${infoRes.stdout.slice(0, 500)}`, "info");
      }
    }
    await showPackageDetails(packageName, ctx, pi);
  } else if (choice.includes("Back")) {
    await browseRemotePackages(ctx, "keywords:pi-package", pi);
  }
}

async function promptSearch(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const query = await ctx.ui.input("Search packages", "keywords:pi-package");
  if (!query?.trim()) return;
  await searchPackages(query.trim(), ctx, pi);
}

async function searchPackages(
  query: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!query) {
    await promptSearch(ctx, pi);
    return;
  }
  await browseRemotePackages(ctx, query, pi);
}

async function promptInstall(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    console.log("Interactive input not available in non-interactive mode.");
    console.log("Usage: /extensions install <npm:package|git:url|path>");
    return;
  }
  const source = await ctx.ui.input("Install package", "npm:@scope/pkg or git:https://...");
  if (!source) return;
  await installPackage(source.trim(), ctx, pi);
}

function themeLabel(_color: string, text: string): string {
  return text;
}

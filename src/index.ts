/**
 * Extensions Manager - Enhanced UI/UX for managing Pi extensions and packages
 *
 * Entry point - exports the main extension function
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { isPackageSource } from "./utils/format.js";
import { showInteractive, showListOnly, showInstalledPackagesLegacy } from "./ui/unified.js";
import { showRemote } from "./ui/remote.js";
import { installPackage, type InstallScope } from "./packages/install.js";
import {
  removePackage,
  promptRemove,
  showInstalledPackagesList,
  updatePackage,
  updatePackages,
} from "./packages/management.js";
import {
  formatChangeEntry,
  logCacheClear,
  queryGlobalHistory,
  querySessionChanges,
  type ChangeAction,
  type HistoryFilters,
} from "./utils/history.js";
import { clearCache } from "./utils/cache.js";
import { notify } from "./utils/notify.js";
import { formatListOutput } from "./utils/ui-helpers.js";
import { parseDuration } from "./utils/settings.js";
import { tokenizeArgs } from "./utils/command.js";
import { updateExtmgrStatus } from "./utils/status.js";
import {
  startAutoUpdateTimer,
  stopAutoUpdateTimer,
  enableAutoUpdate,
  disableAutoUpdate,
  getAutoUpdateStatus,
  promptAutoUpdateWizard,
} from "./utils/auto-update.js";

type CommandId =
  | "local"
  | "list"
  | "remote"
  | "installed"
  | "search"
  | "install"
  | "remove"
  | "update"
  | "history"
  | "clear-cache"
  | "auto-update";

interface CommandDefinition {
  id: CommandId;
  description: string;
  aliases?: string[];
  runInteractive: (
    tokens: string[],
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
  ) => Promise<void> | void;
  runNonInteractive: (
    tokens: string[],
    ctx: ExtensionCommandContext,
    pi: ExtensionAPI
  ) => Promise<void> | void;
}

const INSTALL_USAGE = "Usage: /extensions install <source> [--project|--global]";
const REMOVE_USAGE = "Usage: /extensions remove <npm:package|git:url|path>";

function requireInteractiveCommand(ctx: ExtensionCommandContext, feature: string): void {
  notify(ctx, `${feature} requires interactive mode.`, "warning");
}

const COMMAND_DEFINITIONS: Record<CommandId, CommandDefinition> = {
  local: {
    id: "local",
    description: "Open interactive manager (default)",
    runInteractive: (_tokens, ctx, pi) => showInteractive(ctx, pi),
    runNonInteractive: (_tokens, ctx) => showListOnly(ctx),
  },
  list: {
    id: "list",
    description: "List local extensions",
    runInteractive: (_tokens, ctx) => showListOnly(ctx),
    runNonInteractive: (_tokens, ctx) => showListOnly(ctx),
  },
  remote: {
    id: "remote",
    description: "Browse community packages",
    aliases: ["packages"],
    runInteractive: (tokens, ctx, pi) => showRemote(tokens.join(" "), ctx, pi),
    runNonInteractive: (_tokens, ctx) => {
      requireInteractiveCommand(ctx, "Remote package browsing");
      showNonInteractiveHelp(ctx);
    },
  },
  installed: {
    id: "installed",
    description: "List installed packages",
    runInteractive: (_tokens, ctx, pi) => showInstalledPackagesLegacy(ctx, pi),
    runNonInteractive: (_tokens, ctx, pi) => showInstalledPackagesList(ctx, pi),
  },
  search: {
    id: "search",
    description: "Search npm for packages",
    runInteractive: (tokens, ctx, pi) => showRemote(`search ${tokens.join(" ")}`, ctx, pi),
    runNonInteractive: (_tokens, ctx) => {
      requireInteractiveCommand(ctx, "Search");
      showNonInteractiveHelp(ctx);
    },
  },
  install: {
    id: "install",
    description: "Install a package",
    runInteractive: (tokens, ctx, pi) =>
      tokens.length > 0 ? handleInstallSubcommand(tokens, ctx, pi) : showRemote("install", ctx, pi),
    runNonInteractive: (tokens, ctx, pi) =>
      tokens.length > 0
        ? handleInstallSubcommand(tokens, ctx, pi)
        : notify(ctx, INSTALL_USAGE, "info"),
  },
  remove: {
    id: "remove",
    description: "Remove an installed package",
    aliases: ["uninstall"],
    runInteractive: (tokens, ctx, pi) =>
      tokens.length > 0 ? removePackage(tokens.join(" "), ctx, pi) : promptRemove(ctx, pi),
    runNonInteractive: (tokens, ctx, pi) =>
      tokens.length > 0
        ? removePackage(tokens.join(" "), ctx, pi)
        : notify(ctx, REMOVE_USAGE, "info"),
  },
  update: {
    id: "update",
    description: "Update one package or all packages",
    runInteractive: (tokens, ctx, pi) =>
      tokens.length > 0 ? updatePackage(tokens.join(" "), ctx, pi) : updatePackages(ctx, pi),
    runNonInteractive: (tokens, ctx, pi) =>
      tokens.length > 0 ? updatePackage(tokens.join(" "), ctx, pi) : updatePackages(ctx, pi),
  },
  history: {
    id: "history",
    description: "View extension change history",
    runInteractive: (tokens, ctx, pi) => showHistory(ctx, pi, tokens, false),
    runNonInteractive: (tokens, ctx, pi) => showHistory(ctx, pi, tokens, true),
  },
  "clear-cache": {
    id: "clear-cache",
    description: "Clear metadata cache",
    runInteractive: (_tokens, ctx, pi) => clearMetadataCache(ctx, pi),
    runNonInteractive: (_tokens, ctx, pi) => clearMetadataCache(ctx, pi),
  },
  "auto-update": {
    id: "auto-update",
    description: "Configure auto-update schedule",
    runInteractive: (tokens, ctx, pi) => handleAutoUpdateCommand(tokens.join(" "), ctx, pi),
    runNonInteractive: (tokens, ctx, pi) => handleAutoUpdateCommand(tokens.join(" "), ctx, pi),
  },
};

const COMMAND_ALIAS_TO_ID: Record<string, CommandId> = Object.values(COMMAND_DEFINITIONS).reduce(
  (acc, def) => {
    acc[def.id] = def.id;
    for (const alias of def.aliases ?? []) {
      acc[alias] = def.id;
    }
    return acc;
  },
  {} as Record<string, CommandId>
);

function resolveCommand(tokens: string[]): { id: CommandId; args: string[] } | undefined {
  if (tokens.length === 0) {
    return { id: "local", args: [] };
  }

  const normalized = tokens[0]?.toLowerCase() ?? "";
  const id = COMMAND_ALIAS_TO_ID[normalized];
  if (!id) return undefined;

  return { id, args: tokens.slice(1) };
}

function getAutocompleteItems(prefix: string): AutocompleteItem[] | null {
  const items = Object.values(COMMAND_DEFINITIONS).flatMap((def) => {
    const base = [{ value: def.id, description: def.description }];
    const aliases = (def.aliases ?? []).map((alias) => ({
      value: alias,
      description: `${def.description} (alias)`,
    }));
    return [...base, ...aliases];
  });

  const safePrefix = (prefix ?? "").toLowerCase();
  const filtered = items.filter(
    (item) =>
      item.value.toLowerCase().startsWith(safePrefix) ||
      item.description.toLowerCase().includes(safePrefix)
  );

  return filtered.length > 0
    ? filtered.map((item) => ({ value: item.value, label: `${item.value} - ${item.description}` }))
    : null;
}

function showNonInteractiveHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager (non-interactive mode)",
    "Remote package browsing requires interactive mode.",
    "",
    "Available commands:",
    "  /extensions list      - List local extensions",
    "  /extensions installed - List installed packages",
    `  ${INSTALL_USAGE} - Install a package`,
    "  /extensions remove <source>  - Remove a package",
    "  /extensions update [source]  - Update one package or all packages",
    "  /extensions history [opts]   - Show history (supports filters)",
    "  /extensions auto-update <d>  - Configure auto-update (e.g. 1d, 1w, never)",
    "",
    "History examples:",
    "  /extensions history --failed --limit 50",
    "  /extensions history --action package_update --since 7d",
    "  /extensions history --global --package extmgr --since 24h",
  ];

  notify(ctx, lines.join("\n"), "info");
}

function showUnknownCommandMessage(
  rawSubcommand: string | undefined,
  ctx: ExtensionCommandContext
): void {
  const known = Object.keys(COMMAND_ALIAS_TO_ID)
    .filter((key) => key === COMMAND_ALIAS_TO_ID[key])
    .sort()
    .join(", ");

  notify(ctx, `Unknown command: ${rawSubcommand ?? "(empty)"}. Try: ${known}`, "warning");
}

async function executeExtensionsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const tokens = tokenizeArgs(args);
  const resolved = resolveCommand(tokens);

  if (resolved) {
    const definition = COMMAND_DEFINITIONS[resolved.id];
    const runner = ctx.hasUI ? definition.runInteractive : definition.runNonInteractive;
    await runner(resolved.args, ctx, pi);
    return;
  }

  const rawSubcommand = tokens[0];
  if (rawSubcommand && isPackageSource(rawSubcommand)) {
    await installPackage(args.trim(), ctx, pi);
    return;
  }

  if (ctx.hasUI) {
    showUnknownCommandMessage(rawSubcommand, ctx);
  } else {
    showNonInteractiveHelp(ctx);
  }
}

export default function extensionsManager(pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "Manage local extensions and browse/install community packages",
    getArgumentCompletions: getAutocompleteItems,
    handler: async (args, ctx) => {
      await executeExtensionsCommand(args, ctx, pi);
    },
  });

  // Status bar update function
  async function updateStatusBar(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    await updateExtmgrStatus(ctx, pi);
  }

  // Status bar integration and auto-update startup
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Start auto-update timer if configured
    startAutoUpdateTimer(pi, ctx, (packages) => {
      notify(
        ctx,
        `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
        "info"
      );
    });

    // Defer status update to avoid interfering with extension loading lifecycle
    setImmediate(() => {
      void updateStatusBar(ctx);
    });
  });

  // Clean up timer on shutdown
  pi.on("session_shutdown", () => {
    stopAutoUpdateTimer();
  });
}

async function handleAutoUpdateCommand(
  args: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  const trimmed = args.trim();

  // Interactive wizard when no arguments are provided
  if (!trimmed && ctx.hasUI) {
    await promptAutoUpdateWizard(pi, ctx, (packages) => {
      notify(
        ctx,
        `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
        "info"
      );
    });
    void updateExtmgrStatus(ctx, pi);
    return;
  }

  const duration = parseDuration(trimmed);

  if (!duration) {
    // Show current status
    const status = getAutoUpdateStatus(ctx);
    notify(ctx, `Auto-update: ${status}`, "info");

    // Show usage
    const usage = [
      "Usage: /extensions auto-update <duration>",
      "",
      "Duration examples:",
      "  never   - Disable auto-updates",
      "  1h      - Check every hour",
      "  2h      - Check every 2 hours",
      "  1d      - Check daily",
      "  3d      - Check every 3 days",
      "  1w      - Check weekly",
      "  2w      - Check every 2 weeks",
      "  1m      - Check monthly",
      "  daily   - Check daily (alias)",
      "  weekly  - Check weekly (alias)",
    ];
    notify(ctx, usage.join("\n"), "info");
    return;
  }

  if (duration.ms === 0) {
    disableAutoUpdate(pi, ctx);
  } else {
    enableAutoUpdate(pi, ctx, duration.ms, duration.display, (packages) => {
      notify(
        ctx,
        `Updates available for ${packages.length} package(s): ${packages.join(", ")}`,
        "info"
      );
    });
  }

  void updateExtmgrStatus(ctx, pi);
}

interface ParsedInstallArgs {
  source: string;
  scope?: InstallScope;
  errors: string[];
}

interface InstallParseState {
  sourceParts: string[];
  scope?: InstallScope;
  errors: string[];
}

type InstallOptionHandler = (state: InstallParseState) => void;

const INSTALL_OPTION_HANDLERS: Record<string, InstallOptionHandler> = {
  "--project": (state) => {
    if (state.scope === "global") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "project";
  },
  "-l": (state) => {
    if (state.scope === "global") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "project";
  },
  "--global": (state) => {
    if (state.scope === "project") {
      state.errors.push("Use either --project or --global, not both");
    }
    state.scope = "global";
  },
};

function parseInstallArgs(tokens: string[]): ParsedInstallArgs {
  const state: InstallParseState = {
    sourceParts: [],
    errors: [],
  };

  for (const token of tokens) {
    const optionHandler = INSTALL_OPTION_HANDLERS[token];
    if (optionHandler) {
      optionHandler(state);
    } else {
      state.sourceParts.push(token);
    }
  }

  return {
    source: state.sourceParts.join(" ").trim(),
    ...(state.scope ? { scope: state.scope } : {}),
    errors: state.errors,
  };
}

async function handleInstallSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  const parsed = parseInstallArgs(tokens);

  if (parsed.errors.length > 0) {
    notify(ctx, parsed.errors.join("\n"), "warning");
    notify(ctx, INSTALL_USAGE, "info");
    return;
  }

  if (!parsed.source) {
    notify(ctx, INSTALL_USAGE, "info");
    return;
  }

  await installPackage(parsed.source, ctx, pi, parsed.scope ? { scope: parsed.scope } : undefined);
}

const HISTORY_ACTIONS: ChangeAction[] = [
  "extension_toggle",
  "package_install",
  "package_update",
  "package_remove",
  "cache_clear",
];

interface ParsedHistoryArgs {
  filters: HistoryFilters;
  global: boolean;
  showHelp: boolean;
  errors: string[];
}

interface HistoryParseState {
  filters: HistoryFilters;
  global: boolean;
  showHelp: boolean;
  errors: string[];
}

type HistoryOptionHandler = (tokens: string[], index: number, state: HistoryParseState) => number;

const HISTORY_ACTION_SET = new Set<ChangeAction>(HISTORY_ACTIONS);

function parseHistorySinceDuration(input: string): number | undefined {
  const normalized = input.toLowerCase().trim();
  const match = normalized.match(
    /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months)$/
  );
  if (!match) return undefined;

  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = match[2] ?? "";
  if (unit.startsWith("m") && !unit.startsWith("mo")) {
    return value * 60 * 1000;
  }
  if (unit.startsWith("h")) {
    return value * 60 * 60 * 1000;
  }
  if (unit.startsWith("d")) {
    return value * 24 * 60 * 60 * 1000;
  }
  if (unit.startsWith("w")) {
    return value * 7 * 24 * 60 * 60 * 1000;
  }
  if (unit.startsWith("mo")) {
    return value * 30 * 24 * 60 * 60 * 1000;
  }

  return undefined;
}

const HISTORY_OPTION_HANDLERS: Record<string, HistoryOptionHandler> = {
  "--help": (_tokens, _index, state) => {
    state.showHelp = true;
    return 0;
  },
  "-h": (_tokens, _index, state) => {
    state.showHelp = true;
    return 0;
  },
  "--global": (_tokens, _index, state) => {
    state.global = true;
    return 0;
  },
  "--limit": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--limit requires a number");
      return 0;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      state.errors.push(`Invalid --limit value: ${value}`);
    } else {
      state.filters.limit = parsed;
    }

    return 1;
  },
  "--action": (tokens, index, state) => {
    const value = tokens[index + 1] as ChangeAction | undefined;
    if (!value) {
      state.errors.push("--action requires a value");
      return 0;
    }

    if (!HISTORY_ACTION_SET.has(value)) {
      state.errors.push(`Invalid --action value: ${value}`);
    } else {
      state.filters.action = value;
    }

    return 1;
  },
  "--failed": (_tokens, _index, state) => {
    if (state.filters.success === true) {
      state.errors.push("Use either --success or --failed, not both");
    }
    state.filters.success = false;
    return 0;
  },
  "--success": (_tokens, _index, state) => {
    if (state.filters.success === false) {
      state.errors.push("Use either --success or --failed, not both");
    }
    state.filters.success = true;
    return 0;
  },
  "--package": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--package requires a value");
      return 0;
    }

    state.filters.packageQuery = value;
    return 1;
  },
  "--since": (tokens, index, state) => {
    const value = tokens[index + 1];
    if (!value) {
      state.errors.push("--since requires a duration (e.g. 30m, 7d, 24h)");
      return 0;
    }

    const ms = parseHistorySinceDuration(value);
    if (!ms) {
      state.errors.push(`Invalid --since duration: ${value}`);
    } else {
      state.filters.sinceTimestamp = Date.now() - ms;
    }

    return 1;
  },
};

function parseHistoryArgs(tokens: string[]): ParsedHistoryArgs {
  const state: HistoryParseState = {
    filters: { limit: 20 },
    global: false,
    showHelp: false,
    errors: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const handler = HISTORY_OPTION_HANDLERS[token];

    if (!handler) {
      state.errors.push(`Unknown history option: ${token}`);
      continue;
    }

    const consumed = handler(tokens, i, state);
    i += consumed;
  }

  return {
    filters: state.filters,
    global: state.global,
    showHelp: state.showHelp,
    errors: state.errors,
  };
}

function showHistoryHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Usage: /extensions history [options]",
    "",
    "Options:",
    "  --limit <n>      Maximum entries to show (default: 20)",
    "  --action <type>  Filter by action",
    "                   extension_toggle | package_install | package_update | package_remove | cache_clear",
    "  --success        Show only successful entries",
    "  --failed         Show only failed entries",
    "  --package <q>    Filter by package/source/extension id",
    "  --since <d>      Show only entries newer than duration (e.g. 30m, 24h, 7d, 1mo)",
    "  --global         Read all persisted sessions (non-interactive mode only)",
    "",
    "Examples:",
    "  /extensions history --failed --limit 50",
    "  /extensions history --action package_update --since 7d",
    "  /extensions history --package extmgr --since 30m",
    "  /extensions history --global --failed --since 14d",
  ];

  notify(ctx, lines.join("\n"), "info");
}

function formatSessionSuffix(sessionFile: string): string {
  const marker = "/.pi/agent/sessions/";
  const normalized = sessionFile.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length);
  }
  return sessionFile;
}

async function showHistory(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  tokens: string[],
  allowGlobal: boolean
): Promise<void> {
  const parsed = parseHistoryArgs(tokens);

  if (parsed.showHelp) {
    showHistoryHelp(ctx);
    return;
  }

  if (parsed.errors.length > 0) {
    notify(ctx, parsed.errors.join("\n"), "warning");
    showHistoryHelp(ctx);
    return;
  }

  if (parsed.global && !allowGlobal) {
    notify(ctx, "--global is only available in non-interactive mode.", "warning");
    return;
  }

  if (parsed.global) {
    const changes = await queryGlobalHistory(parsed.filters);
    if (changes.length === 0) {
      notify(ctx, "No matching extension changes found across persisted sessions.", "info");
      return;
    }

    const lines = changes.map(
      ({ change, sessionFile }) =>
        `${formatChangeEntry(change)}  [${formatSessionSuffix(sessionFile)}]`
    );
    formatListOutput(ctx, `Extension Change History (global, recent ${changes.length})`, lines);
    return;
  }

  const changes = querySessionChanges(ctx, parsed.filters);
  if (changes.length === 0) {
    notify(ctx, "No matching extension changes found in this session.", "info");
    return;
  }

  const lines = changes.map(formatChangeEntry);
  formatListOutput(ctx, `Extension Change History (recent ${changes.length})`, lines);
}

async function clearMetadataCache(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  try {
    await clearCache();
    logCacheClear(pi, true);
    notify(ctx, "Metadata cache cleared.", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCacheClear(pi, false, message);
    notify(ctx, `Failed to clear metadata cache: ${message}`, "error");
  }

  void updateExtmgrStatus(ctx, pi);
}

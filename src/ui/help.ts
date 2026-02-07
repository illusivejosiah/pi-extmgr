/**
 * Help display
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "Extensions Manager Help",
    "",
    "Unified View:",
    "  Local extensions and npm/git packages are displayed together",
    "  Local extensions show ● enabled / ○ disabled with G/P scope",
    "  Packages show 📦 with name@version and G/P scope",
    "",
    "Navigation:",
    "  ↑↓           Navigate list",
    "  Space/Enter  Toggle local extension enabled/disabled",
    "  S            Save changes to local extensions",
    "  A            Actions on selected package (update/remove)",
    "  R            Browse remote packages",
    "  ?/H          Show this help",
    "  Esc          Cancel",
    "",
    "Extension Sources:",
    "  - ~/.pi/agent/extensions/ (global - G)",
    "  - .pi/extensions/ (project-local - P)",
    "  - npm packages installed via pi install",
    "  - git packages installed via pi install",
    "",
    "Commands:",
    "  /extensions              Open manager",
    "  /extensions list         List local extensions",
    "  /extensions installed    List installed packages (legacy)",
    "  /extensions remote       Browse community packages",
    "  /extensions search <q>   Search for packages",
    "  /extensions install <s>  Install package (npm:, git:, or path)",
    "  /extensions remove <s>   Remove installed package",
  ];

  const output = lines.join("\n");
  if (ctx.hasUI) {
    ctx.ui.notify(output, "info");
  } else {
    console.log(output);
  }
}

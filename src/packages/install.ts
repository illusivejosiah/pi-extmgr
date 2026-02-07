/**
 * Package installation logic
 */
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { normalizePackageSource } from "../utils/format.js";
import { clearSearchCache } from "./discovery.js";
import { logPackageInstall } from "../utils/history.js";

export async function installPackage(
  source: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  // Check if it's a GitHub URL to a .ts file - handle as direct download
  const githubTsMatch = source.match(
    /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+\.ts)$/
  );
  if (githubTsMatch) {
    const [, owner, repo, branch, filePath] = githubTsMatch;
    if (!filePath) {
      ctx.ui.notify("Invalid GitHub URL format", "error");
      return;
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const fileName = filePath.split("/").pop() || `${owner}-${repo}.ts`;
    await installFromUrl(rawUrl, fileName, ctx, pi);
    return;
  }

  // Check if it's already a raw URL to a .ts file
  if (source.match(/^https:\/\/raw\.githubusercontent\.com\/.*\.ts$/)) {
    const fileName = source.split("/").pop() || "extension.ts";
    await installFromUrl(source, fileName, ctx, pi);
    return;
  }

  const normalized = normalizePackageSource(source);

  // Confirm installation (interactive only)
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Install Package", `Install ${normalized}?`, {
      timeout: 30000,
    });

    if (!confirmed) {
      ctx.ui.notify("Installation cancelled.", "info");
      return;
    }

    ctx.ui.notify(`Installing ${normalized}...`, "info");
  } else {
    console.log(`Installing ${normalized}...`);
  }

  const res = await pi.exec("pi", ["install", normalized], { timeout: 180000, cwd: ctx.cwd });

  if (res.code !== 0) {
    const errorMsg = `Install failed:\n${res.stderr || res.stdout || `exit ${res.code}`}`;
    // Log failed installation
    logPackageInstall(pi, normalized, normalized, undefined, "global", false, errorMsg);
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
    return;
  }

  clearSearchCache();

  // Log successful installation
  logPackageInstall(pi, normalized, normalized, undefined, "global", true);

  if (ctx.hasUI) {
    ctx.ui.notify(`Installed ${normalized}`, "info");

    const shouldReload = await ctx.ui.confirm(
      "Reload Required",
      "Package installed. Reload pi now?"
    );

    if (shouldReload) {
      ctx.ui.setEditorText("/reload");
    }
  } else {
    console.log(`Installed ${normalized}`);
    console.log("Run /reload to apply changes.");
  }
}

export async function installFromUrl(
  url: string,
  fileName: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<void> {
  // Get global extensions directory
  const globalExtDir = join(homedir(), ".pi", "agent", "extensions");

  // Confirm installation
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Install from URL",
      `Download ${fileName} from GitHub?`,
      { timeout: 30000 }
    );
    if (!confirmed) {
      ctx.ui.notify("Installation cancelled.", "info");
      return;
    }
  }

  try {
    // Ensure directory exists
    await mkdir(globalExtDir, { recursive: true });

    if (ctx.hasUI) {
      ctx.ui.notify(`Downloading ${fileName}...`, "info");
    } else {
      console.log(`Downloading ${fileName}...`);
    }

    // Download the file
    const response = await fetch(url);
    if (!response.ok) {
      const errorMsg = `Download failed: ${response.status} ${response.statusText}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    const content = await response.text();
    const destPath = join(globalExtDir, fileName);

    // Write file
    await writeFile(destPath, content, "utf8");

    const successMsg = `Installed ${fileName} to:\n${destPath}`;
    if (ctx.hasUI) {
      ctx.ui.notify(successMsg, "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Extension installed. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log(successMsg);
      console.log("Run /reload to apply changes.");
    }
  } catch (error) {
    const errorMsg = `Installation failed: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
  }
}

export async function installPackageLocally(
  packageName: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  // Confirm local installation
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Install Locally",
      `Download ${packageName} to ~/.pi/agent/extensions/?\n\nThis installs as a standalone extension (manual updates).`,
      { timeout: 30000 }
    );
    if (!confirmed) {
      ctx.ui.notify("Installation cancelled.", "info");
      return;
    }
  }

  // Get global extensions directory
  const globalExtDir = join(homedir(), ".pi", "agent", "extensions");

  try {
    // Ensure directory exists
    await mkdir(globalExtDir, { recursive: true });

    // Get package info from npm
    if (ctx.hasUI) {
      ctx.ui.notify(`Fetching ${packageName}...`, "info");
    } else {
      console.log(`Fetching ${packageName}...`);
    }

    const viewRes = await pi.exec("npm", ["view", packageName, "--json"], {
      timeout: 30000,
      cwd: ctx.cwd,
    });

    if (viewRes.code !== 0) {
      const errorMsg = `Failed to fetch package info: ${viewRes.stderr || viewRes.stdout}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    let pkgInfo: { version?: string; dist?: { tarball?: string } };
    try {
      pkgInfo = JSON.parse(viewRes.stdout) as { version?: string; dist?: { tarball?: string } };
    } catch {
      const errorMsg = "Failed to parse package info";
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    const version = pkgInfo.version ?? "latest";
    const tarballUrl = pkgInfo.dist?.tarball;

    if (!tarballUrl) {
      const errorMsg = "No tarball URL found for package";
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Download tarball to temp location
    const tempDir = join(globalExtDir, ".temp");
    await mkdir(tempDir, { recursive: true });
    const tarballPath = join(tempDir, `${packageName.replace(/[@/]/g, "-")}-${version}.tgz`);

    if (ctx.hasUI) {
      ctx.ui.notify(`Downloading ${packageName}@${version}...`, "info");
    } else {
      console.log(`Downloading ${packageName}@${version}...`);
    }

    // Download the tarball
    const response = await fetch(tarballUrl);
    if (!response.ok) {
      const errorMsg = `Download failed: ${response.status} ${response.statusText}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Save tarball
    try {
      const buffer = await response.arrayBuffer();
      await writeFile(tarballPath, new Uint8Array(buffer));
    } catch (err) {
      const errorMsg = `Download failed: ${err instanceof Error ? err.message : String(err)}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Extract tarball to temp dir first
    if (ctx.hasUI) {
      ctx.ui.notify(`Extracting ${packageName}...`, "info");
    } else {
      console.log(`Extracting ${packageName}...`);
    }

    // Create a unique temp extraction directory to avoid collisions
    const extractDir = join(
      tempDir,
      `extracted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(extractDir, { recursive: true });

    // Extract with tar
    const extractRes = await pi.exec(
      "tar",
      ["-xzf", tarballPath, "-C", extractDir, "--strip-components=1"],
      {
        timeout: 30000,
        cwd: ctx.cwd,
      }
    );

    // Clean up tarball
    await rm(tarballPath, { force: true });

    if (extractRes.code !== 0) {
      // Clean up extraction dir
      await rm(extractDir, { recursive: true, force: true });
      const errorMsg = `Extraction failed: ${extractRes.stderr || extractRes.stdout}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Find index.ts in extracted package
    const indexPath = join(extractDir, "index.ts");
    try {
      await access(indexPath);
    } catch {
      // Clean up extraction dir
      await rm(extractDir, { recursive: true, force: true });
      const errorMsg = `Package ${packageName} does not have an index.ts file`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Copy entire directory to extensions dir (supports multi-file extensions)
    const extDirName = packageName.replace(/[@/]/g, "-");
    const destDir = join(globalExtDir, extDirName);

    // Remove existing directory if present
    await rm(destDir, { recursive: true, force: true });

    // Copy entire extracted directory
    const copyRes = await pi.exec("cp", ["-r", extractDir, destDir], {
      timeout: 30000,
      cwd: ctx.cwd,
    });
    if (copyRes.code !== 0) {
      // Clean up extraction dir
      await rm(extractDir, { recursive: true, force: true });
      const errorMsg = `Failed to copy extension directory: ${copyRes.stderr || copyRes.stdout || `exit ${copyRes.code}`}`;
      if (ctx.hasUI) {
        ctx.ui.notify(errorMsg, "error");
      } else {
        console.error(errorMsg);
      }
      return;
    }

    // Clean up extraction dir
    await rm(extractDir, { recursive: true, force: true });

    clearSearchCache();

    // Success
    const successMsg = `Installed ${packageName}@${version} locally to:\n${destDir}/index.ts`;
    if (ctx.hasUI) {
      ctx.ui.notify(successMsg, "info");

      const shouldReload = await ctx.ui.confirm(
        "Reload Required",
        "Extension installed. Reload pi now?"
      );

      if (shouldReload) {
        ctx.ui.setEditorText("/reload");
      }
    } else {
      console.log(successMsg);
      console.log("Run /reload to apply changes.");
    }
  } catch (error) {
    const errorMsg = `Installation failed: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(errorMsg, "error");
    } else {
      console.error(errorMsg);
    }
  }
}

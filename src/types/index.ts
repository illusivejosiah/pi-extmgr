/**
 * Core types and interfaces for pi-extmgr
 */

export type Scope = "global" | "project";
export type State = "enabled" | "disabled";

export interface ExtensionEntry {
  id: string;
  scope: Scope;
  state: State;
  activePath: string;
  disabledPath: string;
  displayName: string;
  summary: string;
}

export interface NpmPackage {
  name: string;
  version?: string | undefined;
  description?: string | undefined;
  keywords?: string[] | undefined;
  date?: string | undefined;
  size?: number | undefined; // Package size in bytes
}

export interface InstalledPackage {
  source: string;
  name: string;
  version?: string | undefined;
  scope: "global" | "project";
  resolvedPath?: string | undefined;
  description?: string | undefined;
  size?: number | undefined; // Package size in bytes
}

export interface PackageExtensionEntry {
  id: string;
  packageSource: string;
  packageName: string;
  packageScope: Scope;
  extensionPath: string;
  absolutePath: string;
  displayName: string;
  summary: string;
  state: State;
}

export type ResourceType = "extension" | "skill" | "agent" | "prompt" | "theme";

export interface PackageResourceEntry {
  id: string;
  packageSource: string;
  packageName: string;
  packageScope: Scope;
  resourceType: ResourceType;
  resourcePath: string;
  displayName: string;
  summary: string;
}

export interface UnifiedItem {
  type: "local" | "package" | "package-extension" | "package-resource";
  id: string;
  displayName: string;
  summary: string;
  scope: Scope | "global" | "project";
  // Local extension fields
  state?: State | undefined;
  activePath?: string | undefined;
  disabledPath?: string | undefined;
  originalState?: State | undefined;
  // Package fields
  source?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  size?: number | undefined; // Package size in bytes
  updateAvailable?: boolean | undefined;
  // Package extension fields
  packageSource?: string | undefined;
  extensionPath?: string | undefined;
  // Package resource fields (skills, agents, prompts, themes)
  resourceType?: ResourceType | undefined;
}

export interface SearchCache {
  query: string;
  results: NpmPackage[];
  timestamp: number;
}

// Action types for unified view
export type UnifiedAction =
  | { type: "cancel" }
  | { type: "apply" }
  | { type: "remote" }
  | { type: "help" }
  | { type: "menu" }
  | { type: "quick"; action: "install" | "search" | "update-all" | "auto-update" }
  | { type: "action"; itemId: string; action?: "menu" | "update" | "remove" | "details" };

export type BrowseAction =
  | { type: "package"; name: string }
  | { type: "prev" }
  | { type: "next" }
  | { type: "refresh" }
  | { type: "menu" }
  | { type: "main" }
  | { type: "help" }
  | { type: "cancel" };

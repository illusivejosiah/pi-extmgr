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
  version?: string;
  description?: string;
  keywords?: string[];
  date?: string;
}

export interface InstalledPackage {
  source: string;
  name: string;
  version?: string;
  scope: "global" | "project";
  description?: string;
}

export interface UnifiedItem {
  type: "local" | "package";
  id: string;
  displayName: string;
  summary: string;
  scope: Scope | "global" | "project";
  // Local extension fields
  state?: State;
  activePath?: string;
  disabledPath?: string;
  originalState?: State;
  // Package fields
  source?: string;
  version?: string | undefined;
  description?: string | undefined;
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
  | { type: "action"; itemId: string };

export type BrowseAction =
  | { type: "package"; name: string }
  | { type: "prev" }
  | { type: "next" }
  | { type: "refresh" }
  | { type: "menu" }
  | { type: "main" }
  | { type: "help" }
  | { type: "cancel" };

export type MenuAction = "browse" | "search" | "install" | "cancel" | "main" | "help";

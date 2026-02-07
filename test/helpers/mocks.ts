import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface ExecCall {
  command: string;
  args: string[];
}

export type ExecImpl = (command: string, args: string[]) => ExecResult | Promise<ExecResult>;

export interface MockHarnessOptions {
  cwd?: string;
  hasUI?: boolean;
  execImpl?: ExecImpl;
}

const OK: ExecResult = { code: 0, stdout: "ok", stderr: "", killed: false };

export function createMockHarness(options: MockHarnessOptions = {}): {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  calls: ExecCall[];
  entries: { type: "custom"; customType: string; data: unknown }[];
} {
  const calls: ExecCall[] = [];
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const execImpl = options.execImpl ?? (() => OK);

  const pi = {
    exec: (command: string, args: string[]) => {
      calls.push({ command, args });
      return Promise.resolve(execImpl(command, args));
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: options.hasUI ?? false,
    cwd: options.cwd ?? "/tmp",
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

  return { pi, ctx, calls, entries };
}

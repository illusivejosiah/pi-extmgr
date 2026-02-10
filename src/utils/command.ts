/**
 * Shared command/choice parsing helpers
 */

export function tokenizeArgs(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean);
}

export function splitCommandArgs(input: string): { subcommand: string; args: string[] } {
  const [subcommand = "", ...args] = tokenizeArgs(input);
  return { subcommand: subcommand.toLowerCase(), args };
}

export function parseChoiceByLabel<T extends string>(
  choices: Record<T, string>,
  label: string | undefined
): T | undefined {
  if (!label) return undefined;

  const match = (Object.entries(choices) as [T, string][]).find(([, value]) => value === label);
  return match?.[0];
}

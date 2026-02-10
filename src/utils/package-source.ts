/**
 * Package source parsing helpers shared across discovery/management flows.
 */

export function splitGitRepoAndRef(gitSpec: string): { repo: string; ref?: string | undefined } {
  const lastAt = gitSpec.lastIndexOf("@");
  if (lastAt <= 0) {
    return { repo: gitSpec };
  }

  const tail = gitSpec.slice(lastAt + 1);
  // Refs don't contain path separators or URL separators.
  if (!tail || tail.includes("/") || tail.includes(":")) {
    return { repo: gitSpec };
  }

  return { repo: gitSpec.slice(0, lastAt), ref: tail };
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseInstalledPackagesOutput,
  parseInstalledPackagesOutputAllScopes,
} from "../src/packages/discovery.js";
import { parseNpmSource } from "../src/utils/format.js";

void test("parseInstalledPackagesOutput parses scopes, names, versions, and resolved path lines", () => {
  const input = `
User packages:
  npm:pi-extmgr@0.1.4
Project packages:
  git:https://github.com/user/repo.git@main (filtered)
    resolved: /tmp/.pi/git/github.com/user/repo
  /home/user/.fnm/node_modules/local-pkg
    /tmp/.pi/npm/local-pkg
`;

  const result = parseInstalledPackagesOutput(input);

  assert.equal(result.length, 3);

  assert.deepEqual(result[0], {
    source: "npm:pi-extmgr@0.1.4",
    name: "pi-extmgr",
    version: "0.1.4",
    scope: "global",
  });

  assert.deepEqual(result[1], {
    source: "git:https://github.com/user/repo.git@main",
    name: "repo",
    scope: "project",
    resolvedPath: "/tmp/.pi/git/github.com/user/repo",
  });

  assert.deepEqual(result[2], {
    source: "/home/user/.fnm/node_modules/local-pkg",
    name: "local-pkg",
    scope: "project",
    resolvedPath: "/tmp/.pi/npm/local-pkg",
  });
});

void test("parseInstalledPackagesOutput deduplicates by normalized source", () => {
  const input = `
Global:
  npm:dup-pkg@1.0.0
  npm:dup-pkg@1.0.0 (filtered)
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.source, "npm:dup-pkg@1.0.0");
});

void test("parseInstalledPackagesOutputAllScopes keeps duplicates across scopes", () => {
  const input = `
Global:
  npm:dup-pkg@1.0.0
Project:
  npm:dup-pkg@1.0.0
`;

  const result = parseInstalledPackagesOutputAllScopes(input);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.scope, "global");
  assert.equal(result[1]?.scope, "project");
});

void test("parseInstalledPackagesOutput parses ssh git sources", () => {
  const input = `
Global:
  git:git@github.com:user/super-ext.git@v1
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "super-ext");
});

void test("parseNpmSource parses scoped and unscoped package specs", () => {
  assert.deepEqual(parseNpmSource("npm:demo@1.2.3"), { name: "demo", version: "1.2.3" });
  assert.deepEqual(parseNpmSource("npm:@scope/demo@1.2.3"), {
    name: "@scope/demo",
    version: "1.2.3",
  });
  assert.deepEqual(parseNpmSource("npm:@scope/demo"), { name: "@scope/demo" });
  assert.equal(parseNpmSource("git:https://example.com/repo.git"), undefined);
});

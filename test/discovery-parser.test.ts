import test from "node:test";
import assert from "node:assert/strict";
import { parseInstalledPackagesOutput } from "../src/packages/discovery.js";

void test("parseInstalledPackagesOutput parses scopes, names, and versions", () => {
  const input = `
Global packages:
  npm:pi-extmgr@0.1.4
  npm:@scope/pkg@2.3.4
Project packages:
  git:https://github.com/user/repo.git@main
  /home/user/.fnm/node_modules/local-pkg
    resolved: /home/user/.fnm/node_modules/local-pkg
`;

  const result = parseInstalledPackagesOutput(input);

  assert.equal(result.length, 4);

  assert.deepEqual(result[0], {
    source: "npm:pi-extmgr@0.1.4",
    name: "pi-extmgr",
    version: "0.1.4",
    scope: "global",
  });

  assert.deepEqual(result[1], {
    source: "npm:@scope/pkg@2.3.4",
    name: "@scope/pkg",
    version: "2.3.4",
    scope: "global",
  });

  assert.deepEqual(result[2], {
    source: "git:https://github.com/user/repo.git@main",
    name: "https://github.com/user/repo.git",
    scope: "project",
  });

  assert.deepEqual(result[3], {
    source: "/home/user/.fnm/node_modules/local-pkg",
    name: "local-pkg",
    scope: "project",
  });
});

void test("parseInstalledPackagesOutput deduplicates by package name", () => {
  const input = `
Global:
  npm:dup-pkg@1.0.0
Project:
  /some/path/node_modules/dup-pkg
`;

  const result = parseInstalledPackagesOutput(input);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.name, "dup-pkg");
});

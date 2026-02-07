import test from "node:test";
import assert from "node:assert/strict";
import { installPackage } from "../src/packages/install.js";
import { removePackage } from "../src/packages/management.js";
import { createMockHarness } from "./helpers/mocks.js";

void test("installPackage calls pi install with normalized npm source", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await installPackage("pi-extmgr", ctx, pi);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "pi");
  assert.deepEqual(calls[0]?.args, ["install", "npm:pi-extmgr"]);
});

void test("removePackage calls pi remove", async () => {
  const { pi, ctx, calls } = createMockHarness();

  await removePackage("npm:pi-extmgr", ctx, pi);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "pi");
  assert.deepEqual(calls[0]?.args, ["remove", "npm:pi-extmgr"]);
});

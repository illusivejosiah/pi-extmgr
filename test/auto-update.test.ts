import test from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates } from "../src/utils/auto-update.js";
import { parseDuration } from "../src/utils/settings.js";
import { createMockHarness, type ExecResult } from "./helpers/mocks.js";

void test("parseDuration supports flexible durations", () => {
  assert.deepEqual(parseDuration("1h"), { ms: 60 * 60 * 1000, display: "1 hour" });
  assert.deepEqual(parseDuration("3d"), { ms: 3 * 24 * 60 * 60 * 1000, display: "3 days" });
  assert.deepEqual(parseDuration("2w"), {
    ms: 2 * 7 * 24 * 60 * 60 * 1000,
    display: "2 weeks",
  });
  assert.deepEqual(parseDuration("1m"), {
    ms: 30 * 24 * 60 * 60 * 1000,
    display: "1 month",
  });
  assert.deepEqual(parseDuration("never"), { ms: 0, display: "off" });
  assert.equal(parseDuration("nope"), undefined);
});

void test("checkForUpdates detects npm package update availability", async () => {
  const { pi, ctx } = createMockHarness({
    execImpl: (command: string, args: string[]): ExecResult => {
      if (command === "pi" && args[0] === "list") {
        return {
          code: 0,
          stdout: "Global:\n  npm:demo-pkg@1.0.0\n",
          stderr: "",
          killed: false,
        };
      }

      if (command === "npm" && args[0] === "view" && args[2] === "description") {
        return { code: 0, stdout: '"demo"', stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "dist.unpackedSize") {
        return { code: 0, stdout: "1234", stderr: "", killed: false };
      }
      if (command === "npm" && args[0] === "view" && args[2] === "version") {
        return { code: 0, stdout: '"1.1.0"', stderr: "", killed: false };
      }

      return { code: 1, stdout: "", stderr: "unknown call", killed: false };
    },
  });

  const updates = await checkForUpdates(pi, ctx);
  assert.deepEqual(updates, ["demo-pkg"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBoundedDiagnostic,
  redactBoundedDiagnostic,
  waitForSessionStateWithFetcher,
} from "./smoke-hosted-runtime.mjs";

test("smoke diagnostics tolerate omitted secrets and redact before reporting", () => {
  assert.equal(appendBoundedDiagnostic("", "plain output"), "plain output");
  const buffered = appendBoundedDiagnostic("", "prefix split-secret suffix", ["split-secret"]);
  assert.equal(redactBoundedDiagnostic(buffered, ["split-secret"]), "prefix [REDACTED] suffix");
});

test("session-state polling accepts a reached target before treating runner exit as failure", async () => {
  const exitedRunner = {
    exitInfo: { code: 0, signal: null },
    describeExit: () => "code=0 signal=null",
  };

  const stopped = await waitForSessionStateWithFetcher(
    async () => ({ state: "stopped" }),
    "session-1",
    ["stopped"],
    10,
    exitedRunner,
  );
  assert.equal(stopped.state, "stopped");

  await assert.rejects(
    waitForSessionStateWithFetcher(
      async () => ({ state: "running" }),
      "session-1",
      ["stopped"],
      10,
      exitedRunner,
    ),
    /Hosted runner exited before session session-1 reached stopped: code=0 signal=null/,
  );
});

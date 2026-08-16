import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import {
  appendBoundedDiagnostic,
  HostedClientConnection,
  redactBoundedDiagnostic,
  waitForSessionStateWithFetcher,
} from "./smoke-hosted-runtime.mjs";

test("smoke diagnostics tolerate omitted secrets and redact before reporting", () => {
  assert.equal(appendBoundedDiagnostic("", "plain output"), "plain output");
  const buffered = appendBoundedDiagnostic("", "prefix split-secret suffix", ["split-secret"]);
  assert.equal(redactBoundedDiagnostic(buffered, ["split-secret"]), "prefix [REDACTED] suffix");
});

test("smoke diagnostics redact a secret suffix cut before a later occurrence shrinks the retained tail", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz1234";
  const buffered = appendBoundedDiagnostic("", secret + "x".repeat(32_748) + secret, [secret]);
  const diagnostic = redactBoundedDiagnostic(buffered, [secret]);
  assert.equal(Buffer.byteLength(diagnostic), 32_768);
  assert.equal(diagnostic.startsWith("[REDACTED]"), true);
  assert.doesNotMatch(diagnostic, /uvwxyz1234/u);
});

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  terminated = false;

  send() {}

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

test("hosted smoke clients remove timed-out waiters before receiving later envelopes", async () => {
  const socket = new FakeSocket();
  const client = new HostedClientConnection(socket, "session-1", []);
  await assert.rejects(client.next(1), /Timed out/);

  const envelope = { version: 1, direction: "pi_to_client", sequence: 1, record: { type: "agent_settled" } };
  socket.emit("message", Buffer.from(JSON.stringify(envelope)), false);
  assert.deepEqual(await client.next(10), envelope);
});

test("hosted smoke clients latch protocol violations detected without a waiter", async () => {
  const socket = new FakeSocket();
  const client = new HostedClientConnection(socket, "session-1", []);
  socket.emit("message", Buffer.from(JSON.stringify({ version: 2 })), false);

  await assert.rejects(client.next(10), /invalid envelope version or direction/);
  assert.equal(socket.terminated, true);
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

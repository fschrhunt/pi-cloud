import assert from "node:assert/strict";
import test from "node:test";
import { CloudRpcConnection, type CloudSocket } from "./rpc.js";

class FakeSocket implements CloudSocket {
  readyState = 1;
  sent: string[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: "open" | "message" | "close" | "error", event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("RPC connection uses ticket subprotocols and resolves ordered native responses", async () => {
  const socket = new FakeSocket();
  let requestedUrl = "";
  let requestedProtocols: string[] = [];
  const connecting = CloudRpcConnection.connect({
    serverUrl: "https://pi.example.test/base",
    sessionId: "00000000-0000-4000-8000-000000000001",
    ticket: "t".repeat(43),
    socketFactory(url, protocols) {
      requestedUrl = url;
      requestedProtocols = protocols;
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  const connection = await connecting;
  const responsePromise = connection.request({ type: "get_state" }, 100);
  const outbound = JSON.parse(socket.sent[0] ?? "null") as { sequence: number; record: { id: string } };
  socket.emit("message", {
    data: JSON.stringify({
      version: 1,
      hostedSessionId: connection.sessionId,
      direction: "pi_to_client",
      sequence: 1,
      record: { type: "response", id: outbound.record.id, command: "get_state", success: true, data: {} },
    }),
  });

  assert.equal(requestedUrl, "wss://pi.example.test/base/v1/hosted-sessions/00000000-0000-4000-8000-000000000001/rpc");
  assert.deepEqual(requestedProtocols, ["pi-cloud-rpc", `pi-cloud-ticket.${"t".repeat(43)}`]);
  assert.equal(outbound.sequence, 1);
  assert.equal((await responsePromise).type, "response");
  connection.close();
});

test("RPC connection closes on a non-contiguous server sequence", async () => {
  const socket = new FakeSocket();
  const connectionPromise = CloudRpcConnection.connect({
    serverUrl: "http://127.0.0.1:3000",
    sessionId: "00000000-0000-4000-8000-000000000001",
    ticket: "t".repeat(43),
    socketFactory() {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  });
  await connectionPromise;
  socket.emit("message", {
    data: JSON.stringify({
      version: 1,
      hostedSessionId: "00000000-0000-4000-8000-000000000001",
      direction: "pi_to_client",
      sequence: 2,
      record: { type: "agent_settled" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.closes, [{ code: 4400, reason: "client protocol failure" }]);
});

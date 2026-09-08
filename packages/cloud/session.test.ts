import assert from "node:assert/strict";
import test from "node:test";
import type {
  CloudClientConfig,
  CloudHostedSession,
  CloudServerCapabilities,
  CloudWorkspace,
} from "@pi-cloud/contracts";
import { CloudApiClient } from "./api.js";
import type { CloudRepository } from "./repository.js";
import type { CloudSocket } from "./rpc.js";
import { startCloudSession } from "./session.js";

const config: CloudClientConfig = {
  version: 1,
  serverUrl: "https://pi.example.test",
  token: "t".repeat(32),
};
const repository: CloudRepository = {
  root: "/repo",
  repositoryUrl: "https://github.com/owner/project.git",
  revision: "0123456789abcdef0123456789abcdef01234567",
};
const workspace: CloudWorkspace = {
  id: "00000000-0000-4000-8000-000000000001",
  repositoryUrl: repository.repositoryUrl,
  revision: repository.revision,
  projectTrust: "untrusted",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const runningSession: CloudHostedSession = {
  id: "00000000-0000-4000-8000-000000000002",
  workspaceId: workspace.id,
  state: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:10.000Z",
  startedAt: "2026-01-01T00:00:05.000Z",
  stoppedAt: null,
  archivedAt: null,
};
const capabilities: CloudServerCapabilities = {
  service: "pi-cloud-api",
  protocolVersion: 1,
  hostedRpcVersion: 1,
  features: { hostedSessions: true, reconnect: true, nativeSessionResume: true },
};

/** Minimal fetch that routes capabilities, workspace list, and ticket issuance for a new session. */
function makeFetch(): typeof fetch {
  let ticketIssued = false;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.endsWith("/v1/capabilities")) return Response.json(capabilities);
    if (url.includes("/v1/workspaces?")) return Response.json({ items: [], nextCursor: null });
    if (url.endsWith("/v1/workspaces") && request.method === "POST") {
      return Response.json({ ...workspace }, { status: 201 });
    }
    if (url.endsWith("/sessions") && request.method === "POST") {
      return Response.json({ ...runningSession, state: "queued" }, { status: 201 });
    }
    if (url.includes("/hosted-sessions/") && request.method === "GET") {
      return Response.json(runningSession);
    }
    if (url.endsWith("/rpc-ticket") && request.method === "POST") {
      ticketIssued = true;
      return Response.json({ ticket: "t".repeat(43), expiresAt: "2026-01-01T00:01:00.000Z" }, { status: 201 });
    }
    throw new Error(`unexpected request: ${request.method} ${url}`);
  };
}

class FakeSocket implements CloudSocket {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("startCloudSession resolves a new workspace, waits for running, and opens the RPC connection", async () => {
  const client = new CloudApiClient(config, makeFetch());
  const socket = new FakeSocket();
  let connectedUrl = "";

  const attachment = await startCloudSession(
    client,
    repository,
    "new",
    {
      startTimeoutMs: 1_000,
      pollIntervalMs: 10,
      socketFactory(url) {
        connectedUrl = url;
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
    },
  );

  assert.equal(attachment.workspace.id, workspace.id);
  assert.equal(attachment.session.state, "running");
  assert.equal(attachment.rpc.sessionId, runningSession.id);
  assert.ok(connectedUrl.includes("/v1/hosted-sessions/"), `unexpected URL: ${connectedUrl}`);
  attachment.rpc.close();
});

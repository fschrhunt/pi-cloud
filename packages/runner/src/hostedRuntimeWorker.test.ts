import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { HostedRuntimeLaunch } from "@pi-cloud/contracts";
import WebSocket from "ws";
import { HostedRuntimeDispatcherClient, runHostedRuntimeWorker, validateNativeSessionRecord } from "./hostedRuntimeWorker.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const exitFixture = fileURLToPath(new URL("./fixtures/exit-pi.mjs", import.meta.url));

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];

  send(payload: string): void {
    const envelope = JSON.parse(payload) as { record?: { type?: string; command?: string } };
    this.sent.push(envelope);
    if (envelope.record?.type === "response" && envelope.record.command === "get_state") {
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "stop" })), false));
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

test("dispatcher claim uses scoped bearer authentication", async () => {
  let request!: Request;
  const client = new HostedRuntimeDispatcherClient(new URL("http://127.0.0.1:3000"), "dispatcher-secret", async (input, init) => {
    request = new Request(input, init);
    return new Response(null, { status: 204 });
  });
  assert.equal(await client.claim("hosted-runner-1"), null);
  assert.equal(request.url, "http://127.0.0.1:3000/internal/v1/hosted-runtimes/claim");
  assert.equal(request.headers.get("authorization"), "Bearer dispatcher-secret");
  assert.deepEqual(JSON.parse(await request.text()), { runnerId: "hosted-runner-1" });
});

test("an aborted hosted worker does not open a tunnel or touch workspace paths", async () => {
  const controller = new AbortController();
  controller.abort();
  let openedTunnel = false;
  const launch: HostedRuntimeLaunch = {
    version: 1,
    hostedSessionId: "a0d701e3-bae6-427a-bc22-35d885915da3",
    workspaceId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
    workspaceRoot: "/workspace/repository",
    repository: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    nativeSession: { kind: "new", sessionDirectory: "/workspace/native-sessions/one" },
    piAgentDirectory: "/agent",
    credentialReferences: [],
    limits: {
      wallTimeSeconds: 10,
      idleTimeSeconds: 5,
      terminationGraceSeconds: 1,
      maxRecordBytes: 16_384,
      maxCumulativeBytes: 100_000,
    },
    projectTrust: "untrusted",
  };

  await assert.rejects(runHostedRuntimeWorker({
    dispatcher: {
      claim: async () => ({
        launch,
        credentials: [],
        tunnel: { url: "ws://127.0.0.1/internal", token: "tunnel-token" },
      }),
    },
    runnerId: "hosted-runner-1",
    authorizedRoots: { workspaceRoots: ["/workspace"], sessionRoots: ["/workspace"], agentRoots: ["/agent"] },
    createWebSocket: () => {
      openedTunnel = true;
      throw new Error("must not create a tunnel after cancellation");
    },
    signal: controller.signal,
  }), { name: "AbortError" });
  assert.equal(openedTunnel, false);
});

test("hosted worker checks out an absent repository and requests native state on startup", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-cloud-hosted-worker-"));
  const workspaceRoot = join(root, "workspaces", "one");
  const sessionDirectory = join(root, "sessions", "one");
  const piAgentDirectory = join(root, "agent", "default");
  await Promise.all([
    fs.mkdir(join(root, "workspaces"), { recursive: true }),
    fs.mkdir(sessionDirectory, { recursive: true }),
    fs.mkdir(piAgentDirectory, { recursive: true }),
  ]);
  const launch: HostedRuntimeLaunch = {
    version: 1,
    hostedSessionId: "a0d701e3-bae6-427a-bc22-35d885915da3",
    workspaceId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
    workspaceRoot,
    repository: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    nativeSession: { kind: "new", sessionDirectory },
    piAgentDirectory,
    credentialReferences: [
      { name: "provider", reference: "vault://provider/key", environmentVariable: "ANTHROPIC_API_KEY" },
    ],
    limits: {
      wallTimeSeconds: 10,
      idleTimeSeconds: 5,
      terminationGraceSeconds: 1,
      maxRecordBytes: 16_384,
      maxCumulativeBytes: 100_000,
    },
    projectTrust: "untrusted",
  };
  const outsideSessionFile = join(root, "outside-session.jsonl");
  await fs.writeFile(outsideSessionFile, "outside");
  await fs.symlink(outsideSessionFile, join(sessionDirectory, "linked-session.jsonl"));
  assert.throws(() => validateNativeSessionRecord(launch, {
    id: "pi-cloud-internal-startup-state",
    type: "response",
    command: "get_state",
    success: true,
    data: { sessionId: "native-1", sessionFile: join(sessionDirectory, "linked-session.jsonl") },
  }), /symbolic link/);

  const socket = new FakeSocket();
  const startupOrder: string[] = [];
  let checkoutCount = 0;

  try {
    assert.equal(await runHostedRuntimeWorker({
      dispatcher: {
        claim: async () => ({
          launch,
          credentials: [{ reference: "vault://provider/key", value: "scoped-secret" }],
          tunnel: { url: "ws://127.0.0.1/internal", token: "tunnel-token" },
        }),
      },
      runnerId: "hosted-runner-1",
      authorizedRoots: { workspaceRoots: [join(root, "workspaces")], sessionRoots: [join(root, "sessions")], agentRoots: [join(root, "agent")] },
      piExecutable: fixture,
      createWebSocket: () => {
        startupOrder.push("tunnel");
        return socket as unknown as WebSocket;
      },
      checkout: async () => {
        startupOrder.push("checkout");
        checkoutCount += 1;
        await fs.mkdir(workspaceRoot, { recursive: true });
        return {
          repositoryUrl: launch.repository.repositoryUrl,
          revision: launch.repository.revision,
          resolvedCommit: launch.repository.revision,
          transport: "https",
          credentialSource: "anonymous",
          credentialScrubbed: true,
          submodulesInitialized: false,
          hooksDisabled: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
    }), true);
    assert.equal(checkoutCount, 1);
    assert.deepEqual(startupOrder, ["tunnel", "checkout"]);
    const startup = socket.sent.find((value) => (value as { record?: { command?: string } }).record?.command === "get_state") as {
      record: { id: string; data: { sessionId: string; credentialPresent: boolean } };
    };
    assert.equal(startup.record.id, "pi-cloud-internal-startup-state");
    assert.equal(startup.record.data.sessionId, "native-1");
    assert.equal(startup.record.data.credentialPresent, true);
    await fs.access(workspaceRoot);
    await fs.access(sessionDirectory);

    const failedSocket = new FakeSocket();
    await assert.rejects(runHostedRuntimeWorker({
      dispatcher: {
        claim: async () => ({
          launch,
          credentials: [{ reference: "vault://provider/key", value: "scoped-secret" }],
          tunnel: { url: "ws://127.0.0.1/internal", token: "tunnel-token" },
        }),
      },
      runnerId: "hosted-runner-failure",
      authorizedRoots: {
        workspaceRoots: [join(root, "workspaces")],
        sessionRoots: [join(root, "sessions")],
        agentRoots: [join(root, "agent")],
      },
      piExecutable: exitFixture,
      createWebSocket: () => failedSocket as unknown as WebSocket,
      checkout: async () => ({
        repositoryUrl: launch.repository.repositoryUrl,
        revision: launch.repository.revision,
        resolvedCommit: launch.repository.revision,
        transport: "https",
        credentialSource: "anonymous",
        credentialScrubbed: true,
        submodulesInitialized: false,
        hooksDisabled: true,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }),
    }), /exited unexpectedly|startup/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

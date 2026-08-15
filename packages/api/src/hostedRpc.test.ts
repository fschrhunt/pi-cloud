import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";

const { privateKey } = generateKeyPairSync("ed25519");
const dispatcherToken = "development-dispatcher-token-32-characters";
const ownerToken = "owner-token-that-is-at-least-32-characters-long";
const otherToken = "other-token-that-is-at-least-32-characters-long";
const revision = "0123456789abcdef0123456789abcdef01234567";

function config(): ApiConfig {
  return {
    dispatcherToken,
    taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    taskLeaseIssuer: "pi-cloud-test",
    databasePath: ":memory:",
    apiCredentials: [
      { token: ownerToken, subjectId: "owner-1", type: "user", displayName: "Owner" },
      { token: otherToken, subjectId: "owner-2", type: "user", displayName: "Other" },
    ],
    publicBaseUrl: "https://pi-cloud.example.com",
    runtimeWorkspaceRoot: "/srv/pi-cloud/workspaces",
    runtimeAgentDirectory: "/srv/pi-cloud/agent",
    hostedLaunchLimits: {
      wallTimeSeconds: 3_600,
      idleTimeSeconds: 300,
      terminationGraceSeconds: 5,
      maxRecordBytes: 2_000,
      maxCumulativeBytes: 1_000_000,
    },
    hostedCredentialReferences: [],
    hostedCredentialValues: {},
  };
}

type Fixture = {
  app: Awaited<ReturnType<typeof buildApp>>;
  port: number;
  sessionId: string;
  workspaceRoot: string;
};

async function setup(): Promise<Fixture> {
  const app = await buildApp(config());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const port = Number(new URL(address).port);

  const workspace = (
    await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "workspace-0001" },
      payload: { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    })
  ).json();
  const session = (
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspace.id}/sessions`,
      headers: { authorization: `Bearer ${ownerToken}`, "idempotency-key": "session-0001" },
    })
  ).json();

  return { app, port, sessionId: session.id, workspaceRoot: workspace.root };
}

async function claim(app: Fixture["app"]): Promise<{ launch: { hostedSessionId: string }; tunnel: { url: string; token: string } }> {
  const response = await app.inject({
    method: "POST",
    url: "/internal/v1/hosted-runtimes/claim",
    headers: { authorization: `Bearer ${dispatcherToken}` },
    payload: { runnerId: "runner-1" },
  });
  assert.equal(response.statusCode, 201);
  return response.json();
}

function connectRuntime(fixture: Fixture, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${fixture.port}/internal/v1/hosted-sessions/${fixture.sessionId}/tunnel`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function connectClient(fixture: Fixture, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${fixture.port}/v1/hosted-sessions/${fixture.sessionId}/rpc`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function waitFor<Args extends unknown[]>(socket: WebSocket, event: "open" | "message" | "close" | "unexpected-response"): Promise<Args> {
  return new Promise((resolve) => socket.once(event as never, ((...args: Args) => resolve(args)) as never));
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return waitFor<[Buffer, boolean]>(socket, "message").then(([data]) => JSON.parse(data.toString("utf8")) as Record<string, unknown>);
}

async function closeAll(...sockets: WebSocket[]): Promise<void> {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
}

test("hosted RPC tunnel routes an authenticated prompt to the runtime and its response back to the client", async () => {
  const fixture = await setup();
  const { app, sessionId, workspaceRoot } = fixture;
  const { tunnel } = await claim(app);

  const runtime = connectRuntime(fixture, tunnel.token);
  await waitFor(runtime, "open");
  runtime.send(JSON.stringify({ type: "pi_cloud_runtime_ready" }));
  await delay(20);
  const client = connectClient(fixture, ownerToken);
  await waitFor(client, "open");

  // The runner's reserved startup probe is recognized, persisted, and never forwarded to the client.
  const nativeSessionFile = `${workspaceRoot.slice(0, -"/repository".length)}/native-sessions/${sessionId}/native.jsonl`;
  runtime.send(
    JSON.stringify({
      version: 1,
      hostedSessionId: sessionId,
      direction: "pi_to_client",
      sequence: 1,
      record: {
        id: "pi-cloud-internal-startup-state",
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "native-1", sessionFile: nativeSessionFile },
      },
    }),
  );

  // A public prompt reaches the runtime as a freshly re-sequenced client_to_pi envelope.
  client.send(
    JSON.stringify({
      version: 1,
      hostedSessionId: sessionId,
      direction: "client_to_pi",
      sequence: 1,
      record: { id: "req-1", type: "prompt", message: "hello" },
    }),
  );
  const forwardedPrompt = await nextMessage(runtime);
  assert.equal(forwardedPrompt.sequence, 1);
  assert.deepEqual(forwardedPrompt.record, { id: "req-1", type: "prompt", message: "hello" });

  runtime.send(
    JSON.stringify({
      version: 1,
      hostedSessionId: sessionId,
      direction: "pi_to_client",
      sequence: 2,
      record: { type: "response", command: "prompt", id: "req-1", success: true },
    }),
  );
  const promptAck = await nextMessage(client);
  runtime.send(
    JSON.stringify({
      version: 1,
      hostedSessionId: sessionId,
      direction: "pi_to_client",
      sequence: 3,
      record: { type: "agent_settled" },
    }),
  );
  const settled = await nextMessage(client);
  assert.equal(promptAck.sequence, 1);
  assert.deepEqual(promptAck.record, { type: "response", command: "prompt", id: "req-1", success: true });
  assert.equal(settled.sequence, 2);
  assert.deepEqual(settled.record, { type: "agent_settled" });

  const persisted = (
    await app.inject({ method: "GET", url: `/v1/hosted-sessions/${sessionId}`, headers: { authorization: `Bearer ${ownerToken}` } })
  ).json();
  assert.equal(persisted.nativeSessionId, "native-1");
  assert.equal(persisted.nativeSessionFile, nativeSessionFile);
  assert.equal(persisted.state, "running");

  // A client disconnect does not stop the runtime.
  client.close();
  await waitFor(client, "close");
  await delay(20);
  runtime.send(
    JSON.stringify({ version: 1, hostedSessionId: sessionId, direction: "pi_to_client", sequence: 4, record: { type: "ignored_without_client" } }),
  );
  await delay(20);
  const stillRunning = (
    await app.inject({ method: "GET", url: `/v1/hosted-sessions/${sessionId}`, headers: { authorization: `Bearer ${ownerToken}` } })
  ).json();
  assert.equal(stillRunning.state, "running");

  // Reconnect is client-driven: a fresh client resumes with its own get_entries against the same tunnel.
  const reconnected = connectClient(fixture, ownerToken);
  await waitFor(reconnected, "open");
  reconnected.send(
    JSON.stringify({
      version: 1,
      hostedSessionId: sessionId,
      direction: "client_to_pi",
      sequence: 1,
      record: { id: "req-2", type: "get_entries" },
    }),
  );
  const forwardedGetEntries = await nextMessage(runtime);
  assert.equal(forwardedGetEntries.sequence, 2); // the tunnel's own sequence continues across client reconnects
  assert.deepEqual(forwardedGetEntries.record, { id: "req-2", type: "get_entries" });

  // Stop sends a distinct out-of-band control frame, separate from any sequenced envelope.
  const stopControl = nextMessage(runtime);
  const stopped = await app.inject({
    method: "POST",
    url: `/v1/hosted-sessions/${sessionId}/stop`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(stopped.json().state, "stopped");
  assert.deepEqual(await stopControl, { type: "pi_cloud_stop" });

  // A runtime disconnect (following the stop control) marks the session stopped and drops the client.
  runtime.close();
  const [closeCode] = await waitFor<[number]>(reconnected, "close");
  assert.equal(closeCode, 4410);
  await delay(20);
  const finalState = (
    await app.inject({ method: "GET", url: `/v1/hosted-sessions/${sessionId}`, headers: { authorization: `Bearer ${ownerToken}` } })
  ).json();
  assert.equal(finalState.state, "stopped");

  await app.close();
});

test("hosted RPC endpoints isolate owners and reject invalid or unscoped tokens", async () => {
  const fixture = await setup();
  const { app, sessionId } = fixture;
  const { tunnel } = await claim(app);
  const runtime = connectRuntime(fixture, tunnel.token);
  await waitFor(runtime, "open");
  runtime.send(JSON.stringify({ type: "pi_cloud_runtime_ready" }));
  await delay(20);
  const client = connectClient(fixture, ownerToken);
  await waitFor(client, "open");

  const forbiddenGet = await app.inject({
    method: "GET",
    url: `/v1/hosted-sessions/${sessionId}`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  assert.equal(forbiddenGet.statusCode, 404);

  const rejectedClient = connectClient(fixture, otherToken);
  const [, rejectedClientResponse] = await waitFor<[unknown, { statusCode: number }]>(rejectedClient, "unexpected-response");
  assert.equal(rejectedClientResponse.statusCode, 404);

  const secondClient = connectClient(fixture, ownerToken);
  const [, secondClientResponse] = await waitFor<[unknown, { statusCode: number }]>(secondClient, "unexpected-response");
  assert.equal(secondClientResponse.statusCode, 409);

  const badTunnel = connectRuntime(fixture, "wrong-token");
  const [, badTunnelResponse] = await waitFor<[unknown, { statusCode: number }]>(badTunnel, "unexpected-response");
  assert.equal(badTunnelResponse.statusCode, 401);

  await closeAll(runtime, client);
  await app.close();
});

test("hosted RPC tunnel enforces strict sequence, byte, and session-scoping policy on the client channel", async () => {
  const fixture = await setup();
  const { app, sessionId } = fixture;
  const { tunnel } = await claim(app);
  const runtime = connectRuntime(fixture, tunnel.token);
  await waitFor(runtime, "open");
  runtime.send(JSON.stringify({ type: "pi_cloud_runtime_ready" }));
  await delay(20);

  async function expectPolicyClose(send: (socket: WebSocket) => void): Promise<number> {
    const client = connectClient(fixture, ownerToken);
    await waitFor(client, "open");
    send(client);
    const [code] = await waitFor<[number]>(client, "close");
    return code;
  }

  const gapCode = await expectPolicyClose((socket) =>
    socket.send(
      JSON.stringify({ version: 1, hostedSessionId: sessionId, direction: "client_to_pi", sequence: 2, record: { type: "get_state", id: "x" } }),
    ),
  );
  assert.equal(gapCode, 4409);

  const crossSessionCode = await expectPolicyClose((socket) =>
    socket.send(
      JSON.stringify({
        version: 1,
        hostedSessionId: "00000000-0000-0000-0000-000000000000",
        direction: "client_to_pi",
        sequence: 1,
        record: { type: "get_state", id: "x" },
      }),
    ),
  );
  assert.equal(crossSessionCode, 4404);

  const malformedCode = await expectPolicyClose((socket) => socket.send(JSON.stringify({ not: "an envelope" })));
  assert.equal(malformedCode, 4400);

  const binaryCode = await expectPolicyClose((socket) => socket.send(Buffer.from([1, 2, 3])));
  assert.equal(binaryCode, 4400);

  const oversizedCode = await expectPolicyClose((socket) =>
    socket.send(
      JSON.stringify({
        version: 1,
        hostedSessionId: sessionId,
        direction: "client_to_pi",
        sequence: 1,
        record: { type: "prompt", message: "x".repeat(3_000) },
      }),
    ),
  );
  assert.equal(oversizedCode, 1009);

  await closeAll(runtime);
  await app.close();
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

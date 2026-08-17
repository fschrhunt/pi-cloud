import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTaskLease } from "@pi-cloud/contracts";
import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const userToken = "test-user-token-that-is-at-least-32-characters";
const otherToken = "other-user-token-that-is-at-least-32-characters";
const dispatcherToken = "development-dispatcher-token-32-characters";
const revision = "0123456789abcdef0123456789abcdef01234567";
const authorization = { authorization: `Bearer ${userToken}` };

function config(databasePath = ":memory:"): ApiConfig {
  return {
    dispatcherToken,
    taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    taskLeaseIssuer: "pi-cloud-test",
    databasePath,
    apiCredentials: [
      { token: userToken, subjectId: "user-1", type: "user", displayName: "Test User" },
      { token: otherToken, subjectId: "user-2", type: "user", displayName: "Other User" },
    ],
    publicBaseUrl: "http://127.0.0.1:0",
    runtimeWorkspaceRoot: "/srv/pi-cloud/workspaces",
    runtimeAgentDirectory: "/srv/pi-cloud/agent",
    hostedLaunchLimits: {
      wallTimeSeconds: 3_600,
      idleTimeSeconds: 300,
      terminationGraceSeconds: 5,
      maxRecordBytes: 65_536,
      maxCumulativeBytes: 10_000_000,
    },
    hostedCredentialReferences: [],
    hostedCredentialValues: {},
  };
}

async function createAgent(app: Awaited<ReturnType<typeof buildApp>>, key = "agent-request-0001", budgets?: object) {
  return app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: { ...authorization, "idempotency-key": key },
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision,
      prompt: "Explain the failure and propose a patch.",
      ...(budgets ? { budgets } : {}),
    },
  });
}

async function claim(app: Awaited<ReturnType<typeof buildApp>>, runnerId = "runner-1") {
  return app.inject({
    method: "POST",
    url: "/internal/v1/runs/claim",
    headers: { authorization: `Bearer ${dispatcherToken}` },
    payload: { audience: "runner-pool/local", runnerId },
  });
}

async function redeem(app: Awaited<ReturnType<typeof buildApp>>, lease: string, runnerId = "runner-1") {
  return app.inject({
    method: "POST",
    url: "/internal/v1/leases/redeem",
    headers: { authorization: `Bearer ${lease}` },
    payload: { runnerId },
  });
}

async function reportCheckoutProvenance(app: Awaited<ReturnType<typeof buildApp>>, runId: string, lease: string) {
  return app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/checkout-provenance`,
    headers: { authorization: `Bearer ${lease}` },
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision,
      resolvedCommit: revision,
      transport: "https",
      credentialSource: "anonymous",
      credentialScrubbed: true,
      submodulesInitialized: false,
      hooksDisabled: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  });
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

test("agent API authenticates, authorizes, paginates, and makes creates idempotent", async () => {
  const app = await buildApp(config());
  const unauthorized = await app.inject({ method: "GET", url: "/v1/agents" });
  const created = await createAgent(app);
  const retried = await createAgent(app);
  const agent = created.json().agent;
  const run = created.json().run;
  const forbidden = await app.inject({
    method: "GET",
    url: `/v1/agents/${agent.id}`,
    headers: { authorization: `Bearer ${otherToken}` },
  });
  const list = await app.inject({ method: "GET", url: "/v1/agents?limit=1", headers: authorization });
  const runs = await app.inject({ method: "GET", url: "/v1/runs?limit=1", headers: authorization });

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(created.statusCode, 201);
  assert.equal(retried.json().agent.id, agent.id);
  assert.equal(run.status, "queued");
  assert.equal(agent.creator.id, "user-1");
  assert.equal(forbidden.statusCode, 404);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.json().items[0].id, run.id);

  const busyFollowUp = await app.inject({
    method: "POST",
    url: `/v1/agents/${agent.id}/runs`,
    headers: { ...authorization, "idempotency-key": "follow-up-0001" },
    payload: { prompt: "Continue." },
  });
  assert.equal(busyFollowUp.statusCode, 409);
  assert.equal(busyFollowUp.json().code, "agent_busy");

  await app.close();
});

test("list endpoints reject invalid pagination cursors for classic and hosted resources", async () => {
  const app = await buildApp(config());
  await createAgent(app, "cursor-agent-0001");
  await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...authorization, "idempotency-key": "cursor-workspace-0001" },
    payload: { repositoryUrl: "https://github.com/pi-cloud/example", revision },
  });
  const invalidCursor = encodeCursor({ createdAt: "", id: "00000000-0000-0000-0000-000000000000", extra: true });
  const invalidTimestampCursor = encodeCursor({
    createdAt: "not-a-timestamp",
    id: "00000000-0000-0000-0000-000000000000",
  });

  const agents = await app.inject({ method: "GET", url: `/v1/agents?cursor=${invalidCursor}`, headers: authorization });
  const workspaces = await app.inject({ method: "GET", url: `/v1/workspaces?cursor=${invalidCursor}`, headers: authorization });
  const malformedTimestamp = await app.inject({
    method: "GET",
    url: `/v1/agents?cursor=${invalidTimestampCursor}`,
    headers: authorization,
  });

  assert.equal(agents.statusCode, 409);
  assert.equal(agents.json().code, "invalid_cursor");
  assert.equal(workspaces.statusCode, 409);
  assert.equal(workspaces.json().code, "invalid_cursor");
  assert.equal(malformedTimestamp.statusCode, 409);
  assert.equal(malformedTimestamp.json().code, "invalid_cursor");
  await app.close();
});

test("agent creation rejects abbreviated revisions", async () => {
  const app = await buildApp(config());
  const response = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: { ...authorization, "idempotency-key": "invalid-revision-0001" },
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "4f3c2d1",
      prompt: "Explain the failure and propose a patch.",
    },
  });

  assert.equal(response.statusCode, 400);
  await app.close();
});

test("durable agents, runs, tasks, and transitions survive an API restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-cloud-api-"));
  const databasePath = join(directory, "control-plane.sqlite");
  try {
    const first = await buildApp(config(databasePath));
    const created = await createAgent(first);
    const { agent, run } = created.json();
    await first.close();

    const restarted = await buildApp(config(databasePath));
    const response = await restarted.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: authorization });
    const detail = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(detail.agentId, agent.id);
    assert.match(detail.taskId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      detail.transitions.map((transition: { entityType: string; toState: string }) => `${transition.entityType}:${transition.toState}`),
      ["run:queued", "task:queued"],
    );
    await restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redeemed leases and event cursors survive an API restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-cloud-events-"));
  const databasePath = join(directory, "control-plane.sqlite");
  try {
    const first = await buildApp(config(databasePath));
    const created = await createAgent(first, "restart-events-0001");
    const runId = created.json().run.id;
    const lease = (await claim(first)).json().lease;
    await redeem(first, lease);
    const event = {
      runnerEventId: "e82b101a-254c-442d-800f-b4f197f85320",
      runnerSequence: 1,
      kind: "run.progress",
      payload: { message: "Persisted before restart." },
    };
    const ingested = await first.inject({
      method: "POST",
      url: `/internal/v1/runs/${runId}/events`,
      headers: { authorization: `Bearer ${lease}` },
      payload: event,
    });
    await first.close();

    const restarted = await buildApp(config(databasePath));
    const retried = await restarted.inject({
      method: "POST",
      url: `/internal/v1/runs/${runId}/events`,
      headers: { authorization: `Bearer ${lease}` },
      payload: event,
    });
    const replay = await restarted.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events?follow=false`,
      headers: authorization,
    });
    assert.equal(retried.json().cursor, ingested.json().cursor);
    assert.match(replay.body, /Persisted before restart/);
    await restarted.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatch atomically assigns one runner and redeems a signed lease once", async () => {
  const app = await buildApp(config());
  const created = await createAgent(app);
  const taskId = created.json().run.taskId;
  const [first, second] = await Promise.all([claim(app, "runner-1"), claim(app, "runner-2")]);
  const winner = first.statusCode === 201 ? first : second;
  const loser = first.statusCode === 204 ? first : second;
  const winnerId = first.statusCode === 201 ? "runner-1" : "runner-2";
  const lease = winner.json().lease;
  const claims = verifyTaskLease(lease, {
    publicKey,
    issuer: "pi-cloud-test",
    audience: "runner-pool/local",
  });

  assert.equal(winner.statusCode, 201);
  assert.equal(loser.statusCode, 204);
  assert.equal(claims.taskId, taskId);

  const wrongRunner = await redeem(app, lease, "wrong-runner");
  const redeemed = await redeem(app, lease, winnerId);
  const replay = await redeem(app, lease, winnerId);
  assert.equal(wrongRunner.statusCode, 409);
  assert.equal(redeemed.statusCode, 200);
  assert.equal(redeemed.json().taskId, taskId);
  assert.equal(replay.statusCode, 409);
  assert.equal("lease" in redeemed.json(), false);

  await app.close();
});

test("checkout provenance is recorded through the runner endpoint and returned in run detail", async () => {
  const app = await buildApp(config());
  const created = await createAgent(app, "checkout-provenance-0001");
  const runId = created.json().run.id;
  const lease = (await claim(app)).json().lease;
  await redeem(app, lease);

  const first = await reportCheckoutProvenance(app, runId, lease);
  const retry = await reportCheckoutProvenance(app, runId, lease);
  const detail = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: authorization });

  assert.equal(first.statusCode, 201);
  assert.deepEqual(retry.json(), first.json());
  assert.deepEqual(detail.json().checkoutProvenance, first.json());

  const mismatched = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/checkout-provenance`,
    headers: { authorization: `Bearer ${lease}` },
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/another",
      revision,
      resolvedCommit: revision,
      transport: "https",
      credentialSource: "anonymous",
      credentialScrubbed: true,
      submodulesInitialized: false,
      hooksDisabled: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  });
  assert.equal(mismatched.statusCode, 409);
  assert.equal(mismatched.json().code, "checkout_provenance_mismatch");

  await app.close();
});

test("runner events are bounded, ordered, idempotent, and reconnect through opaque SSE cursors", async () => {
  const app = await buildApp(config());
  const created = await createAgent(app);
  const runId = created.json().run.id;
  const lease = (await claim(app)).json().lease;
  await redeem(app, lease);
  const runnerEventId = "c4c7b937-98e7-4e47-8f62-79b7ac4f44c9";
  const event = {
    runnerEventId,
    runnerSequence: 1,
    kind: "run.progress",
    payload: { message: "Preparing the workspace." },
  };
  const first = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: event,
  });
  const retry = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: event,
  });
  const gap = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: { ...event, runnerEventId: "3b3b855f-e7e4-4ca8-adc0-f016ccb11f93", runnerSequence: 3 },
  });
  const unrestricted = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: { ...event, runnerEventId: "c86a4af2-d54b-47c6-ac3c-3ad5ec91c885", runnerSequence: 2, payload: { message: "ok", rawOutput: "secret" } },
  });
  const stream = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/events?follow=false`,
    headers: authorization,
  });
  const resumed = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/events?follow=false&cursor=${first.json().cursor}`,
    headers: authorization,
  });

  assert.equal(first.statusCode, 201);
  assert.equal(retry.json().cursor, first.json().cursor);
  assert.equal(gap.statusCode, 409);
  assert.equal(unrestricted.statusCode, 400);
  assert.match(stream.headers["content-type"] ?? "", /text\/event-stream/);
  assert.match(stream.body, new RegExp(`id: ${first.json().cursor}`));
  assert.equal(resumed.body, "");

  const result = {
    runnerEventId: "a91634f1-c325-4934-bf07-898b6a4250ce",
    runnerSequence: 2,
    kind: "run.result",
    payload: { outcome: "succeeded", summary: "Done." },
  };
  const terminal = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: result,
  });
  const terminalRetry = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${lease}` },
    payload: result,
  });
  assert.equal(terminal.statusCode, 201);
  assert.equal(terminalRetry.json().cursor, terminal.json().cursor);

  await app.close();
});

test("SSE replay drains more than one bounded database batch", async () => {
  const app = await buildApp(config());
  const created = await createAgent(app, "batched-events-0001");
  const runId = created.json().run.id;
  const lease = (await claim(app)).json().lease;
  await redeem(app, lease);

  for (let runnerSequence = 1; runnerSequence <= 101; runnerSequence += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/runs/${runId}/events`,
      headers: { authorization: `Bearer ${lease}` },
      payload: {
        runnerEventId: randomUUID(),
        runnerSequence,
        kind: "run.progress",
        payload: { message: `Progress ${runnerSequence}.` },
      },
    });
    assert.equal(response.statusCode, 201);
  }

  const replay = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}/events?follow=false`,
    headers: authorization,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.match(/event: run\.progress/g)?.length, 101);
  assert.match(replay.body, /Progress 101\./);

  await app.close();
});

test("heartbeats expose cancellation and enforce monotonic run budgets", async () => {
  const app = await buildApp(config());
  const created = await createAgent(app, "budget-agent-0001", {
    wallTimeSeconds: 3600,
    idleTimeSeconds: 120,
    cpuSeconds: 1,
    memoryMb: 128,
    artifactBytes: 100,
    eventCount: 10,
    eventBytes: 1024,
    maxRetries: 1,
  });
  const runId = created.json().run.id;
  const lease = (await claim(app)).json().lease;
  const claims = verifyTaskLease(lease, { publicKey, issuer: "pi-cloud-test", audience: "runner-pool/local" });
  await redeem(app, lease);

  const heartbeat = await app.inject({
    method: "POST",
    url: `/internal/v1/leases/${claims.leaseId}/heartbeat`,
    headers: { authorization: `Bearer ${lease}` },
    payload: { consumed: { cpuSeconds: 2, memoryPeakMb: 64, artifactBytes: 0 } },
  });
  const regression = await app.inject({
    method: "POST",
    url: `/internal/v1/leases/${claims.leaseId}/heartbeat`,
    headers: { authorization: `Bearer ${lease}` },
    payload: { consumed: { cpuSeconds: 1, memoryPeakMb: 64, artifactBytes: 0 } },
  });
  const cancel = await app.inject({ method: "POST", url: `/v1/runs/${runId}/cancel`, headers: authorization });
  const cancelRetry = await app.inject({ method: "POST", url: `/v1/runs/${runId}/cancel`, headers: authorization });
  const run = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: authorization });

  assert.equal(heartbeat.statusCode, 200);
  assert.equal(heartbeat.json().cancelRequested, true);
  assert.equal(heartbeat.json().run.status, "canceling");
  assert.equal(regression.statusCode, 409);
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancelRetry.statusCode, 200);
  assert.equal(run.json().terminalReason, "budget_exceeded:cpu_seconds");

  await app.close();
});

test("recovery requeues a lost runner with backoff and resolves cancellation races", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const app = await buildApp(config(), () => now);
  const created = await createAgent(app, "recovery-agent-0001", {
    wallTimeSeconds: 3600,
    idleTimeSeconds: 15,
    cpuSeconds: 100,
    memoryMb: 128,
    artifactBytes: 100,
    eventCount: 10,
    eventBytes: 1024,
    maxRetries: 1,
  });
  const runId = created.json().run.id;
  const firstLease = (await claim(app)).json().lease;
  const firstClaims = verifyTaskLease(firstLease, { publicKey, issuer: "pi-cloud-test", audience: "runner-pool/local", now });
  await redeem(app, firstLease);
  const firstAttemptEvent = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${firstLease}` },
    payload: {
      runnerEventId: "01ba80cf-7229-4474-ac9f-5cd3ba14d3b1",
      runnerSequence: 1,
      kind: "run.progress",
      payload: { message: "First attempt." },
    },
  });
  assert.equal(firstAttemptEvent.statusCode, 201);

  now = new Date(now.getTime() + 16_000);
  const recovered = await app.inject({
    method: "POST",
    url: "/internal/v1/recovery",
    headers: { authorization: `Bearer ${dispatcherToken}` },
  });
  const oldHeartbeat = await app.inject({
    method: "POST",
    url: `/internal/v1/leases/${firstClaims.leaseId}/heartbeat`,
    headers: { authorization: `Bearer ${firstLease}` },
    payload: { consumed: {} },
  });
  assert.equal(recovered.json().requeued, 1);
  assert.equal(oldHeartbeat.statusCode, 403);

  now = new Date(now.getTime() + 5_000);
  const secondLease = (await claim(app, "runner-2")).json().lease;
  await redeem(app, secondLease, "runner-2");
  const reusedEventId = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${secondLease}` },
    payload: {
      runnerEventId: "01ba80cf-7229-4474-ac9f-5cd3ba14d3b1",
      runnerSequence: 1,
      kind: "run.progress",
      payload: { message: "Conflicting replacement event." },
    },
  });
  assert.equal(reusedEventId.statusCode, 409);
  assert.equal(reusedEventId.json().code, "event_id_conflict");
  const replacementEvent = await app.inject({
    method: "POST",
    url: `/internal/v1/runs/${runId}/events`,
    headers: { authorization: `Bearer ${secondLease}` },
    payload: {
      runnerEventId: "1ba8ac44-db44-4fc4-a7cc-5245795dd8e9",
      runnerSequence: 1,
      kind: "run.progress",
      payload: { message: "Replacement attempt." },
    },
  });
  assert.equal(replacementEvent.statusCode, 201);
  assert.equal(replacementEvent.json().sequence, 2);
  const canceled = await app.inject({ method: "POST", url: `/v1/runs/${runId}/cancel`, headers: authorization });
  now = new Date(now.getTime() + 16_000);
  await app.inject({
    method: "POST",
    url: "/internal/v1/recovery",
    headers: { authorization: `Bearer ${dispatcherToken}` },
  });
  const terminal = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: authorization });
  assert.equal(canceled.json().status, "canceling");
  assert.equal(terminal.json().status, "canceled");
  assert.equal(terminal.json().retryCount, 1);
  assert.equal(terminal.json().terminalReason, "user_canceled");

  await app.close();
});

test("wall-time accounting starts when a runner redeems its lease", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const app = await buildApp(config(), () => now);
  const created = await createAgent(app, "wall-time-agent-0001", {
    wallTimeSeconds: 30,
    idleTimeSeconds: 15,
    cpuSeconds: 100,
    memoryMb: 128,
    artifactBytes: 100,
    eventCount: 10,
    eventBytes: 1024,
    maxRetries: 1,
  });
  const runId = created.json().run.id;
  await claim(app);

  now = new Date(now.getTime() + 31_000);
  const recovered = await app.inject({
    method: "POST",
    url: "/internal/v1/recovery",
    headers: { authorization: `Bearer ${dispatcherToken}` },
  });
  const run = await app.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: authorization });

  assert.deepEqual(recovered.json(), { requeued: 0, failed: 0, canceled: 0 });
  assert.equal(run.json().status, "assigned");
  assert.equal(run.json().startedAt, null);

  await app.close();
});

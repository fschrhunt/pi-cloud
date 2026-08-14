import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneClient } from "./controlPlaneClient.js";

const revision = "0123456789abcdef0123456789abcdef01234567";

test("control-plane client redeems leases and reports checkout provenance with bearer auth", async () => {
  const requests: Array<{ url: string; headers: Headers; body: string | null }> = [];
  const client = new ControlPlaneClient(new URL("http://127.0.0.1:3000"), "signed-lease-token", async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.text() });
    if (request.url.endsWith("/internal/v1/leases/redeem")) {
      return Response.json({
        taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
        runId: "3b8498eb-9852-4902-82ca-0d488254d979",
        budgets: {
          wallTimeSeconds: 3600,
          idleTimeSeconds: 120,
          cpuSeconds: 3600,
          memoryMb: 4096,
          artifactBytes: 50_000_000,
          eventCount: 10_000,
          eventBytes: 10_000_000,
          eventPayloadBytes: 16_384,
          maxRetries: 2,
        },
        cancelRequested: false,
      });
    }
    return Response.json({
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
    });
  });

  const redeemed = await client.redeemLease("runner-local-1");
  const provenance = await client.reportCheckoutProvenance(redeemed.runId, {
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
  });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3000/internal/v1/leases/redeem");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer signed-lease-token");
  assert.match(requests[0]?.body ?? "", /runner-local-1/);
  assert.equal(requests[1]?.url, `http://127.0.0.1:3000/internal/v1/runs/${redeemed.runId}/checkout-provenance`);
  assert.equal(provenance.resolvedCommit, revision);
});

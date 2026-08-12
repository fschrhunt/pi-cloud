import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { issueTaskLease, type CheckoutProvenance } from "@pi-cloud/contracts";
import { runRunner } from "./runner.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const revision = "0123456789abcdef0123456789abcdef01234567";
const publicKeyValue = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-cloud-runner-"));

function createEnv() {
  return {
    PI_CLOUD_CONTROL_PLANE_URL: "http://127.0.0.1:3000",
    PI_CLOUD_TASK_LEASE: issueTaskLease({
      privateKey,
      taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision,
      issuer: "pi-cloud-control-plane",
      audience: "runner-pool/local",
      ttlSeconds: 60,
      now: new Date(),
    }),
    PI_CLOUD_TASK_LEASE_PUBLIC_KEY: publicKeyValue,
    PI_CLOUD_RUNNER_AUDIENCE: "runner-pool/local",
    PI_CLOUD_RUNNER_ID: "runner-local-1",
    PI_CLOUD_WORKSPACE_ROOT: workspaceRoot,
  };
}

test("runner redeems before checkout, reports provenance, and always cleans up its workspace", async () => {
  const operations: string[] = [];
  const provenance: CheckoutProvenance = {
    repositoryUrl: "https://github.com/pi-cloud/example",
    revision,
    resolvedCommit: revision,
    transport: "https",
    credentialSource: "anonymous",
    credentialScrubbed: true,
    submodulesInitialized: false,
    hooksDisabled: true,
    startedAt: "2026-08-12T09:00:00.000Z",
    completedAt: "2026-08-12T09:00:01.000Z",
  };

  await runRunner(createEnv(), {
    createWorkspace: async () => {
      operations.push("createWorkspace");
      return "/tmp/pi-cloud-workspace/task-1";
    },
    createControlPlaneClient: () => ({
      redeemLease: async (runnerId: string) => {
        operations.push(`redeem:${runnerId}`);
        return {
          taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
          runId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
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
        };
      },
      reportCheckoutProvenance: async (runId: string, reported: CheckoutProvenance) => {
        operations.push(`report:${runId}:${reported.resolvedCommit}`);
        return reported;
      },
    }),
    checkoutExactRevision: async ({ checkoutPath }) => {
      operations.push(`checkout:${checkoutPath}`);
      return provenance;
    },
    removeWorkspace: async (path: string) => {
      operations.push(`remove:${path}`);
    },
    log: (message: string) => {
      operations.push(`log:${message}`);
    },
  });

  assert.deepEqual(operations.slice(0, 4), [
    "redeem:runner-local-1",
    "createWorkspace",
    "checkout:/tmp/pi-cloud-workspace/task-1/repository",
    `report:66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9:${revision}`,
  ]);
  assert.match(operations.at(-2) ?? "", /^log:Runner runner-local-1 checked out/);
  assert.equal(operations.at(-1), "remove:/tmp/pi-cloud-workspace/task-1");
});

test("runner still removes its workspace when checkout fails", async () => {
  const operations: string[] = [];

  await assert.rejects(
    runRunner(createEnv(), {
      createWorkspace: async () => "/tmp/pi-cloud-workspace/task-2",
      createControlPlaneClient: () => ({
        redeemLease: async () => ({
          taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
          runId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
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
        }),
        reportCheckoutProvenance: async () => {
          operations.push("report");
          throw new Error("should not be called");
        },
      }),
      checkoutExactRevision: async () => {
        throw new Error("checkout failed");
      },
      removeWorkspace: async (path: string) => {
        operations.push(`remove:${path}`);
      },
      log: () => undefined,
    }),
    /checkout failed/,
  );

  assert.deepEqual(operations, ["remove:/tmp/pi-cloud-workspace/task-2"]);
});

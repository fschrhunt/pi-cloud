import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { issueTaskLease } from "@pi-cloud/contracts";
import { parseControlPlaneUrl, readRunnerConfig, readTaskLease } from "./config.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const now = new Date("2026-08-12T09:00:00Z");
const revision = "0123456789abcdef0123456789abcdef01234567";
const publicKeyValue = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function createLease() {
  return issueTaskLease({
    privateKey,
    taskId: "a0d701e3-bae6-427a-bc22-35d885915da3",
    repositoryUrl: "https://github.com/pi-cloud/example",
    revision,
    issuer: "pi-cloud-control-plane",
    audience: "runner-pool/local",
    ttlSeconds: 60,
    now,
  });
}

function createConfig(taskLease = createLease()) {
  return readRunnerConfig({
    PI_CLOUD_CONTROL_PLANE_URL: "https://control.pi-cloud.test",
    PI_CLOUD_TASK_LEASE: taskLease,
    PI_CLOUD_TASK_LEASE_PUBLIC_KEY: publicKeyValue,
    PI_CLOUD_RUNNER_AUDIENCE: "runner-pool/local",
    PI_CLOUD_RUNNER_ID: "runner-local-1",
  });
}

test("runner verifies its signed single-task authority", () => {
  const claims = readTaskLease(createConfig(), now);

  assert.equal(claims.taskId, "a0d701e3-bae6-427a-bc22-35d885915da3");
  assert.equal(claims.repositoryUrl, "https://github.com/pi-cloud/example");
  assert.equal(claims.revision, revision);
});

test("runner refuses missing, tampered, and expired task leases", () => {
  assert.throws(() =>
    readRunnerConfig({
      PI_CLOUD_CONTROL_PLANE_URL: "https://control.pi-cloud.test",
      PI_CLOUD_TASK_LEASE_PUBLIC_KEY: publicKeyValue,
      PI_CLOUD_RUNNER_AUDIENCE: "runner-pool/local",
      PI_CLOUD_RUNNER_ID: "runner-local-1",
    }),
  );

  const token = createLease();
  const [payload, signature] = token.split(".");
  assert.throws(() => readTaskLease(createConfig(`${payload}x.${signature}`), now), /signature/);
  assert.throws(() => readTaskLease(createConfig(), new Date("2026-08-12T09:01:01Z")), /expired/);
});

test("runner accepts HTTPS everywhere and loopback HTTP only for the control plane", () => {
  assert.equal(parseControlPlaneUrl("https://control.pi-cloud.test").protocol, "https:");
  assert.equal(parseControlPlaneUrl("http://127.0.0.1:3000").origin, "http://127.0.0.1:3000");
  assert.equal(parseControlPlaneUrl("http://localhost:3000").origin, "http://localhost:3000");
  assert.equal(parseControlPlaneUrl("http://[::1]:3000").origin, "http://[::1]:3000");
  assert.throws(() => parseControlPlaneUrl("http://example.com:3000"), /loopback HTTP/);
});

test("runner refuses a lease issued for another pool", () => {
  const config = { ...createConfig(), runnerAudience: "runner-pool/hosted" };
  assert.throws(() => readTaskLease(config, now), /audience/);
});

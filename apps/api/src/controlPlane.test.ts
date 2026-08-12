import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { verifyTaskLease } from "@pi-cloud/contracts";
import { ControlPlane } from "./controlPlane.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const controlPlane = new ControlPlane({
  dispatcherToken: "development-dispatcher-token-32-characters",
  taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  taskLeaseIssuer: "pi-cloud-test",
});

test("control plane signs runner authority only for an existing queued task", () => {
  const task = controlPlane.createTask({
    repositoryUrl: "https://github.com/pi-cloud/example",
    revision: "4f3c2d1",
    prompt: "Inspect this repository.",
  });
  const lease = controlPlane.issueTaskLease(task.id, "runner-pool/local");

  assert.ok(lease);
  const claims = verifyTaskLease(lease, {
    publicKey,
    issuer: "pi-cloud-test",
    audience: "runner-pool/local",
  });
  assert.equal(claims.taskId, task.id);
  assert.equal(claims.repositoryUrl, task.repositoryUrl);
  assert.equal(claims.revision, task.revision);
  assert.equal(
    controlPlane.issueTaskLease("a0d701e3-bae6-427a-bc22-35d885915da3", "runner-pool/local"),
    undefined,
  );
});

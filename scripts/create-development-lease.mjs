import { createPrivateKey } from "node:crypto";
import { issueTaskLease } from "../contracts/dist/index.js";

const [taskId, repositoryUrl, revision] = process.argv.slice(2);
if (!taskId || !repositoryUrl || !revision) {
  console.error("Usage: node scripts/create-development-lease.mjs <task-id> <https-repository-url> <revision>");
  process.exitCode = 1;
} else {
  const encodedPrivateKey = process.env.PI_CLOUD_TASK_LEASE_PRIVATE_KEY;
  if (!encodedPrivateKey) {
    throw new Error("PI_CLOUD_TASK_LEASE_PRIVATE_KEY is required");
  }

  const privateKey = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const lease = issueTaskLease({
    taskId,
    repositoryUrl,
    revision,
    issuer: process.env.PI_CLOUD_TASK_LEASE_ISSUER ?? "pi-cloud-control-plane",
    audience: process.env.PI_CLOUD_RUNNER_AUDIENCE ?? "runner-pool/local",
    privateKey,
    ttlSeconds: 300,
  });

  process.stdout.write(`${lease}\n`);
}

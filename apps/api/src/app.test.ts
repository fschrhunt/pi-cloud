import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { verifyTaskLease } from "@pi-cloud/contracts";
import { buildApp } from "./app.js";
import type { ApiConfig } from "./config.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const config: ApiConfig = {
  dispatcherToken: "development-dispatcher-token-32-characters",
  taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  taskLeaseIssuer: "pi-cloud-test",
};

async function createTask(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "4f3c2d1",
      prompt: "Explain the test failure and propose a patch.",
    },
  });
}

test("health endpoint identifies a ready control plane", async () => {
  const app = await buildApp(config);
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: "pi-cloud-api" });

  await app.close();
});

test("task endpoint accepts an immutable repository task", async () => {
  const app = await buildApp(config);
  const response = await createTask(app);

  assert.equal(response.statusCode, 201);
  assert.match(response.json().id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(response.json().status, "queued");

  await app.close();
});

test("task endpoint rejects a repository URL without HTTPS", async () => {
  const app = await buildApp(config);
  const response = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      repositoryUrl: "http://github.com/pi-cloud/example",
      revision: "4f3c2d1",
      prompt: "Inspect this repository.",
    },
  });

  assert.equal(response.statusCode, 400);
  await app.close();
});

test("dispatcher issues a lease for an existing task", async () => {
  const app = await buildApp(config);
  const task = (await createTask(app)).json();
  const response = await app.inject({
    method: "POST",
    url: `/internal/v1/tasks/${task.id}/lease`,
    headers: { authorization: `Bearer ${config.dispatcherToken}` },
    payload: { audience: "runner-pool/local" },
  });

  assert.equal(response.statusCode, 201);
  const claims = verifyTaskLease(response.json().lease, {
    publicKey,
    issuer: config.taskLeaseIssuer,
    audience: "runner-pool/local",
  });
  assert.equal(claims.taskId, task.id);
  assert.equal(claims.repositoryUrl, task.repositoryUrl);
  assert.equal(claims.revision, task.revision);

  await app.close();
});

test("dispatcher lease endpoint fails closed", async () => {
  const app = await buildApp(config);
  const task = (await createTask(app)).json();
  const unauthorized = await app.inject({
    method: "POST",
    url: `/internal/v1/tasks/${task.id}/lease`,
    payload: { audience: "runner-pool/local" },
  });
  const unknownTask = await app.inject({
    method: "POST",
    url: "/internal/v1/tasks/a0d701e3-bae6-427a-bc22-35d885915da3/lease",
    headers: { authorization: `Bearer ${config.dispatcherToken}` },
    payload: { audience: "runner-pool/local" },
  });
  const invalidAudience = await app.inject({
    method: "POST",
    url: `/internal/v1/tasks/${task.id}/lease`,
    headers: { authorization: `Bearer ${config.dispatcherToken}` },
    payload: { audience: "" },
  });

  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unknownTask.statusCode, 404);
  assert.equal(invalidAudience.statusCode, 400);

  await app.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("health endpoint identifies a ready control plane", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", service: "pi-cloud-api" });

  await app.close();
});

test("task endpoint accepts an immutable repository task", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    payload: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "4f3c2d1",
      prompt: "Explain the test failure and propose a patch.",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.match(response.json().id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(response.json().status, "queued");

  await app.close();
});

test("task endpoint rejects a repository URL without HTTPS", async () => {
  const app = await buildApp();
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

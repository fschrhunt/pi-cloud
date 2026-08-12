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

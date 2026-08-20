import assert from "node:assert/strict";
import test from "node:test";
import type { CloudClientConfig } from "@pi-cloud/contracts";
import { apiUrl, CloudApiClient } from "./api.js";

const config: CloudClientConfig = {
  version: 1,
  serverUrl: "https://pi.example.test/base",
  token: "t".repeat(32),
};
const workspaceId = "00000000-0000-4000-8000-000000000001";
const revision = "0123456789abcdef0123456789abcdef01234567";

test("API URLs preserve a configured reverse-proxy base path", () => {
  assert.equal(
    apiUrl(config.serverUrl, "/v1/workspaces").toString(),
    "https://pi.example.test/base/v1/workspaces",
  );
});

test("workspace listing forwards the pagination cursor", async () => {
  const requests: Request[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ items: [], nextCursor: null });
  };
  const client = new CloudApiClient(config, fetchImplementation);

  await client.listWorkspaces("cursor-value");

  assert.equal(
    requests[0]?.url,
    "https://pi.example.test/base/v1/workspaces?limit=100&cursor=cursor-value",
  );
  assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${config.token}`);
});

test("capability preflight is unauthenticated while lifecycle requests use the bearer token", async () => {
  const requests: Request[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith("/v1/capabilities")) {
      return Response.json({
        service: "pi-cloud-api",
        protocolVersion: 1,
        hostedRpcVersion: 1,
        features: { hostedSessions: true, reconnect: true, nativeSessionResume: true },
      });
    }
    return Response.json({
      id: workspaceId,
      repositoryUrl: "https://github.com/owner/project.git",
      revision,
      projectTrust: "untrusted",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      root: "/server/path-must-not-enter-client-state",
    }, { status: 201 });
  };
  const client = new CloudApiClient(config, fetchImplementation);

  await client.capabilities();
  const workspace = await client.createWorkspace({
    repositoryUrl: "https://github.com/owner/project.git",
    revision,
    idempotencyKey: "workspace-request-0001",
  });

  assert.equal(requests[0]?.headers.has("authorization"), false);
  assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${config.token}`);
  assert.equal(requests[1]?.headers.get("idempotency-key"), "workspace-request-0001");
  assert.equal("root" in workspace, false);
});

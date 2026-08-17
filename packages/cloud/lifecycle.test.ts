import assert from "node:assert/strict";
import test from "node:test";
import type { CloudHostedSession, CloudWorkspace } from "@pi-cloud/contracts";
import { resolveCloudSession, waitForCloudSessionRunning } from "./lifecycle.js";

const repository = {
  root: "/repo",
  repositoryUrl: "https://github.com/owner/project.git",
  revision: "0123456789abcdef0123456789abcdef01234567",
};
const workspace: CloudWorkspace = {
  id: "00000000-0000-4000-8000-000000000001",
  repositoryUrl: repository.repositoryUrl,
  revision: repository.revision,
  projectTrust: "untrusted",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const stoppedSession: CloudHostedSession = {
  id: "00000000-0000-4000-8000-000000000002",
  workspaceId: workspace.id,
  state: "stopped",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  startedAt: "2026-01-01T00:00:10.000Z",
  stoppedAt: "2026-01-01T00:01:00.000Z",
  archivedAt: null,
};

test("continue resumes the repository's durable cloud workspace even after local HEAD advances", async () => {
  const started: string[] = [];
  const continuedWorkspace = { ...workspace, revision: "a".repeat(40) };
  const result = await resolveCloudSession({
    capabilities: async () => ({
      service: "pi-cloud-api",
      protocolVersion: 1,
      hostedRpcVersion: 1,
      features: { hostedSessions: true, reconnect: true, nativeSessionResume: true },
    }),
    listWorkspaces: async () => ({ items: [continuedWorkspace], nextCursor: null }),
    createWorkspace: async () => { throw new Error("unexpected create"); },
    listHostedSessions: async () => ({ items: [stoppedSession] }),
    createHostedSession: async () => { throw new Error("unexpected create"); },
    startHostedSession: async (sessionId) => {
      started.push(sessionId);
      return { ...stoppedSession, state: "queued" };
    },
  }, repository, "continue");

  assert.deepEqual(started, [stoppedSession.id]);
  assert.equal(result.workspace.id, continuedWorkspace.id);
  assert.equal(result.session.state, "queued");
});

test("running wait accepts the authoritative state and rejects an early stop", async () => {
  const running = { ...stoppedSession, state: "running" as const, stoppedAt: null };
  assert.equal(
    (await waitForCloudSessionRunning({ getHostedSession: async () => running }, running.id, { timeoutMs: 5 })).state,
    "running",
  );
  await assert.rejects(
    waitForCloudSessionRunning({ getHostedSession: async () => stoppedSession }, stoppedSession.id, { timeoutMs: 5 }),
    /entered stopped/,
  );
});

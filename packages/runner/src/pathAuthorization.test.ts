import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostedRuntimeLaunch } from "@pi-cloud/contracts";
import { authorizeHostedRuntimePaths, authorizeHostedRuntimeRealPaths } from "./pathAuthorization.js";

const launch: HostedRuntimeLaunch = {
  version: 1,
  hostedSessionId: "a0d701e3-bae6-427a-bc22-35d885915da3",
  workspaceId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
  workspaceRoot: "/srv/workspaces/one",
  repository: {
    repositoryUrl: "https://github.com/pi-cloud/example",
    revision: "0123456789abcdef0123456789abcdef01234567",
  },
  nativeSession: { kind: "new", sessionDirectory: "/srv/sessions/one" },
  piAgentDirectory: "/srv/agent/default",
  credentialReferences: [],
  limits: {
    wallTimeSeconds: 60,
    idleTimeSeconds: 30,
    terminationGraceSeconds: 1,
    maxRecordBytes: 1_000,
    maxCumulativeBytes: 10_000,
  },
  projectTrust: "trusted",
};

const roots = { workspaceRoots: ["/srv/workspaces"], sessionRoots: ["/srv/sessions"], agentRoots: ["/srv/agent"] };

test("path authorization permits descendants and rejects lexical prefix and traversal escapes", () => {
  authorizeHostedRuntimePaths(launch, roots);
  assert.throws(() => authorizeHostedRuntimePaths({ ...launch, workspaceRoot: "/srv/workspaces-other/one" }, roots), /escapes/);
  assert.throws(() => authorizeHostedRuntimePaths({ ...launch, workspaceRoot: "/srv/workspaces/../outside" }, roots), /escapes/);
});

test("runtime home cannot link into another persistent session", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-cloud-home-auth-"));
  const workspaces = join(root, "workspaces");
  const sessions = join(root, "sessions");
  const agents = join(root, "agents");
  const sessionOne = join(sessions, "one");
  const sessionTwo = join(sessions, "two");
  await Promise.all([workspaces, sessions, agents].map((path) => fs.mkdir(path)));
  await Promise.all([
    fs.mkdir(join(workspaces, "one")),
    fs.mkdir(sessionOne),
    fs.mkdir(sessionTwo),
    fs.mkdir(join(agents, "default")),
  ]);
  await fs.symlink(sessionTwo, join(sessionOne, "runtime-home"));
  const linkedLaunch = {
    ...launch,
    workspaceRoot: join(workspaces, "one"),
    nativeSession: { kind: "new" as const, sessionDirectory: sessionOne },
    piAgentDirectory: join(agents, "default"),
  };
  try {
    await assert.rejects(
      authorizeHostedRuntimeRealPaths(linkedLaunch, {
        workspaceRoots: [workspaces],
        sessionRoots: [sessions],
        agentRoots: [agents],
      }),
      /escapes its session/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real path authorization rejects a symlink escape", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-cloud-path-auth-"));
  const workspaces = join(root, "workspaces");
  const sessions = join(root, "sessions");
  const agents = join(root, "agents");
  const outside = join(root, "outside");
  await Promise.all([workspaces, sessions, agents, outside].map((path) => fs.mkdir(path)));
  await fs.symlink(outside, join(workspaces, "linked"));
  const linkedLaunch = {
    ...launch,
    workspaceRoot: join(workspaces, "linked", "repository"),
    nativeSession: { kind: "new" as const, sessionDirectory: join(sessions, "one") },
    piAgentDirectory: join(agents, "default"),
  };
  try {
    await assert.rejects(
      authorizeHostedRuntimeRealPaths(linkedLaunch, {
        workspaceRoots: [workspaces],
        sessionRoots: [sessions],
        agentRoots: [agents],
      }),
      /symbolic link/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

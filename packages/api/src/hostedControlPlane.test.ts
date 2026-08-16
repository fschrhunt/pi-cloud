import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { hostedRuntimeLaunchSchema } from "@pi-cloud/contracts";
import type { ApiConfig } from "./config.js";
import type { Principal } from "./domain.js";
import { HostedControlPlane } from "./hostedControlPlane.js";
import { ControlPlaneStore } from "./store.js";

const { privateKey } = generateKeyPairSync("ed25519");
const revision = "0123456789abcdef0123456789abcdef01234567";
const principal: Principal = { id: "user-1", type: "user", displayName: "Test User" };
const otherPrincipal: Principal = { id: "user-2", type: "user", displayName: "Other User" };

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    dispatcherToken: "development-dispatcher-token-32-characters",
    taskLeasePrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    taskLeaseIssuer: "pi-cloud-test",
    databasePath: ":memory:",
    apiCredentials: [],
    publicBaseUrl: "https://pi-cloud.example.com",
    runtimeWorkspaceRoot: "/srv/pi-cloud/workspaces",
    runtimeAgentDirectory: "/srv/pi-cloud/agent",
    hostedLaunchLimits: {
      wallTimeSeconds: 3_600,
      idleTimeSeconds: 300,
      terminationGraceSeconds: 5,
      maxRecordBytes: 65_536,
      maxCumulativeBytes: 10_000_000,
    },
    hostedCredentialReferences: [
      { name: "provider", reference: "vault://provider/key", environmentVariable: "ANTHROPIC_API_KEY" },
      { name: "unused", reference: "vault://unused/key", environmentVariable: "OPENAI_API_KEY" },
    ],
    hostedCredentialValues: {
      "vault://provider/key": "scoped-provider-secret",
      "vault://unused/key": "ungranted-provider-secret",
    },
    ...overrides,
  };
}

function newControlPlane(overrides: Partial<ApiConfig> = {}, clock?: () => Date) {
  const store = new ControlPlaneStore(":memory:");
  return { controlPlane: new HostedControlPlane(config(overrides), store, clock), store };
}

test("workspace creation is owner-scoped, idempotent, and resolves configured credential references", () => {
  const { controlPlane } = newControlPlane();
  const input = { repositoryUrl: "https://github.com/pi-cloud/example", revision, credentialReferenceNames: ["provider"] };
  const created = controlPlane.createWorkspace(principal, input, "workspace-0001");
  const retried = controlPlane.createWorkspace(principal, input, "workspace-0001");

  assert.equal(retried.id, created.id);
  assert.equal(created.projectTrust, "untrusted");
  assert.equal(created.root, `/srv/pi-cloud/workspaces/${created.id}/repository`);
  assert.equal(created.agentDirectory, "/srv/pi-cloud/agent");
  assert.deepEqual(created.credentialReferences, [
    { name: "provider", reference: "vault://provider/key", environmentVariable: "ANTHROPIC_API_KEY" },
  ]);
  assert.throws(() => controlPlane.getWorkspace(otherPrincipal, created.id), /not found/);

  assert.throws(
    () => controlPlane.createWorkspace(principal, { ...input, credentialReferenceNames: ["missing"] }, "workspace-0002"),
    /Unknown credential reference/,
  );
});

test("hosted session lifecycle enforces legal transitions before archive", () => {
  const { controlPlane } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-lifecycle",
  );
  const created = controlPlane.createHostedSession(principal, workspace.id, {}, "session-0001");
  const retried = controlPlane.createHostedSession(principal, workspace.id, {}, "session-0001");
  assert.equal(retried.id, created.id);
  assert.equal(created.state, "queued");

  assert.throws(() => controlPlane.archiveHostedSession(principal, created.id), /must be stopped/);

  const stopped = controlPlane.stopHostedSession(principal, created.id);
  assert.equal(stopped.state, "stopped");
  assert.equal(controlPlane.stopHostedSession(principal, created.id).state, "stopped");

  const archived = controlPlane.archiveHostedSession(principal, created.id);
  assert.equal(archived.state, "archived");
  assert.throws(() => controlPlane.startHostedSession(principal, created.id), /Cannot transition/);
  assert.equal(controlPlane.getHostedSession(principal, created.id).state, "archived");
});

test("a workspace permits only one queued, starting, or running session", () => {
  const { controlPlane } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-single-active",
  );
  const first = controlPlane.createHostedSession(principal, workspace.id, {}, "session-active-1");
  assert.throws(
    () => controlPlane.createHostedSession(principal, workspace.id, {}, "session-active-2"),
    /already has an active hosted session/,
  );
  controlPlane.stopHostedSession(principal, first.id);
  const second = controlPlane.createHostedSession(principal, workspace.id, {}, "session-active-2");
  assert.equal(second.state, "queued");
  assert.throws(() => controlPlane.startHostedSession(principal, first.id), /already has an active hosted session/);
});

test("claiming a hosted runtime is atomic, mints a validated launch, and derives a wss tunnel URL", () => {
  const { controlPlane } = newControlPlane();
  const empty = controlPlane.claimHostedRuntime({ runnerId: "runner-1" });
  assert.equal(empty, undefined);

  const workspace = controlPlane.createWorkspace(
    principal,
    {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision,
      projectTrust: "trusted",
      credentialReferenceNames: ["provider"],
    },
    "workspace-claim",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-claim");
  assert.equal(session.state, "queued");

  const claimed = controlPlane.claimHostedRuntime({ runnerId: "runner-1" });
  assert.ok(claimed);
  hostedRuntimeLaunchSchema.parse(claimed.launch);
  assert.equal(claimed.launch.hostedSessionId, session.id);
  assert.equal(claimed.launch.workspaceRoot, workspace.root);
  assert.deepEqual(claimed.launch.nativeSession, {
    kind: "new",
    sessionDirectory: `/srv/pi-cloud/workspaces/${workspace.id}/native-sessions/${session.id}`,
  });
  assert.equal(claimed.launch.projectTrust, "trusted");
  assert.deepEqual(claimed.credentials, [{ reference: "vault://provider/key", value: "scoped-provider-secret" }]);
  assert.equal(JSON.stringify(workspace).includes("scoped-provider-secret"), false);
  assert.equal(JSON.stringify(claimed).includes("ungranted-provider-secret"), false);
  assert.equal(claimed.tunnel.url, `wss://pi-cloud.example.com/internal/v1/hosted-sessions/${session.id}/tunnel`);

  const second = controlPlane.claimHostedRuntime({ runnerId: "runner-2" });
  assert.equal(second, undefined);

  const authorized = controlPlane.authorizeRuntimeAssignment(session.id, claimed.tunnel.token);
  assert.equal(authorized.session.id, session.id);
  assert.throws(() => controlPlane.authorizeRuntimeAssignment(session.id, claimed.tunnel.token), /Unauthorized/);
  assert.throws(() => controlPlane.authorizeRuntimeAssignment(session.id, "wrong-token"), /Unauthorized/);
});

test("a runtime disconnect closes its assignment after an explicit stop so the session can start again", () => {
  const { controlPlane, store } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-restart",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-restart");
  assert.ok(controlPlane.claimHostedRuntime({ runnerId: "runner-1" }));

  assert.equal(controlPlane.stopHostedSession(principal, session.id).state, "stopped");
  store.markHostedSessionStoppedByRuntime(session.id, new Date());
  const restarted = controlPlane.startHostedSession(principal, session.id);
  assert.equal(restarted.state, "queued");
  assert.equal(restarted.stoppedAt, null);
  assert.ok(controlPlane.claimHostedRuntime({ runnerId: "runner-2" }));
});

test("a stopped session resumes its recorded opaque native session file on its next claim", () => {
  const { controlPlane, store } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-resume",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-resume");
  const nativeSessionFile = `/srv/pi-cloud/workspaces/${workspace.id}/native-sessions/${session.id}/native.jsonl`;
  store.recordNativeSessionMetadata(session.id, "native-1", nativeSessionFile, new Date());

  const claimed = controlPlane.claimHostedRuntime({ runnerId: "runner-1" });
  assert.ok(claimed);
  assert.deepEqual(claimed.launch.nativeSession, {
    kind: "resume",
    sessionFile: nativeSessionFile,
  });
});

test("control-plane restart stops hosted sessions whose ephemeral runtime sockets were lost", () => {
  const { controlPlane, store } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-api-restart",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-api-restart");
  const oldClaim = controlPlane.claimHostedRuntime({ runnerId: "runner-before-restart" });
  assert.ok(oldClaim);
  store.markHostedSessionRunning(session.id, new Date());

  const restarted = new HostedControlPlane(config(), store);
  assert.equal(restarted.getHostedSession(principal, session.id).state, "stopped");
  assert.throws(() => restarted.authorizeRuntimeAssignment(session.id, oldClaim.tunnel.token), /Unauthorized/);
  assert.equal(restarted.startHostedSession(principal, session.id).state, "queued");
  assert.ok(restarted.claimHostedRuntime({ runnerId: "runner-after-restart" }));
});

test("an unconnected runtime claim expires and can be restarted without leaving active authority", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { controlPlane } = newControlPlane({}, () => now);
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-expiry",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-expiry");
  const claim = controlPlane.claimHostedRuntime({ runnerId: "runner-expired" });
  assert.ok(claim);

  now = new Date("2026-01-01T00:01:01.000Z");
  assert.equal(controlPlane.claimHostedRuntime({ runnerId: "runner-recovery" }), undefined);
  assert.equal(controlPlane.getHostedSession(principal, session.id).state, "stopped");
  assert.equal(controlPlane.startHostedSession(principal, session.id).state, "queued");
  assert.ok(controlPlane.claimHostedRuntime({ runnerId: "runner-recovery" }));
  assert.throws(() => controlPlane.authorizeRuntimeAssignment(session.id, claim.tunnel.token), /Unauthorized/);
});

test("a consumed tunnel token without heartbeats expires after a failed upgrade", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { controlPlane } = newControlPlane({}, () => now);
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-failed-upgrade",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-failed-upgrade");
  const claim = controlPlane.claimHostedRuntime({ runnerId: "runner-failed-upgrade" });
  assert.ok(claim);
  controlPlane.authorizeRuntimeAssignment(session.id, claim.tunnel.token);

  now = new Date("2026-01-01T00:01:01.000Z");
  assert.equal(controlPlane.claimHostedRuntime({ runnerId: "runner-recovery" }), undefined);
  assert.equal(controlPlane.getHostedSession(principal, session.id).state, "stopped");
});

test("a connected starting runtime is not expired while checkout heartbeats continue", () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { controlPlane, store } = newControlPlane({}, () => now);
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-connected-starting",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-connected-starting");
  const claim = controlPlane.claimHostedRuntime({ runnerId: "runner-connected" });
  assert.ok(claim);
  const assignment = controlPlane.authorizeRuntimeAssignment(session.id, claim.tunnel.token);
  now = new Date("2026-01-01T00:00:50.000Z");
  store.touchAssignmentHeartbeat(assignment.assignmentId, now);

  now = new Date("2026-01-01T00:01:01.000Z");
  assert.equal(controlPlane.claimHostedRuntime({ runnerId: "runner-other" }), undefined);
  assert.equal(controlPlane.getHostedSession(principal, session.id).state, "starting");
});

test("stopping a session closes late client upgrades and blocks another session in that workspace", () => {
  const { controlPlane, store } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-stop",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-stop");
  const claimed = controlPlane.claimHostedRuntime({ runnerId: "runner-1" });
  assert.ok(claimed);
  const assignment = controlPlane.authorizeRuntimeAssignment(session.id, claimed.tunnel.token);
  const sent: unknown[] = [];
  controlPlane.router.attachRuntime({
    sessionId: session.id,
    assignmentId: assignment.assignmentId,
    workspaceRoot: workspace.root,
    limits: config().hostedLaunchLimits,
    socket: { readyState: 1, send: (payload: string) => sent.push(JSON.parse(payload)), on: () => undefined, once: () => undefined } as never,
  });

  store.markHostedSessionRunning(session.id, new Date());
  controlPlane.authorizeClientConnection(principal, session.id);
  const stopped = controlPlane.stopHostedSession(principal, session.id);
  assert.equal(stopped.state, "stopped");
  const clientCloses: Array<{ code: number; reason: string }> = [];
  controlPlane.router.attachClient(session.id, {
    readyState: 1,
    close: (code: number, reason: string) => clientCloses.push({ code, reason }),
  } as never);
  assert.deepEqual(clientCloses, [{ code: 4410, reason: "hosted runtime disconnected before client attachment" }]);
  assert.throws(() => controlPlane.archiveHostedSession(principal, session.id), /still stopping/);
  assert.throws(
    () => controlPlane.createHostedSession(principal, workspace.id, {}, "session-stop-replacement"),
    /runtime is still stopping/,
  );
  assert.deepEqual(sent, [{ type: "pi_cloud_stop" }]);
});

test("a tunnel upgrade cannot attach after its assignment was stopped", () => {
  const { controlPlane } = newControlPlane();
  const workspace = controlPlane.createWorkspace(
    principal,
    { repositoryUrl: "https://github.com/pi-cloud/example", revision },
    "workspace-upgrade-stop-race",
  );
  const session = controlPlane.createHostedSession(principal, workspace.id, {}, "session-upgrade-stop-race");
  const claimed = controlPlane.claimHostedRuntime({ runnerId: "runner-1" });
  assert.ok(claimed);
  const assignment = controlPlane.authorizeRuntimeAssignment(session.id, claimed.tunnel.token);
  controlPlane.stopHostedSession(principal, session.id);

  const closes: Array<{ code: number; reason: string }> = [];
  controlPlane.router.attachRuntime({
    sessionId: session.id,
    assignmentId: assignment.assignmentId,
    workspaceRoot: workspace.root,
    limits: config().hostedLaunchLimits,
    socket: {
      readyState: 1,
      close: (code: number, reason: string) => closes.push({ code, reason }),
    } as never,
  });

  assert.equal(controlPlane.router.hasRuntime(session.id), false);
  assert.deepEqual(closes, [{ code: 4410, reason: "hosted runtime assignment is no longer active" }]);
});

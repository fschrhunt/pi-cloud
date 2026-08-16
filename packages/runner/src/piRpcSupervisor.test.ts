import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { HostedRuntimeLaunch, PiRpcRecord } from "@pi-cloud/contracts";
import { PiRpcSupervisor, buildPiRpcArguments } from "./piRpcSupervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

async function createLaunch(kind: "new" | "resume" = "new") {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-cloud-rpc-"));
  const workspaceRoot = join(root, "workspace");
  const sessionDirectory = join(root, "sessions");
  const piAgentDirectory = join(root, "agent");
  await Promise.all([
    fs.mkdir(workspaceRoot),
    fs.mkdir(sessionDirectory),
    fs.mkdir(piAgentDirectory),
  ]);
  const sessionFile = join(sessionDirectory, "native.jsonl");
  await fs.writeFile(sessionFile, "persistent\n");
  const launch: HostedRuntimeLaunch = {
    version: 1,
    hostedSessionId: "a0d701e3-bae6-427a-bc22-35d885915da3",
    workspaceId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
    workspaceRoot,
    repository: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    nativeSession: kind === "new" ? { kind, sessionDirectory } : { kind, sessionFile },
    piAgentDirectory,
    credentialReferences: [],
    limits: {
      wallTimeSeconds: 10,
      idleTimeSeconds: 5,
      terminationGraceSeconds: 1,
      maxRecordBytes: 16_384,
      maxCumulativeBytes: 100_000,
    },
    projectTrust: "untrusted",
  };
  return { root, launch, sessionFile };
}

test("supervisor fixture accepts prompt and emits finalized response and agent_settled", async () => {
  const { root, launch, sessionFile } = await createLaunch();
  const records: PiRpcRecord[] = [];
  let settled!: () => void;
  const sawSettled = new Promise<void>((resolve) => { settled = resolve; });
  const supervisor = new PiRpcSupervisor({
    launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH },
    onRecord: (record) => {
      records.push(record);
      if (record.type === "agent_settled") settled();
    },
  });

  try {
    await supervisor.started;
    supervisor.send({ type: "prompt", id: "prompt-1", message: "hello" });
    await sawSettled;
    await supervisor.cancel();
    assert.ok(records.some((record) => record.type === "response" && record.id === "prompt-1"));
    assert.ok(records.some((record) => record.type === "message_end"));
    assert.equal(records.at(-1)?.type, "agent_settled");
    assert.equal(await fs.readFile(sessionFile, "utf8"), "persistent\n");
  } finally {
    await supervisor.cancel().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supervisor classifies malformed output, unexpected exit, startup failure, and forced cancellation", async () => {
  const malformedFixture = await createLaunch();
  const malformed = new PiRpcSupervisor({
    launch: malformedFixture.launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH, PI_CLOUD_FIXTURE_MODE: "malformed" },
    onRecord: () => undefined,
  });
  const malformedFailure = assert.rejects(malformed.completed, (error: unknown) =>
    error instanceof Error && "kind" in error && error.kind === "malformed_output",
  );
  await malformed.started;
  await malformedFailure;
  await fs.rm(malformedFixture.root, { recursive: true, force: true });

  const exitFixture = await createLaunch();
  const exited = new PiRpcSupervisor({
    launch: exitFixture.launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH, PI_CLOUD_FIXTURE_MODE: "exit-on-prompt" },
    onRecord: () => undefined,
  });
  const exitFailure = assert.rejects(exited.completed, (error: unknown) =>
    error instanceof Error && "kind" in error && error.kind === "unexpected_exit",
  );
  await exited.started;
  exited.send({ type: "prompt", message: "exit" });
  await exitFailure;
  await fs.rm(exitFixture.root, { recursive: true, force: true });

  const missingFixture = await createLaunch();
  const missing = new PiRpcSupervisor({
    launch: missingFixture.launch,
    piExecutable: join(missingFixture.root, "missing-pi"),
    onRecord: () => undefined,
  });
  await Promise.all([
    assert.rejects(missing.started, (error: unknown) => error instanceof Error && "kind" in error && error.kind === "startup_failure"),
    assert.rejects(missing.completed, (error: unknown) => error instanceof Error && "kind" in error && error.kind === "startup_failure"),
  ]);
  await fs.rm(missingFixture.root, { recursive: true, force: true });

  const timeoutFixture = await createLaunch();
  timeoutFixture.launch.limits.wallTimeSeconds = 1;
  const timedOut = new PiRpcSupervisor({
    launch: timeoutFixture.launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH },
    onRecord: () => undefined,
  });
  const timeoutFailure = assert.rejects(timedOut.completed, (error: unknown) =>
    error instanceof Error && "kind" in error && error.kind === "wall_timeout",
  );
  await timedOut.started;
  await timeoutFailure;
  await fs.rm(timeoutFixture.root, { recursive: true, force: true });

  const forcedFixture = await createLaunch();
  forcedFixture.launch.limits.terminationGraceSeconds = 0;
  const forced = new PiRpcSupervisor({
    launch: forcedFixture.launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH, PI_CLOUD_FIXTURE_MODE: "ignore-term" },
    onRecord: () => undefined,
  });
  await forced.started;
  await forced.cancel();
  await fs.rm(forcedFixture.root, { recursive: true, force: true });
});

test("production child environment excludes Pi Cloud control credentials", async () => {
  const { root, launch } = await createLaunch();
  const records: PiRpcRecord[] = [];
  const previous = process.env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN;
  process.env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN = "must-not-reach-pi";
  let settled!: () => void;
  const sawSettled = new Promise<void>((resolve) => { settled = resolve; });
  const supervisor = new PiRpcSupervisor({
    launch,
    piExecutable: fixture,
    onRecord: (record) => {
      records.push(record);
      if (record.type === "agent_settled") settled();
    },
  });
  try {
    await supervisor.started;
    supervisor.send({ type: "prompt", message: "inspect-environment" });
    await sawSettled;
    await supervisor.cancel();
    const wire = JSON.stringify(records);
    assert.doesNotMatch(wire, /must-not-reach-pi/);
    assert.match(wire, /not-inherited/);
  } finally {
    if (previous === undefined) delete process.env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN;
    else process.env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN = previous;
    await supervisor.cancel().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restart argv resumes the native file with --session and scrubs the child environment", async () => {
  const { root, launch } = await createLaunch("resume");
  const argvPath = join(root, "argv.jsonl");
  let scrubbed = false;
  let stateReceived!: () => void;
  let runtimeHome: string | undefined;
  let runtimeTemp: string | undefined;
  const sawState = new Promise<void>((resolve) => { stateReceived = resolve; });
  const supervisor = new PiRpcSupervisor({
    launch,
    piExecutable: fixture,
    environment: { PATH: process.env.PATH, PI_CLOUD_FIXTURE_ARGV: argvPath },
    credentialEnvironment: { TEST_SECRET: "runtime-secret" },
    onRecord: (record) => {
      if (record.type === "response" && record.command === "get_state") {
        const data = record.data as { homeDirectory?: string; tempDirectory?: string };
        runtimeHome = data.homeDirectory;
        runtimeTemp = data.tempDirectory;
        stateReceived();
      }
    },
    onEnvironmentScrubbed: () => { scrubbed = true; },
  });
  try {
    await supervisor.started;
    supervisor.send({ type: "get_state", id: "startup" });
    await sawState;
    await supervisor.cancel();
    const argv = JSON.parse((await fs.readFile(argvPath, "utf8")).trim()) as string[];
    assert.deepEqual(argv, buildPiRpcArguments(launch));
    assert.deepEqual(argv.slice(-2), ["--session", launch.nativeSession.kind === "resume" ? launch.nativeSession.sessionFile : ""]);
    assert.equal(runtimeHome, join(root, "sessions", "runtime-home"));
    assert.equal(runtimeTemp, join(root, "sessions", "runtime-home", "tmp"));
    assert.equal(scrubbed, true);
  } finally {
    await supervisor.cancel().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

#!/usr/bin/env node

/** Exercises an isolated single-operator hosted runtime flow against a dedicated API and real Pi CLI. */
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const apiAppEntry = resolve("packages/api/dist/app.js");
const apiConfigEntry = resolve("packages/api/dist/config.js");
const runnerEntry = resolve("packages/runner/dist/runner.js");
const nodeModulesBin = resolve("node_modules/.bin");
const defaultExpectedMarker = "SMOKE_OK";
const maxDiagnosticBytes = 32_768;

async function main() {
  const config = await readConfig(process.env);
  /** @type {RunnerProcess[]} */
  const runners = [];
  /** @type {HostedClientConnection[]} */
  const clients = [];
  /** @type {ApiProcess | undefined} */
  let api;
  let finalSummary;

  try {
    await assertBuiltRuntime();
    assertPiExecutable(config.piExecutable);
    await ensureRuntimeRoots(config);

    api = new ApiProcess(config);
    await api.waitForHealth(30_000);

    const workspace = await createWorkspace(config);
    const session = await createSession(config, workspace.id);
    const expectedWorkspaceRoot = workspace.root;

    const firstRunner = startHostedRunner(config, "run-1");
    runners.push(firstRunner);

    const firstRunningSession = await waitForSessionState(config, session.id, ["running"], 120_000, firstRunner);
    const initialNative = await waitForNativeSession(config, session.id, 120_000, firstRunner);
    await assertPathExists(expectedWorkspaceRoot, "workspace root");
    await assertPathExists(initialNative.nativeSessionFile, "native session file");

    const firstClient = await openHostedClient(config, session.id);
    clients.push(firstClient);
    const promptResult = await promptAndWait(firstClient, session.id, config.prompt, config.expectedMarker, 180_000);
    await firstClient.close();

    const reconnectedClient = await openHostedClient(config, session.id);
    clients.push(reconnectedClient);
    const reconnectState = await getState(reconnectedClient, session.id, initialNative, 30_000);
    await reconnectedClient.close();

    await stopSession(config, session.id);
    const firstStoppedSession = await waitForSessionState(config, session.id, ["stopped"], 120_000, firstRunner);
    await firstRunner.expectCleanExit(120_000, "first hosted runner stop");
    if (firstStoppedSession.nativeSessionId !== initialNative.nativeSessionId || firstStoppedSession.nativeSessionFile !== initialNative.nativeSessionFile) {
      throw new Error("Hosted session metadata changed after the first stop");
    }

    const restarted = await startSession(config, session.id);
    if (restarted.state !== "queued") throw new Error(`Restart returned unexpected state: ${restarted.state}`);

    const secondRunner = startHostedRunner(config, "run-2");
    runners.push(secondRunner);
    const secondRunningSession = await waitForSessionState(config, session.id, ["running"], 120_000, secondRunner);
    const resumedNative = await waitForNativeSession(config, session.id, 120_000, secondRunner);
    if (resumedNative.nativeSessionId !== initialNative.nativeSessionId || resumedNative.nativeSessionFile !== initialNative.nativeSessionFile) {
      throw new Error("Restart did not resume the same native Pi session metadata");
    }

    const resumedClient = await openHostedClient(config, session.id);
    clients.push(resumedClient);
    const resumedState = await getState(resumedClient, session.id, initialNative, 30_000);
    const resumedEntries = await getEntries(resumedClient, session.id, config.prompt, config.expectedMarker, 30_000);
    await resumedClient.close();

    await stopSession(config, session.id);
    const finalSession = await waitForSessionState(config, session.id, ["stopped"], 120_000, secondRunner);
    await secondRunner.expectCleanExit(120_000, "second hosted runner stop");

    const finalWorkspace = await getWorkspace(config, workspace.id);
    if (finalWorkspace.root !== expectedWorkspaceRoot) throw new Error("Workspace root changed across the smoke flow");
    if (finalSession.nativeSessionFile !== initialNative.nativeSessionFile) throw new Error("Native session file changed across restart");
    await assertPathExists(finalWorkspace.root, "persistent workspace root");
    await assertPathExists(finalSession.nativeSessionFile, "persistent native session file");

    finalSummary = {
      workspaceId: workspace.id,
      sessionId: session.id,
      workspaceRoot: finalWorkspace.root,
      nativeSessionId: resumedState.sessionId,
      nativeSessionFile: resumedState.sessionFile,
      promptMessage: promptResult.messageText,
      firstStartedAt: firstRunningSession.startedAt,
      secondStartedAt: secondRunningSession.startedAt,
      reconnectState,
      resumedEntries,
    };

    const archived = await archiveSession(config, session.id);
    if (archived.state !== "archived") throw new Error(`Archive returned unexpected state: ${archived.state}`);
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const runner of runners) await runner.stop().catch(() => undefined);
    await api?.stop().catch(() => undefined);
    await rm(config.controlPlaneRoot, { recursive: true, force: true });
  }

  console.log("Hosted runtime smoke passed.");
  console.log(`Workspace: ${finalSummary.workspaceId} -> ${finalSummary.workspaceRoot}`);
  console.log(`Hosted session: ${finalSummary.sessionId}`);
  console.log(`Native session: ${finalSummary.nativeSessionId} -> ${finalSummary.nativeSessionFile}`);
  console.log(`Prompt result: ${finalSummary.promptMessage}`);
}

async function readConfig(env) {
  const repositoryUrl = required(env.PI_CLOUD_SMOKE_REPOSITORY_URL, "PI_CLOUD_SMOKE_REPOSITORY_URL");
  const revision = required(env.PI_CLOUD_SMOKE_REVISION, "PI_CLOUD_SMOKE_REVISION");
  const expectedMarker = env.PI_CLOUD_SMOKE_EXPECTED_MARKER ?? defaultExpectedMarker;
  if (expectedMarker.length === 0) throw new Error("PI_CLOUD_SMOKE_EXPECTED_MARKER must not be empty");
  const hostedCredentialReferences = parseHostedCredentialReferences(env.PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES);
  const credentialReferenceNames = parseCredentialReferenceNames(
    env.PI_CLOUD_SMOKE_CREDENTIAL_REFERENCE_NAMES,
    hostedCredentialReferences,
  );
  const hostedCredentials = parseHostedCredentialValues(env.PI_CLOUD_HOSTED_CREDENTIALS, hostedCredentialReferences);
  const controlPlaneRoot = await mkdtemp(join(tmpdir(), "pi-cloud-smoke-"));

  try {
    const apiPort = await reserveUnusedLoopbackPort();
    const apiBaseUrl = parseUrl(`http://127.0.0.1:${apiPort}`, "generated API base URL");
    const dispatcherToken = randomToken();
    const userToken = randomToken();
    const taskLeasePrivateKey = generateTaskLeasePrivateKey();
    const apiCredentialsJson = JSON.stringify([
      { token: userToken, subjectId: "smoke-user", type: "user", displayName: "Hosted Smoke User" },
    ]);
    const hostedCredentialReferencesJson = hostedCredentialReferences.length > 0
      ? JSON.stringify(hostedCredentialReferences)
      : undefined;

    return {
      apiBaseUrl,
      apiPort,
      repositoryUrl,
      revision,
      projectTrust: parseProjectTrust(env.PI_CLOUD_SMOKE_PROJECT_TRUST),
      prompt: env.PI_CLOUD_SMOKE_PROMPT ?? `Reply with the exact text ${expectedMarker} on a single line.`,
      expectedMarker,
      userToken,
      dispatcherToken,
      taskLeasePrivateKey,
      apiCredentialsJson,
      runnerDispatcherUrl: apiBaseUrl,
      runnerIdBase: `smoke-hosted-${process.pid}-${randomUUID()}`,
      controlPlaneRoot,
      databasePath: join(controlPlaneRoot, "control-plane.sqlite"),
      workspaceRoots: join(controlPlaneRoot, "workspaces"),
      sessionRoots: join(controlPlaneRoot, "workspaces"),
      agentRoots: join(controlPlaneRoot, "agent"),
      hostedCredentialReferencesJson,
      hostedCredentialsJson: hostedCredentials.json,
      hostedCredentialValues: hostedCredentials.secrets,
      credentialReferenceNames,
      piExecutable: env.PI_CLOUD_PI_EXECUTABLE ?? "pi",
      secrets: [
        userToken,
        dispatcherToken,
        taskLeasePrivateKey,
        apiCredentialsJson,
        hostedCredentials.json,
        ...hostedCredentials.secrets,
      ],
    };
  } catch (error) {
    await rm(controlPlaneRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parseHostedCredentialReferences(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES must be a JSON array");
  const names = new Set();
  const environmentVariables = new Set();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.some((key) => !["name", "reference", "environmentVariable"].includes(key))) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES[${index}] contains an unsupported field`);
    }
    const { name, reference, environmentVariable } = entry;
    if (typeof name !== "string" || name.length === 0 || name.length > 200) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES[${index}].name must be a 1-200 character string`);
    }
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 1024) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES[${index}].reference must be a 1-1024 character string`);
    }
    if (typeof environmentVariable !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(environmentVariable)) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES[${index}].environmentVariable must be a valid environment variable name`);
    }
    if (names.has(name)) throw new Error(`Duplicate hosted credential reference name: ${name}`);
    if (environmentVariables.has(environmentVariable)) {
      throw new Error(`Duplicate hosted credential environment variable: ${environmentVariable}`);
    }
    names.add(name);
    environmentVariables.add(environmentVariable);
    return { name, reference, environmentVariable };
  });
}

function parseCredentialReferenceNames(explicitValue, configuredReferences) {
  const names = explicitValue
    ? parseNameList(explicitValue, "PI_CLOUD_SMOKE_CREDENTIAL_REFERENCE_NAMES")
    : [];
  const configuredNames = new Set(configuredReferences.map((entry) => entry.name));
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate requested credential reference name: ${name}`);
    seen.add(name);
    if (!configuredNames.has(name)) throw new Error(`Unknown credential reference requested by smoke config: ${name}`);
  }
  return names;
}

function parseNameList(value, name) {
  if (value.trim().startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${name} must be a comma-separated list or JSON array`);
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error(`${name} must contain only non-empty strings`);
    }
    return parsed;
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseHostedCredentialValues(value, references) {
  if (!value) {
    if (references.length > 0) {
      throw new Error(
        `Missing PI_CLOUD_HOSTED_CREDENTIALS for configured hosted credential references: ${references.map((entry) => entry.name).join(", ")}`,
      );
    }
    return { json: undefined, secrets: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIALS must be a JSON object mapping reference strings to credential values");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIALS must be a JSON object mapping reference strings to credential values");
  }
  let credentialBytes = 0;
  for (const [reference, credentialValue] of Object.entries(parsed)) {
    if (reference.length === 0 || reference.length > 1024) {
      throw new Error("PI_CLOUD_HOSTED_CREDENTIALS references must be 1-1024 characters");
    }
    if (typeof credentialValue !== "string" || credentialValue.length === 0 || credentialValue.length > 65_536) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIALS[${reference}] must be a 1-65536 character string`);
    }
    credentialBytes += Buffer.byteLength(credentialValue, "utf8");
  }
  if (credentialBytes > 65_536) throw new Error("PI_CLOUD_HOSTED_CREDENTIALS values exceed 65536 UTF-8 bytes");

  const expectedReferences = new Set(references.map((entry) => entry.reference));
  for (const reference of expectedReferences) {
    if (!(reference in parsed)) throw new Error(`PI_CLOUD_HOSTED_CREDENTIALS is missing configured reference: ${reference}`);
  }
  for (const reference of Object.keys(parsed)) {
    if (!expectedReferences.has(reference)) {
      throw new Error(`PI_CLOUD_HOSTED_CREDENTIALS contains a value without a configured reference: ${reference}`);
    }
  }
  if (references.length === 0 && Object.keys(parsed).length > 0) {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIALS requires PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES");
  }
  return { json: references.length > 0 ? JSON.stringify(parsed) : undefined, secrets: Object.values(parsed) };
}

async function assertBuiltRuntime() {
  await Promise.all([
    assertPathExists(apiAppEntry, "built API app entrypoint"),
    assertPathExists(apiConfigEntry, "built API config entrypoint"),
    assertPathExists(runnerEntry, "built hosted runner entrypoint"),
  ]);
}

async function ensureRuntimeRoots(config) {
  const roots = [config.workspaceRoots, config.sessionRoots, config.agentRoots]
    .flatMap((value) => value.split(delimiter))
    .filter(Boolean);
  try {
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
  } catch (error) {
    throw new Error(
      `Unable to create hosted runtime roots (${roots.join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertPiExecutable(piExecutable) {
  const result = spawnSync(piExecutable, ["--help"], { encoding: "utf8", timeout: 15_000 });
  if (result.error?.code === "ENOENT") {
    throw new Error(`Pi executable not found on PATH: ${piExecutable}. Install Pi or set PI_CLOUD_PI_EXECUTABLE.`);
  }
  if (result.error) {
    throw new Error(`Failed to invoke ${piExecutable}: ${result.error.message}`);
  }
}

async function createWorkspace(config) {
  return requestJson(config, {
    method: "POST",
    path: "/v1/workspaces",
    token: config.userToken,
    expectedStatus: 201,
    headers: { "idempotency-key": `workspace-${randomUUID()}` },
    body: {
      repositoryUrl: config.repositoryUrl,
      revision: config.revision,
      projectTrust: config.projectTrust,
      credentialReferenceNames: config.credentialReferenceNames,
    },
  });
}

async function getWorkspace(config, workspaceId) {
  return requestJson(config, {
    method: "GET",
    path: `/v1/workspaces/${workspaceId}`,
    token: config.userToken,
    expectedStatus: 200,
  });
}

async function createSession(config, workspaceId) {
  return requestJson(config, {
    method: "POST",
    path: `/v1/workspaces/${workspaceId}/sessions`,
    token: config.userToken,
    expectedStatus: 201,
    headers: { "idempotency-key": `session-${randomUUID()}` },
    body: {},
  });
}

async function getSession(config, sessionId) {
  return requestJson(config, {
    method: "GET",
    path: `/v1/hosted-sessions/${sessionId}`,
    token: config.userToken,
    expectedStatus: 200,
  });
}

async function startSession(config, sessionId) {
  return requestJson(config, {
    method: "POST",
    path: `/v1/hosted-sessions/${sessionId}/start`,
    token: config.userToken,
    expectedStatus: 200,
  });
}

async function stopSession(config, sessionId) {
  return requestJson(config, {
    method: "POST",
    path: `/v1/hosted-sessions/${sessionId}/stop`,
    token: config.userToken,
    expectedStatus: 200,
  });
}

async function archiveSession(config, sessionId) {
  return requestJson(config, {
    method: "POST",
    path: `/v1/hosted-sessions/${sessionId}/archive`,
    token: config.userToken,
    expectedStatus: 200,
  });
}

async function requestJson(config, options) {
  const response = await fetch(new URL(options.path, config.apiBaseUrl), {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status !== options.expectedStatus) {
    throw new Error(`${options.method} ${options.path} failed with ${response.status}: ${await safeResponseText(response)}`);
  }
  if (options.expectedStatus === 204) return undefined;
  return response.json();
}

async function safeResponseText(response) {
  const text = await response.text();
  return text.length === 0 ? response.statusText : text;
}

async function waitForSessionState(config, sessionId, states, timeoutMs, runner) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner?.exitInfo) {
      throw new Error(`Hosted runner exited before session ${sessionId} reached ${states.join(", ")}: ${runner.describeExit()}`);
    }
    const session = await getSession(config, sessionId);
    if (states.includes(session.state)) return session;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for session ${sessionId} to reach ${states.join(", ")}`);
}

async function waitForNativeSession(config, sessionId, timeoutMs, runner) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner?.exitInfo) {
      throw new Error(`Hosted runner exited before recording native session metadata: ${runner.describeExit()}`);
    }
    const session = await getSession(config, sessionId);
    if (typeof session.nativeSessionId === "string" && typeof session.nativeSessionFile === "string") {
      return { nativeSessionId: session.nativeSessionId, nativeSessionFile: session.nativeSessionFile };
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for native session metadata on hosted session ${sessionId}`);
}

function startHostedRunner(config, suffix) {
  return new RunnerProcess(config, suffix);
}

function apiBootstrapSource() {
  return `
    import { buildApp } from ${JSON.stringify(pathToFileURL(apiAppEntry).href)};
    import { readApiConfig } from ${JSON.stringify(pathToFileURL(apiConfigEntry).href)};
    const app = await buildApp(readApiConfig(process.env));
    const stop = async () => {
      try {
        await app.close();
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await app.listen({ host: "127.0.0.1", port: Number.parseInt(process.env.PORT ?? "0", 10) });
  `;
}

/** Owns the dedicated built API child and exposes redacted, bounded failure diagnostics. */
class ApiProcess {
  constructor(config) {
    this.config = config;
    this.secrets = config.secrets;
    this.stdout = "";
    this.stderr = "";
    this.exitInfo = undefined;
    const childEnvironment = {
      ...allowlistedHostEnvironment(process.env),
      PATH: joinPath(nodeModulesBin, process.env.PATH ?? ""),
      PORT: String(config.apiPort),
      PI_CLOUD_PUBLIC_BASE_URL: config.apiBaseUrl.toString(),
      PI_CLOUD_DATABASE_PATH: config.databasePath,
      PI_CLOUD_RUNTIME_WORKSPACE_ROOT: config.workspaceRoots,
      PI_CLOUD_RUNTIME_AGENT_DIRECTORY: config.agentRoots,
      PI_CLOUD_DISPATCHER_TOKEN: config.dispatcherToken,
      PI_CLOUD_TASK_LEASE_PRIVATE_KEY: config.taskLeasePrivateKey,
      PI_CLOUD_API_CREDENTIALS: config.apiCredentialsJson,
      ...(config.hostedCredentialReferencesJson ? { PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES: config.hostedCredentialReferencesJson } : {}),
      ...(config.hostedCredentialsJson ? { PI_CLOUD_HOSTED_CREDENTIALS: config.hostedCredentialsJson } : {}),
    };
    this.child = spawn(process.execPath, ["--input-type=module", "--eval", apiBootstrapSource()], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => { this.stdout = appendBoundedDiagnostic(this.stdout, chunk); });
    this.child.stderr.on("data", (chunk) => { this.stderr = appendBoundedDiagnostic(this.stderr, chunk); });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  async waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exitInfo) throw new Error(`Dedicated API exited before becoming healthy: ${this.describeExit()}`);
      try {
        const response = await fetch(new URL("/health", this.config.apiBaseUrl));
        if (response.ok) return;
      } catch {
        // Retry until the child either listens, exits, or the deadline expires.
      }
      await delay(250);
    }
    throw new Error(`Timed out waiting for dedicated API health: ${this.describeExit()}`);
  }

  describeExit() {
    const info = this.exitInfo;
    const summary = `exit code=${String(info?.code)} signal=${String(info?.signal)}`;
    const output = [this.stdout.trim(), this.stderr.trim()].filter(Boolean).join("\n");
    return output ? `${summary}\n${redact(output, this.secrets)}` : summary;
  }

  async stop() {
    if (this.exitInfo) return this.exitInfo;
    this.child.kill("SIGTERM");
    try {
      return await withTimeout(this.exitPromise, 10_000, "Timed out stopping dedicated API process");
    } catch {
      this.child.kill("SIGKILL");
      return this.exitPromise;
    }
  }
}

/** Owns one hosted runner worker child and reports redacted exit details to the smoke flow. */
class RunnerProcess {
  constructor(config, suffix) {
    this.secrets = config.secrets;
    this.stdout = "";
    this.stderr = "";
    this.exitInfo = undefined;
    const childEnvironment = {
      ...allowlistedHostEnvironment(process.env),
      PATH: joinPath(nodeModulesBin, process.env.PATH ?? ""),
      PI_CLOUD_HOSTED_DISPATCHER_URL: config.runnerDispatcherUrl.toString(),
      PI_CLOUD_HOSTED_DISPATCHER_TOKEN: config.dispatcherToken,
      PI_CLOUD_RUNNER_ID: `${config.runnerIdBase}-${suffix}`,
      PI_CLOUD_HOSTED_WORKSPACE_ROOTS: config.workspaceRoots,
      PI_CLOUD_HOSTED_SESSION_ROOTS: config.sessionRoots,
      PI_CLOUD_HOSTED_AGENT_ROOTS: config.agentRoots,
      PI_CLOUD_HOSTED_PROCESS_ISOLATION: "inherit",
      ...(config.piExecutable ? { PI_CLOUD_PI_EXECUTABLE: config.piExecutable } : {}),
    };
    this.child = spawn(process.execPath, [runnerEntry], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => { this.stdout = appendBoundedDiagnostic(this.stdout, chunk); });
    this.child.stderr.on("data", (chunk) => { this.stderr = appendBoundedDiagnostic(this.stderr, chunk); });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  describeExit() {
    const info = this.exitInfo;
    const summary = `exit code=${String(info?.code)} signal=${String(info?.signal)}`;
    const output = [this.stdout.trim(), this.stderr.trim()].filter(Boolean).join("\n");
    return output ? `${summary}\n${redact(output, this.secrets)}` : summary;
  }

  async expectCleanExit(timeoutMs, context) {
    const info = await withTimeout(this.exitPromise, timeoutMs, `Timed out waiting for ${context}`);
    if (info.code !== 0) throw new Error(`${context} failed: ${this.describeExit()}`);
    return info;
  }

  async stop() {
    if (this.exitInfo) return this.exitInfo;
    this.child.kill("SIGTERM");
    try {
      return await withTimeout(this.exitPromise, 10_000, "Timed out stopping hosted runner process");
    } catch {
      this.child.kill("SIGKILL");
      return this.exitPromise;
    }
  }
}

async function openHostedClient(config, sessionId) {
  const url = new URL(`/v1/hosted-sessions/${sessionId}/rpc`, config.apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = await openWebSocket(url, config.userToken);
  return new HostedClientConnection(socket, sessionId, config.secrets);
}

async function openWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const cleanup = () => {
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("unexpected-response", onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onUnexpectedResponse = async (_request, response) => {
      cleanup();
      reject(new Error(`WebSocket upgrade failed with ${response.statusCode}: ${await readIncomingMessage(response)}`));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("unexpected-response", onUnexpectedResponse);
  });
}

/** Sends and receives one public hosted RPC client connection with per-request sequencing. */
class HostedClientConnection {
  constructor(socket, sessionId, secrets) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.secrets = secrets;
    this.sequence = 0;
    this.inboundSequence = 0;
    this.queue = [];
    this.waiters = [];
    this.closed = undefined;

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.reject(new Error("Hosted client received an unexpected binary frame"));
        return;
      }
      try {
        const envelope = JSON.parse(String(data));
        if (envelope?.version !== 1 || envelope.direction !== "pi_to_client") {
          throw new Error("Hosted client received an invalid envelope version or direction");
        }
        if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
          throw new Error("Hosted client received an invalid envelope sequence");
        }
        if (envelope.sequence !== this.inboundSequence + 1) {
          throw new Error("Hosted client received a non-contiguous envelope sequence");
        }
        if (!envelope.record || typeof envelope.record !== "object") {
          throw new Error("Hosted client received an envelope without a native Pi record");
        }
        this.inboundSequence = envelope.sequence;
        this.push(envelope);
      } catch (error) {
        this.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("close", (code, reason) => {
      this.closed = new Error(`Hosted client WebSocket closed (${code}): ${Buffer.from(reason).toString("utf8")}`);
      this.reject(this.closed);
    });
    socket.once("error", (error) => {
      this.closed = error;
      this.reject(error);
    });
  }

  send(record) {
    const envelope = {
      version: 1,
      hostedSessionId: this.sessionId,
      direction: "client_to_pi",
      sequence: ++this.sequence,
      record,
    };
    this.socket.send(JSON.stringify(envelope));
  }

  async next(timeoutMs) {
    if (this.queue.length > 0) return this.queue.shift();
    if (this.closed) throw this.closed;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.reject !== reject);
        reject(new Error(`Timed out waiting for hosted session envelope after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async close() {
    if (this.socket.readyState >= WebSocket.CLOSING) return;
    await new Promise((resolve) => {
      this.socket.once("close", () => resolve(undefined));
      this.socket.close(1000, "smoke test reconnect");
    });
  }

  push(value) {
    if (this.waiters.length > 0) {
      this.waiters.shift().resolve(value);
      return;
    }
    this.queue.push(value);
  }

  reject(error) {
    while (this.waiters.length > 0) this.waiters.shift().reject(error);
  }
}

async function promptAndWait(client, sessionId, prompt, expectedMarker, timeoutMs) {
  const requestId = `prompt-${randomUUID()}`;
  client.send({ type: "prompt", id: requestId, message: prompt });
  const deadline = Date.now() + timeoutMs;
  let sawMessageEnd = false;
  let sawSettled = false;
  let messageText = "";

  while (Date.now() < deadline) {
    const envelope = await client.next(Math.max(1, deadline - Date.now()));
    if (envelope?.hostedSessionId !== sessionId) throw new Error("Received a hosted envelope for the wrong session");
    const record = envelope.record;
    if (!record || typeof record !== "object") continue;
    if (record.type === "response" && record.command === "prompt" && record.id === requestId && record.success === false) {
      throw new Error(`Pi rejected the smoke prompt: ${JSON.stringify(record)}`);
    }
    if (record.type === "message_end") {
      sawMessageEnd = true;
      messageText = extractMessageText(record);
    }
    if (record.type === "agent_settled") sawSettled = true;
    if (record.type === "error") throw new Error(`Pi returned an error record: ${JSON.stringify(record)}`);
    if (sawMessageEnd && sawSettled) {
      if (!messageText.includes(expectedMarker)) {
        throw new Error(`Prompt completed without the expected marker. Final message: ${messageText}`);
      }
      return { messageText };
    }
  }

  throw new Error("Timed out waiting for a finalized assistant message and agent_settled");
}

async function getState(client, sessionId, expectedNative, timeoutMs) {
  const requestId = `state-${randomUUID()}`;
  client.send({ type: "get_state", id: requestId });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const envelope = await client.next(Math.max(1, deadline - Date.now()));
    if (envelope?.hostedSessionId !== sessionId) throw new Error("Received a hosted envelope for the wrong session");
    const record = envelope.record;
    if (
      record?.type === "response"
      && record.command === "get_state"
      && record.id === requestId
      && record.success === true
      && record.data
      && typeof record.data.sessionId === "string"
      && typeof record.data.sessionFile === "string"
    ) {
      if (record.data.sessionId !== expectedNative.nativeSessionId || record.data.sessionFile !== expectedNative.nativeSessionFile) {
        throw new Error("Reconnected get_state returned different native session metadata");
      }
      return { sessionId: record.data.sessionId, sessionFile: record.data.sessionFile };
    }
    if (record?.type === "response" && record.command === "get_state" && record.id === requestId && record.success === false) {
      throw new Error(`get_state failed after reconnect: ${JSON.stringify(record)}`);
    }
  }

  throw new Error("Timed out waiting for get_state after reconnect");
}

async function getEntries(client, sessionId, initialPrompt, expectedMarker, timeoutMs) {
  const requestId = `entries-${randomUUID()}`;
  client.send({ type: "get_entries", id: requestId });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const envelope = await client.next(Math.max(1, deadline - Date.now()));
    if (envelope?.hostedSessionId !== sessionId) throw new Error("Received a hosted envelope for the wrong session");
    const record = envelope.record;
    if (record?.type === "response" && record.command === "get_entries" && record.id === requestId && record.success === true) {
      const entries = record.data?.entries;
      if (!Array.isArray(entries)) throw new Error("Reconnected get_entries returned no entry array");
      const hasInitialPrompt = entries.some((entry) =>
        entry?.type === "message" && entry.message?.role === "user" && sessionEntryText(entry) === initialPrompt,
      );
      if (!hasInitialPrompt) throw new Error("Reconnected get_entries did not contain the exact initial user prompt");
      const hasAssistantMarker = entries.some((entry) =>
        entry?.type === "message"
        && entry.message?.role === "assistant"
        && sessionEntryText(entry).includes(expectedMarker),
      );
      if (!hasAssistantMarker) throw new Error("Reconnected get_entries had no assistant entry with the expected marker");
      return { entryCount: entries.length };
    }
    if (record?.type === "response" && record.command === "get_entries" && record.id === requestId && record.success === false) {
      throw new Error(`get_entries failed after reconnect: ${JSON.stringify(record)}`);
    }
    if (record?.type === "error") throw new Error(`Pi returned an error record after reconnect: ${JSON.stringify(record)}`);
  }

  throw new Error("Timed out waiting for get_entries after reconnect");
}

function sessionEntryText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function extractMessageText(record) {
  const content = Array.isArray(record?.message?.content) ? record.message.content : [];
  const text = content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text || JSON.stringify(record.message ?? record);
}

async function assertPathExists(path, label) {
  await access(path, fsConstants.F_OK).catch(() => {
    throw new Error(`Missing ${label}: ${path}`);
  });
}

function parseUrl(value, sourceName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${sourceName} must be an absolute URL`);
  }
  return new URL(url.toString().replace(/\/+$/u, "") + "/");
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseProjectTrust(value) {
  if (value === undefined || value === "untrusted") return "untrusted";
  if (value === "trusted") return "trusted";
  throw new Error("PI_CLOUD_SMOKE_PROJECT_TRUST must be trusted or untrusted");
}

function joinPath(prefix, existing) {
  return existing ? `${prefix}${delimiter}${existing}` : prefix;
}

async function reserveUnusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise(undefined)));
  if (!port) throw new Error("Unable to reserve an unused loopback port");
  return port;
}

function generateTaskLeasePrivateKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function allowlistedHostEnvironment(environment) {
  const allowedNames = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_PROXY",
    "PATH",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
  ];
  return Object.fromEntries(
    allowedNames.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]),
  );
}

async function readIncomingMessage(stream) {
  let body = "";
  for await (const chunk of stream) body += chunk;
  return body || stream.statusMessage || "no response body";
}

function appendBoundedDiagnostic(current, chunk) {
  const encoded = Buffer.from(current + String(chunk));
  if (encoded.byteLength <= maxDiagnosticBytes) return encoded.toString("utf8");
  let start = encoded.byteLength - maxDiagnosticBytes;
  while (start < encoded.byteLength && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function redact(text, secrets) {
  return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

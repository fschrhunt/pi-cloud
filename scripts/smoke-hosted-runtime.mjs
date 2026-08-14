#!/usr/bin/env node

/** Exercises the single-operator hosted runtime flow against a local API and real Pi CLI. */
import { access, mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, resolve } from "node:path";
import process from "node:process";
import WebSocket from "ws";

const runnerEntry = resolve("packages/runner/dist/runner.js");
const nodeModulesBin = resolve("node_modules/.bin");
const defaultPrompt = "Reply with the exact text SMOKE_OK on a single line.";

async function main() {
  const config = readConfig(process.env);
  await assertBuiltRunner();
  assertPiExecutable(config.piExecutable);
  await ensureRuntimeRoots(config);
  await checkApiHealth(config.apiBaseUrl);

  const workspace = await createWorkspace(config);
  const session = await createSession(config, workspace.id);
  const expectedWorkspaceRoot = workspace.root;

  /** @type {RunnerProcess[]} */
  const runners = [];
  /** @type {HostedClientConnection[]} */
  const clients = [];
  let finalSummary;

  try {
    const firstRunner = startHostedRunner(config, "run-1");
    runners.push(firstRunner);

    const firstRunningSession = await waitForSessionState(config, session.id, ["running"], 120_000, firstRunner);
    const initialNative = await waitForNativeSession(config, session.id, 120_000, firstRunner);
    await assertPathExists(expectedWorkspaceRoot, "workspace root");
    await assertPathExists(initialNative.nativeSessionFile, "native session file");

    const firstClient = await openHostedClient(config, session.id);
    clients.push(firstClient);
    const promptResult = await promptAndWait(firstClient, session.id, config.prompt, 180_000);
    if (!promptResult.messageText.includes("SMOKE_OK")) {
      throw new Error(`Prompt completed without the expected marker. Final message: ${promptResult.messageText}`);
    }
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
    };
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const runner of runners) await runner.stop().catch(() => undefined);
  }

  console.log("Hosted runtime smoke passed.");
  console.log(`Workspace: ${finalSummary.workspaceId} -> ${finalSummary.workspaceRoot}`);
  console.log(`Hosted session: ${finalSummary.sessionId}`);
  console.log(`Native session: ${finalSummary.nativeSessionId} -> ${finalSummary.nativeSessionFile}`);
  console.log(`Prompt result: ${finalSummary.promptMessage}`);
}

function readConfig(env) {
  const apiBaseUrl = parseUrl(
    env.PI_CLOUD_SMOKE_API_BASE_URL
      ?? env.PI_CLOUD_PUBLIC_BASE_URL
      ?? env.PI_CLOUD_HOSTED_DISPATCHER_URL
      ?? `http://127.0.0.1:${env.PORT ?? "3000"}`,
    "PI_CLOUD_SMOKE_API_BASE_URL",
  );
  const repositoryUrl = required(env.PI_CLOUD_SMOKE_REPOSITORY_URL, "PI_CLOUD_SMOKE_REPOSITORY_URL");
  const revision = required(env.PI_CLOUD_SMOKE_REVISION, "PI_CLOUD_SMOKE_REVISION");
  const userToken = env.PI_CLOUD_SMOKE_USER_TOKEN ?? firstApiCredentialToken(env.PI_CLOUD_API_CREDENTIALS);
  const dispatcherToken = env.PI_CLOUD_HOSTED_DISPATCHER_TOKEN ?? env.PI_CLOUD_DISPATCHER_TOKEN;
  if (!dispatcherToken) throw new Error("Missing PI_CLOUD_HOSTED_DISPATCHER_TOKEN or PI_CLOUD_DISPATCHER_TOKEN for the hosted runner process");

  const configuredReferenceNames = parseCredentialReferenceNames(
    env.PI_CLOUD_SMOKE_CREDENTIAL_REFERENCE_NAMES,
    env.PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES,
  );
  const hostedCredentialsJson = env.PI_CLOUD_HOSTED_CREDENTIALS;
  const hostedCredentialValues = parseHostedCredentialValues(hostedCredentialsJson, configuredReferenceNames);
  const runnerDispatcherUrl = parseUrl(env.PI_CLOUD_HOSTED_DISPATCHER_URL ?? apiBaseUrl.toString(), "PI_CLOUD_HOSTED_DISPATCHER_URL");

  return {
    apiBaseUrl,
    runnerDispatcherUrl,
    repositoryUrl,
    revision,
    projectTrust: env.PI_CLOUD_SMOKE_PROJECT_TRUST === "trusted" ? "trusted" : "untrusted",
    prompt: env.PI_CLOUD_SMOKE_PROMPT ?? defaultPrompt,
    userToken,
    dispatcherToken,
    runnerIdBase: env.PI_CLOUD_RUNNER_ID ?? `smoke-hosted-${process.pid}`,
    workspaceRoots: env.PI_CLOUD_HOSTED_WORKSPACE_ROOTS ?? env.PI_CLOUD_RUNTIME_WORKSPACE_ROOT ?? "/var/lib/pi-cloud/workspaces",
    sessionRoots: env.PI_CLOUD_HOSTED_SESSION_ROOTS ?? env.PI_CLOUD_RUNTIME_WORKSPACE_ROOT ?? "/var/lib/pi-cloud/workspaces",
    agentRoots: env.PI_CLOUD_HOSTED_AGENT_ROOTS ?? env.PI_CLOUD_RUNTIME_AGENT_DIRECTORY ?? "/var/lib/pi-cloud/agent",
    hostedCredentialsJson,
    hostedCredentialValues,
    credentialReferenceNames: configuredReferenceNames,
    piExecutable: env.PI_CLOUD_PI_EXECUTABLE ?? "pi",
    secrets: [userToken, dispatcherToken, ...hostedCredentialValues],
  };
}

function firstApiCredentialToken(value) {
  if (!value) {
    throw new Error("Missing PI_CLOUD_SMOKE_USER_TOKEN and PI_CLOUD_API_CREDENTIALS; set one API bearer token for the public smoke client");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PI_CLOUD_API_CREDENTIALS must be valid JSON or PI_CLOUD_SMOKE_USER_TOKEN must be set explicitly");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0]?.token !== "string" || parsed[0].token.length === 0) {
    throw new Error("PI_CLOUD_API_CREDENTIALS must contain at least one { token } entry or PI_CLOUD_SMOKE_USER_TOKEN must be set explicitly");
  }
  return parsed[0].token;
}

function parseCredentialReferenceNames(explicitValue, configuredValue) {
  if (explicitValue) return parseNameList(explicitValue, "PI_CLOUD_SMOKE_CREDENTIAL_REFERENCE_NAMES");
  if (!configuredValue) return [];
  let parsed;
  try {
    parsed = JSON.parse(configuredValue);
  } catch {
    throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES must be valid JSON if PI_CLOUD_SMOKE_CREDENTIAL_REFERENCE_NAMES is omitted");
  }
  if (!Array.isArray(parsed)) throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES must be a JSON array");
  return parsed.map((entry) => {
    if (typeof entry?.name !== "string" || entry.name.length === 0) {
      throw new Error("PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES entries must include a non-empty name");
    }
    return entry.name;
  });
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

function parseHostedCredentialValues(value, referenceNames) {
  if (referenceNames.length === 0) return [];
  if (!value) {
    throw new Error(
      `Missing PI_CLOUD_HOSTED_CREDENTIALS for requested hosted credential references: ${referenceNames.join(", ")}`,
    );
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
  return Object.values(parsed).filter((entry) => typeof entry === "string" && entry.length > 0);
}

async function assertBuiltRunner() {
  await assertPathExists(runnerEntry, "built hosted runner entrypoint");
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

async function checkApiHealth(apiBaseUrl) {
  const response = await fetch(new URL("/health", apiBaseUrl));
  if (!response.ok) throw new Error(`API health check failed with ${response.status}`);
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

class RunnerProcess {
  constructor(config, suffix) {
    this.secrets = config.secrets;
    this.stdout = "";
    this.stderr = "";
    this.exitInfo = undefined;
    const childEnvironment = {
      ...process.env,
      PATH: joinPath(nodeModulesBin, process.env.PATH ?? ""),
      PI_CLOUD_HOSTED_DISPATCHER_URL: config.runnerDispatcherUrl.toString(),
      PI_CLOUD_HOSTED_DISPATCHER_TOKEN: config.dispatcherToken,
      PI_CLOUD_RUNNER_ID: `${config.runnerIdBase}-${suffix}`,
      PI_CLOUD_HOSTED_WORKSPACE_ROOTS: config.workspaceRoots,
      PI_CLOUD_HOSTED_SESSION_ROOTS: config.sessionRoots,
      PI_CLOUD_HOSTED_AGENT_ROOTS: config.agentRoots,
      ...(config.hostedCredentialsJson ? { PI_CLOUD_HOSTED_CREDENTIALS: config.hostedCredentialsJson } : {}),
      ...(config.piExecutable ? { PI_CLOUD_PI_EXECUTABLE: config.piExecutable } : {}),
    };
    this.child = spawn(process.execPath, [runnerEntry], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => { this.stdout += chunk; });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
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

class HostedClientConnection {
  constructor(socket, sessionId, secrets) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.secrets = secrets;
    this.sequence = 0;
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

async function promptAndWait(client, sessionId, prompt, timeoutMs) {
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
    if (sawMessageEnd && sawSettled) return { messageText };
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

function joinPath(prefix, existing) {
  return existing ? `${prefix}${delimiter}${existing}` : prefix;
}

async function readIncomingMessage(stream) {
  let body = "";
  for await (const chunk of stream) body += chunk;
  return body || stream.statusMessage || "no response body";
}

function redact(text, secrets) {
  return secrets.filter(Boolean).reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

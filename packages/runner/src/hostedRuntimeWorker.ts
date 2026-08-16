import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import {
  hostedRuntimeClaimSchema,
  parseBoundedHostedRpcClientEnvelope,
  parseBoundedHostedRpcEnvelope,
  type HostedRuntimeClaim,
  type HostedRuntimeLaunch,
  type PiRpcRecord,
} from "@pi-cloud/contracts";
import { z } from "zod";
import WebSocket, { type RawData } from "ws";
import { checkoutExactRevision } from "./checkout.js";
import {
  authorizeHostedRuntimeRealPaths,
  nativeSessionDirectory,
  runtimeHomeDirectory,
  type HostedRuntimeAuthorizedRoots,
} from "./pathAuthorization.js";
import { PiRpcSupervisor } from "./piRpcSupervisor.js";
import {
  applyWorkspaceOwnership,
  killWorkspaceProcesses,
  prepareIsolatedWorkspace,
  type RuntimeProcessIdentity,
} from "./workspaceIdentity.js";

const execFileAsync = promisify(execFile);
const stopControlSchema = z
  .object({
    type: z.enum(["stop", "pi_cloud_stop"]),
  })
  .strict();

type ResolvedHostedCredentials = {
  environment: Record<string, string>;
  secrets: string[];
};
export interface HostedRuntimeDispatcher {
  claim(runnerId: string): Promise<HostedRuntimeClaim | null>;
}

export type HostedRuntimeWorkerOptions = {
  dispatcher: HostedRuntimeDispatcher;
  runnerId: string;
  authorizedRoots: HostedRuntimeAuthorizedRoots;
  piExecutable?: string;
  processIsolation?: "inherit" | "workspace_uid";
  checkout?: typeof checkoutExactRevision;
  createWebSocket?: (url: string, token: string) => WebSocket;
  signal?: AbortSignal;
};

/** Claims one hosted runtime using dispatcher authority, returning null when the queue is empty. */
export class HostedRuntimeDispatcherClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly dispatcherToken: string,
    private readonly http: typeof fetch = fetch,
    private readonly claimPath = "/internal/v1/hosted-runtimes/claim",
  ) {}

  async claim(runnerId: string): Promise<HostedRuntimeClaim | null> {
    const response = await this.http(new URL(this.claimPath, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.dispatcherToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runnerId }),
    });
    if (response.status === 204) return null;
    if (!response.ok) {
      const diagnostic = await safeClaimError(response);
      throw new Error(`Hosted runtime claim failed with ${response.status}${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    return hostedRuntimeClaimSchema.parse(await response.json());
  }
}

/** Runs one claimed hosted session and preserves its workspace and native session on every exit path. */
export async function runHostedRuntimeWorker(options: HostedRuntimeWorkerOptions): Promise<boolean> {
  const claim = await options.dispatcher.claim(options.runnerId);
  if (!claim) return false;

  const launch = claim.launch;
  let credentials: ResolvedHostedCredentials;
  try {
    credentials = resolveClaimCredentials(claim);
  } finally {
    scrubClaimCredentials(claim);
  }
  let processIdentity: RuntimeProcessIdentity | undefined;
  try {
    options.signal?.throwIfAborted();
    await authorizeHostedRuntimeRealPaths(launch, options.authorizedRoots);
    if (options.processIsolation === "workspace_uid") processIdentity = await prepareIsolatedWorkspace(launch);
  } catch (error: unknown) {
    scrubResolvedCredentials(credentials);
    throw error;
  }

  let socket: WebSocket;
  try {
    socket = (options.createWebSocket ?? createAuthenticatedWebSocket)(claim.tunnel.url, claim.tunnel.token);
    await waitForOpen(socket, options.signal);
  } catch (error: unknown) {
    scrubResolvedCredentials(credentials);
    throw error;
  }

  let outboundSequence = 0;
  let outboundCumulativeBytes = 0;
  let inboundCumulativeBytes = 0;
  let lastInboundSequence = 0;
  let stopRequested = false;
  let supervisor: PiRpcSupervisor | undefined;
  let resolveTunnel!: () => void;
  let rejectTunnel!: (error: Error) => void;
  const tunnelFinished = new Promise<void>((resolve, reject) => {
    resolveTunnel = resolve;
    rejectTunnel = reject;
  });
  const handleTunnelMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      rejectTunnel(new Error("Hosted runtime tunnel does not accept binary messages"));
      return;
    }
    try {
      const raw = rawDataToBuffer(data);
      if (raw.byteLength > launch.limits.maxRecordBytes) throw new Error("Tunnel record exceeds maxRecordBytes");
      const value = JSON.parse(raw.toString("utf8")) as unknown;
      const stop = stopControlSchema.safeParse(value);
      if (!supervisor) {
        if (!stop.success) throw new Error("Hosted runtime received RPC traffic before Pi supervision started");
        stopRequested = true;
        return;
      }
      if (stop.success) {
        stopRequested = true;
        void supervisor.cancel().then(resolveTunnel, rejectTunnel);
        return;
      }
      const bounded = parseBoundedHostedRpcClientEnvelope(value, {
        maxRecordBytes: launch.limits.maxRecordBytes,
        maxCumulativeBytes: launch.limits.maxCumulativeBytes,
        cumulativeBytes: inboundCumulativeBytes,
      }, raw.byteLength);
      inboundCumulativeBytes = bounded.cumulativeBytes;
      if (bounded.envelope.hostedSessionId !== launch.hostedSessionId) {
        throw new Error("RPC envelope is for a different hosted session");
      }
      if (bounded.envelope.sequence !== lastInboundSequence + 1) {
        throw new Error("RPC envelope sequence is not contiguous");
      }
      lastInboundSequence = bounded.envelope.sequence;
      supervisor.send(bounded.envelope.record);
    } catch (error: unknown) {
      rejectTunnel(error instanceof Error ? error : new Error(String(error)));
    }
  };
  socket.on("message", handleTunnelMessage);
  socket.once("error", (error) => rejectTunnel(error));
  socket.once("close", () => {
    if (!stopRequested) rejectTunnel(new Error("Hosted runtime tunnel closed unexpectedly"));
  });
  void tunnelFinished.catch(() => undefined);

  const heartbeatTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pi_cloud_runtime_heartbeat" }));
  }, 15_000);
  heartbeatTimer.unref();

  try {
    const checkedOut = await materializeRepository(launch, options.checkout ?? checkoutExactRevision, processIdentity, options.signal);
    if (processIdentity && checkedOut) await applyWorkspaceOwnership(launch, processIdentity);
    supervisor = new PiRpcSupervisor({
      launch,
      piExecutable: options.piExecutable,
      credentialEnvironment: credentials.environment,
      configuredSecrets: [...credentials.secrets, ...Object.values(credentials.environment)],
      processIdentity,
      onRecord: (record) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          validateNativeSessionRecord(launch, record);
        } catch {
          socket.close(1008, "native session path rejected");
          return;
        }
        const envelope = {
          version: 1 as const,
          hostedSessionId: launch.hostedSessionId,
          direction: "pi_to_client" as const,
          sequence: ++outboundSequence,
          record,
        };
        try {
          const serialized = JSON.stringify(envelope);
          const bounded = parseBoundedHostedRpcEnvelope(envelope, {
            maxRecordBytes: launch.limits.maxRecordBytes,
            maxCumulativeBytes: launch.limits.maxCumulativeBytes,
            cumulativeBytes: outboundCumulativeBytes,
          }, Buffer.byteLength(serialized, "utf8"));
          outboundCumulativeBytes = bounded.cumulativeBytes;
          socket.send(serialized);
        } catch {
          socket.close(1009, "outbound RPC limit exceeded");
        }
      },
    });
  } catch (error: unknown) {
    clearInterval(heartbeatTimer);
    scrubResolvedCredentials(credentials);
    if (processIdentity) await killWorkspaceProcesses(processIdentity);
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "runtime startup failed");
    throw error;
  }

  const abortRuntime = () => {
    stopRequested = true;
    void supervisor?.cancel();
  };
  options.signal?.addEventListener("abort", abortRuntime, { once: true });
  if (options.signal?.aborted) abortRuntime();

  try {
    await supervisor.started;
    if (stopRequested) {
      await supervisor.cancel();
      return true;
    }
    socket.send(JSON.stringify({ type: "pi_cloud_runtime_ready" }));
    supervisor.send({ type: "get_state", id: "pi-cloud-internal-startup-state" });
    await Promise.race([supervisor.completed, tunnelFinished]);
    return true;
  } finally {
    stopRequested = true;
    clearInterval(heartbeatTimer);
    options.signal?.removeEventListener("abort", abortRuntime);
    await supervisor.cancel().catch(() => undefined);
    if (processIdentity) await killWorkspaceProcesses(processIdentity);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "runtime stopped");
    scrubResolvedCredentials(credentials);
  }
}

/** Creates the production tunnel with its scoped bearer credential in the WebSocket handshake only. */
export function createAuthenticatedWebSocket(url: string, token: string): WebSocket {
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && isLocalDevelopmentHost(parsed.hostname))) {
    throw new Error("Hosted runtime tunnel must use WSS or local development WS");
  }
  return new WebSocket(parsed, { headers: { authorization: `Bearer ${token}` } });
}

async function materializeRepository(
  launch: HostedRuntimeLaunch,
  checkout: typeof checkoutExactRevision,
  processIdentity?: RuntimeProcessIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  const gitDirectory = `${launch.workspaceRoot}/.git`;
  let existingRepository = false;
  try {
    const stats = await fs.stat(gitDirectory);
    if (!stats.isDirectory()) throw new Error("Persistent workspace .git is not a directory");
    existingRepository = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existingRepository) {
    const gitOptions = {
      shell: false as const,
      timeout: 30_000,
      env: isolatedGitEnvironment(launch),
      signal,
      ...(processIdentity ?? {}),
    };
    const safeGit = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper="];
    const [{ stdout }, { stdout: remoteUrl }] = await Promise.all([
      execFileAsync("git", [...safeGit, "-C", launch.workspaceRoot, "rev-parse", "HEAD"], gitOptions),
      execFileAsync("git", [...safeGit, "-C", launch.workspaceRoot, "remote", "get-url", "origin"], gitOptions),
    ]);
    if (stdout.trim().toLowerCase() !== launch.repository.revision) {
      throw new Error("Persistent workspace revision does not match hosted runtime launch");
    }
    if (new URL(remoteUrl.trim()).toString() !== launch.repository.repositoryUrl) {
      throw new Error("Persistent workspace repository does not match hosted runtime launch");
    }
    return false;
  }

  if (launch.nativeSession.kind === "resume") {
    throw new Error("Cannot resume a native Pi session without its persistent repository");
  }
  await fs.mkdir(dirname(launch.workspaceRoot), { recursive: true });
  await checkout({
    checkoutPath: launch.workspaceRoot,
    revision: launch.repository.revision,
    source: { kind: "https-url", repositoryUrl: launch.repository.repositoryUrl },
    scratchRoot: dirname(launch.workspaceRoot),
  }, { processIdentity, signal });
  return true;
}

function isolatedGitEnvironment(launch: HostedRuntimeLaunch): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: runtimeHomeDirectory(launch),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export function validateNativeSessionRecord(launch: HostedRuntimeLaunch, record: PiRpcRecord): void {
  const value = record as { id?: unknown; type?: unknown; command?: unknown; success?: unknown; data?: { sessionFile?: unknown } };
  if (value.id !== "pi-cloud-internal-startup-state") return;
  if (value.type !== "response" || value.command !== "get_state" || value.success !== true || typeof value.data?.sessionFile !== "string") {
    throw new Error("Pi returned an invalid startup state response");
  }
  const root = realpathSync(nativeSessionDirectory(launch));
  const sessionFile = realpathSync(value.data.sessionFile);
  const fromRoot = relative(root, sessionFile);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Pi native session file escapes its session directory through a symbolic link");
  }
}

function scrubResolvedCredentials(credentials: ResolvedHostedCredentials): void {
  for (const key of Object.keys(credentials.environment)) credentials.environment[key] = "";
  credentials.secrets.fill("");
}

function resolveClaimCredentials(claim: HostedRuntimeClaim): ResolvedHostedCredentials {
  const values = new Map(claim.credentials.map((credential) => [credential.reference, credential.value]));
  const environment: Record<string, string> = {};
  for (const credential of claim.launch.credentialReferences) {
    const value = values.get(credential.reference);
    if (!value) throw new Error(`Claim credential ${credential.reference} is unavailable`);
    environment[credential.environmentVariable] = value;
  }
  return { environment, secrets: [...values.values()] };
}

function scrubClaimCredentials(claim: HostedRuntimeClaim): void {
  for (const credential of claim.credentials) credential.value = "";
}

function waitForOpen(socket: WebSocket, signal?: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    if (!signal?.aborted) return Promise.resolve();
    socket.terminate();
    return Promise.reject(signal.reason ?? new Error("Hosted runtime startup aborted"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      socket.once("error", () => undefined);
      socket.terminate();
      reject(signal?.reason ?? new Error("Hosted runtime startup aborted"));
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function safeClaimError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 4_096);
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    const message = typeof parsed.message === "string" ? parsed.message : undefined;
    return [code, message].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "host.docker.internal"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

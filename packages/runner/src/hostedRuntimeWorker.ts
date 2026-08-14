import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
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
import { authorizeHostedRuntimeRealPaths, type HostedRuntimeAuthorizedRoots } from "./pathAuthorization.js";
import { PiRpcSupervisor } from "./piRpcSupervisor.js";
import { prepareIsolatedWorkspace, type RuntimeProcessIdentity } from "./workspaceIdentity.js";

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
    if (!response.ok) throw new Error(`Hosted runtime claim failed with ${response.status}`);
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
    await authorizeHostedRuntimeRealPaths(launch, options.authorizedRoots);
    await materializeRepository(launch, options.checkout ?? checkoutExactRevision);
    if (options.processIsolation === "workspace_uid") {
      processIdentity = await prepareIsolatedWorkspace(launch);
    }
  } catch (error: unknown) {
    scrubResolvedCredentials(credentials);
    throw error;
  }

  let socket: WebSocket;
  try {
    socket = (options.createWebSocket ?? createAuthenticatedWebSocket)(claim.tunnel.url, claim.tunnel.token);
    await waitForOpen(socket);
  } catch (error: unknown) {
    scrubResolvedCredentials(credentials);
    throw error;
  }
  let outboundSequence = 0;
  let outboundCumulativeBytes = 0;
  let inboundCumulativeBytes = 0;
  let lastInboundSequence = 0;
  let stopRequested = false;

  let supervisor: PiRpcSupervisor;
  try {
    supervisor = new PiRpcSupervisor({
      launch,
      piExecutable: options.piExecutable,
      credentialEnvironment: credentials.environment,
      configuredSecrets: [...credentials.secrets, ...Object.values(credentials.environment)],
      processIdentity,
      onRecord: (record) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const envelope = {
          version: 1 as const,
          hostedSessionId: launch.hostedSessionId,
          direction: "pi_to_client" as const,
          sequence: ++outboundSequence,
          record,
        };
        try {
          const bounded = parseBoundedHostedRpcEnvelope(envelope, {
            maxRecordBytes: launch.limits.maxRecordBytes,
            maxCumulativeBytes: launch.limits.maxCumulativeBytes,
            cumulativeBytes: outboundCumulativeBytes,
          });
          outboundCumulativeBytes = bounded.cumulativeBytes;
          socket.send(JSON.stringify(bounded.envelope));
        } catch {
          socket.close(1009, "outbound RPC limit exceeded");
        }
      },
    });
  } catch (error: unknown) {
    scrubResolvedCredentials(credentials);
    if (socket.readyState === WebSocket.OPEN) socket.close(1011, "runtime startup failed");
    throw error;
  }

  const abortRuntime = () => {
    stopRequested = true;
    void supervisor.cancel();
  };
  options.signal?.addEventListener("abort", abortRuntime, { once: true });
  if (options.signal?.aborted) abortRuntime();

  const tunnelFinished = new Promise<void>((resolve, reject) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        reject(new Error("Hosted runtime tunnel does not accept binary messages"));
        return;
      }
      try {
        const raw = rawDataToBuffer(data);
        if (raw.byteLength > launch.limits.maxRecordBytes) throw new Error("Tunnel record exceeds maxRecordBytes");
        inboundCumulativeBytes += raw.byteLength;
        if (inboundCumulativeBytes > launch.limits.maxCumulativeBytes) {
          throw new Error("Tunnel records exceed maxCumulativeBytes");
        }
        const value = JSON.parse(raw.toString("utf8")) as unknown;
        const stop = stopControlSchema.safeParse(value);
        if (stop.success) {
          stopRequested = true;
          void supervisor.cancel().then(resolve, reject);
          return;
        }
        const bounded = parseBoundedHostedRpcClientEnvelope(value, {
          maxRecordBytes: launch.limits.maxRecordBytes,
          maxCumulativeBytes: launch.limits.maxCumulativeBytes,
          cumulativeBytes: 0,
        });
        if (bounded.envelope.hostedSessionId !== launch.hostedSessionId) {
          throw new Error("RPC envelope is for a different hosted session");
        }
        if (bounded.envelope.sequence !== lastInboundSequence + 1) {
          throw new Error("RPC envelope sequence is not contiguous");
        }
        lastInboundSequence = bounded.envelope.sequence;
        supervisor.send(bounded.envelope.record);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (!stopRequested) reject(new Error("Hosted runtime tunnel closed unexpectedly"));
    });
  });

  try {
    await supervisor.started;
    socket.send(JSON.stringify({ type: "pi_cloud_runtime_ready" }));
    supervisor.send({ type: "get_state", id: "pi-cloud-internal-startup-state" });
    await Promise.race([supervisor.completed, tunnelFinished]);
    return true;
  } finally {
    options.signal?.removeEventListener("abort", abortRuntime);
    await supervisor.cancel().catch(() => undefined);
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
): Promise<void> {
  const gitDirectory = `${launch.workspaceRoot}/.git`;
  try {
    const stats = await fs.stat(gitDirectory);
    if (!stats.isDirectory()) throw new Error("Persistent workspace .git is not a directory");
    const [{ stdout }, { stdout: remoteUrl }] = await Promise.all([
      execFileAsync("git", ["-C", launch.workspaceRoot, "rev-parse", "HEAD"], { shell: false, timeout: 30_000 }),
      execFileAsync("git", ["-C", launch.workspaceRoot, "remote", "get-url", "origin"], { shell: false, timeout: 30_000 }),
    ]);
    if (stdout.trim().toLowerCase() !== launch.repository.revision) {
      throw new Error("Persistent workspace revision does not match hosted runtime launch");
    }
    if (new URL(remoteUrl.trim()).toString() !== launch.repository.repositoryUrl) {
      throw new Error("Persistent workspace repository does not match hosted runtime launch");
    }
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  });
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

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
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

import {
  hostedRpcClientEnvelopeSchema,
  hostedRpcEnvelopeSchema,
  type HostedRpcClientEnvelope,
  type HostedRpcEnvelope,
  type HostedRuntimeLimits,
} from "@pi-cloud/contracts";
import { z } from "zod";
import type { default as WebSocket, RawData } from "ws";
import { isContainedPath, newSessionDirectoryFor } from "./hostedPaths.js";
import type { ControlPlaneStore } from "./store.js";

const startupStateRequestId = "pi-cloud-internal-startup-state";
const stopControlMessage = JSON.stringify({ type: "pi_cloud_stop" });
const runtimeControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pi_cloud_runtime_ready") }).strict(),
  z.object({ type: z.literal("pi_cloud_runtime_heartbeat") }).strict(),
]);
const websocketOpen = 1;

const startupStateResponseSchema = z
  .object({
    id: z.literal(startupStateRequestId),
    type: z.literal("response"),
    command: z.literal("get_state"),
    success: z.literal(true),
    data: z.object({ sessionId: z.string().min(1), sessionFile: z.string().min(1) }).catchall(z.unknown()),
  })
  .catchall(z.unknown());

/** Stable application close codes so every routing failure has one documented, testable cause. */
export const hostedPolicyCloseCodes = {
  invalidEnvelope: 4400,
  crossSession: 4404,
  sequenceGap: 4409,
  duplicateClient: 4408,
  budgetExceeded: 4413,
  runtimeDisconnected: 4410,
} as const;

type RuntimeConnection = {
  sessionId: string;
  assignmentId: string;
  workspaceRoot: string;
  limits: HostedRuntimeLimits;
  socket: WebSocket;
  outboundSequence: number;
  outboundCumulativeBytes: number;
  inboundSequence: number;
  inboundCumulativeBytes: number;
  lastHeartbeatAt: number;
  heartbeatTimer?: NodeJS.Timeout;
  client?: ClientConnection;
};

type ClientConnection = {
  socket: WebSocket;
  outboundSequence: number;
  outboundCumulativeBytes: number;
  inboundSequence: number;
  inboundCumulativeBytes: number;
};

type EnvelopeOutcome<T> =
  | { ok: true; envelope: T; bytes: number }
  | { ok: false; code: number; reason: string };

/**
 * Routes complete JSON hosted-RPC envelopes in memory between one persistent runtime tunnel and at
 * most one attached public client per hosted session, without interpreting Pi semantics. All state
 * here is ephemeral: an API restart drops every in-flight connection, and no transcript is persisted.
 */
export class HostedRpcRouter {
  private readonly runtimes = new Map<string, RuntimeConnection>();
  private closed = false;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly heartbeatTimeoutMs = 60_000,
  ) {}

  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  hasActiveClient(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.client !== undefined;
  }

  /** Closes ephemeral tunnels while preserving a durable stopped state before the store is closed. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const runtime of this.runtimes.values()) {
      clearInterval(runtime.heartbeatTimer);
      this.store.markHostedSessionStoppedByRuntime(runtime.sessionId, this.clock());
      closeIfOpen(runtime.client?.socket, hostedPolicyCloseCodes.runtimeDisconnected, "API shutting down");
      closeIfOpen(runtime.socket, 1001, "API shutting down");
    }
    this.runtimes.clear();
  }

  /** Sends the out-of-band stop control that is not itself a sequenced hosted-RPC envelope. */
  sendStopControl(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (runtime && runtime.socket.readyState === websocketOpen) runtime.socket.send(stopControlMessage);
  }

  /** Closes runtime tunnels that stopped sending authenticated activity or heartbeat controls. */
  sweepRuntimeHeartbeats(): void {
    const now = this.clock().getTime();
    for (const runtime of this.runtimes.values()) {
      if (now - runtime.lastHeartbeatAt <= this.heartbeatTimeoutMs) continue;
      this.runtimes.delete(runtime.sessionId);
      clearInterval(runtime.heartbeatTimer);
      this.store.markHostedSessionStoppedByRuntime(runtime.sessionId, this.clock());
      closeIfOpen(runtime.client?.socket, hostedPolicyCloseCodes.runtimeDisconnected, "hosted runtime heartbeat expired");
      closeIfOpen(runtime.socket, hostedPolicyCloseCodes.runtimeDisconnected, "hosted runtime heartbeat expired");
    }
  }

  /** Registers a claimed runtime's tunnel connection and marks the hosted session running. */
  attachRuntime(options: {
    sessionId: string;
    assignmentId: string;
    workspaceRoot: string;
    limits: HostedRuntimeLimits;
    socket: WebSocket;
  }): void {
    if (this.closed) {
      closeIfOpen(options.socket, 1012, "API shutting down");
      return;
    }
    if (this.runtimes.has(options.sessionId)) {
      closeIfOpen(options.socket, hostedPolicyCloseCodes.duplicateClient, "hosted runtime already connected");
      return;
    }
    const runtime: RuntimeConnection = {
      sessionId: options.sessionId,
      assignmentId: options.assignmentId,
      workspaceRoot: options.workspaceRoot,
      limits: options.limits,
      socket: options.socket,
      outboundSequence: 0,
      outboundCumulativeBytes: 0,
      inboundSequence: 0,
      inboundCumulativeBytes: 0,
      lastHeartbeatAt: this.clock().getTime(),
    };
    runtime.heartbeatTimer = setInterval(
      () => this.sweepRuntimeHeartbeats(),
      Math.max(1_000, Math.floor(this.heartbeatTimeoutMs / 2)),
    );
    runtime.heartbeatTimer.unref();
    this.runtimes.set(options.sessionId, runtime);

    options.socket.on("message", (data, isBinary) => {
      this.onRuntimeMessage(runtime, data, isBinary);
    });
    options.socket.once("close", () => {
      if (this.runtimes.get(options.sessionId) !== runtime) return;
      clearInterval(runtime.heartbeatTimer);
      this.runtimes.delete(options.sessionId);
      if (!this.closed) {
        this.store.markHostedSessionStoppedByRuntime(options.sessionId, this.clock());
        closeIfOpen(runtime.client?.socket, hostedPolicyCloseCodes.runtimeDisconnected, "hosted runtime disconnected");
      }
    });
    options.socket.on("error", () => undefined);
  }

  /** Registers the single active public client permitted to mutate a hosted session. */
  attachClient(sessionId: string, socket: WebSocket): void {
    if (this.closed) {
      closeIfOpen(socket, 1012, "API shutting down");
      return;
    }
    const attachedRuntime = this.runtimes.get(sessionId);
    if (!attachedRuntime || attachedRuntime.client) {
      closeIfOpen(socket, hostedPolicyCloseCodes.duplicateClient, "hosted session already has an active client");
      return;
    }
    const client: ClientConnection = {
      socket,
      outboundSequence: 0,
      outboundCumulativeBytes: 0,
      inboundSequence: 0,
      inboundCumulativeBytes: 0,
    };
    attachedRuntime.client = client;

    socket.on("message", (data, isBinary) => {
      const current = this.runtimes.get(sessionId);
      if (!current || current.client !== client) return;
      this.onClientMessage(current, client, data, isBinary);
    });
    socket.once("close", () => {
      const current = this.runtimes.get(sessionId);
      if (current?.client === client) current.client = undefined;
    });
    socket.on("error", () => undefined);
  }

  private touchRuntime(runtime: RuntimeConnection): void {
    runtime.lastHeartbeatAt = this.clock().getTime();
    this.store.touchAssignmentHeartbeat(runtime.assignmentId, this.clock());
  }

  private onRuntimeMessage(runtime: RuntimeConnection, data: RawData, isBinary: boolean): void {
    if (!isBinary) {
      const buffer = toBuffer(data);
      if (buffer.byteLength <= runtime.limits.maxRecordBytes) {
        try {
          const control = runtimeControlSchema.safeParse(JSON.parse(buffer.toString("utf8")));
          if (control.success) {
            this.touchRuntime(runtime);
            if (control.data.type === "pi_cloud_runtime_ready") {
              this.store.markHostedSessionRunning(runtime.sessionId, this.clock());
            }
            return;
          }
        } catch {
          // Normal envelope parsing below returns the stable malformed-message policy error.
        }
      }
    }
    const outcome = parseInboundEnvelope({
      data,
      isBinary,
      schema: hostedRpcEnvelopeSchema,
      direction: "pi_to_client",
      sessionId: runtime.sessionId,
      expectedSequence: runtime.inboundSequence,
      cumulativeBytes: runtime.inboundCumulativeBytes,
      limits: runtime.limits,
    });
    if (!outcome.ok) {
      closeIfOpen(runtime.socket, outcome.code, outcome.reason);
      return;
    }
    runtime.inboundSequence += 1;
    runtime.inboundCumulativeBytes += outcome.bytes;
    this.touchRuntime(runtime);

    if (this.interceptStartupState(runtime, outcome.envelope)) return;
    this.forwardToClient(runtime, outcome.envelope);
  }

  private onClientMessage(runtime: RuntimeConnection, client: ClientConnection, data: RawData, isBinary: boolean): void {
    const outcome = parseInboundEnvelope({
      data,
      isBinary,
      schema: hostedRpcClientEnvelopeSchema,
      direction: "client_to_pi",
      sessionId: runtime.sessionId,
      expectedSequence: client.inboundSequence,
      cumulativeBytes: client.inboundCumulativeBytes,
      limits: runtime.limits,
    });
    if (!outcome.ok) {
      closeIfOpen(client.socket, outcome.code, outcome.reason);
      return;
    }
    client.inboundSequence += 1;
    client.inboundCumulativeBytes += outcome.bytes;
    this.forwardToRuntime(runtime, outcome.envelope);
    this.store.touchAssignmentHeartbeat(runtime.assignmentId, this.clock());
  }

  /** Recognizes only the runner's reserved startup probe; every other record routes unchanged. */
  private interceptStartupState(runtime: RuntimeConnection, envelope: HostedRpcEnvelope): boolean {
    if ((envelope.record as { id?: unknown }).id !== startupStateRequestId) return false;

    const parsed = startupStateResponseSchema.safeParse(envelope.record);
    if (!parsed.success) {
      closeIfOpen(runtime.socket, hostedPolicyCloseCodes.invalidEnvelope, "invalid native session startup response");
      return true;
    }

    const sessionRoot = newSessionDirectoryFor(runtime.workspaceRoot, runtime.sessionId);
    if (!isContainedPath(sessionRoot, parsed.data.data.sessionFile)) {
      closeIfOpen(runtime.socket, hostedPolicyCloseCodes.invalidEnvelope, "native session file escapes the configured session root");
      return true;
    }
    const recorded = this.store.recordNativeSessionMetadata(
      runtime.sessionId,
      parsed.data.data.sessionId,
      parsed.data.data.sessionFile,
      this.clock(),
    );
    if (!recorded) {
      closeIfOpen(runtime.socket, hostedPolicyCloseCodes.invalidEnvelope, "native session identity changed across runtime restart");
    }
    return true;
  }

  private forwardToClient(runtime: RuntimeConnection, envelope: HostedRpcEnvelope): void {
    const client = runtime.client;
    if (!client) return;
    const outbound: HostedRpcEnvelope = {
      version: 1,
      hostedSessionId: runtime.sessionId,
      direction: "pi_to_client",
      sequence: client.outboundSequence + 1,
      record: envelope.record,
    };
    const bytes = Buffer.byteLength(JSON.stringify(outbound), "utf8");
    if (!withinBudget(runtime.limits, bytes, client.outboundCumulativeBytes)) {
      closeIfOpen(client.socket, hostedPolicyCloseCodes.budgetExceeded, "outbound RPC limit exceeded");
      return;
    }
    client.outboundSequence += 1;
    client.outboundCumulativeBytes += bytes;
    if (client.socket.readyState === websocketOpen) client.socket.send(JSON.stringify(outbound));
  }

  private forwardToRuntime(runtime: RuntimeConnection, envelope: HostedRpcClientEnvelope): void {
    const outbound: HostedRpcClientEnvelope = {
      version: 1,
      hostedSessionId: runtime.sessionId,
      direction: "client_to_pi",
      sequence: runtime.outboundSequence + 1,
      record: envelope.record,
    };
    const bytes = Buffer.byteLength(JSON.stringify(outbound), "utf8");
    if (!withinBudget(runtime.limits, bytes, runtime.outboundCumulativeBytes)) {
      closeIfOpen(runtime.socket, hostedPolicyCloseCodes.budgetExceeded, "inbound RPC limit exceeded");
      return;
    }
    runtime.outboundSequence += 1;
    runtime.outboundCumulativeBytes += bytes;
    if (runtime.socket.readyState === websocketOpen) runtime.socket.send(JSON.stringify(outbound));
  }
}

function parseInboundEnvelope<T>(params: {
  data: RawData;
  isBinary: boolean;
  schema: z.ZodType<T>;
  direction: "client_to_pi" | "pi_to_client";
  sessionId: string;
  expectedSequence: number;
  cumulativeBytes: number;
  limits: HostedRuntimeLimits;
}): EnvelopeOutcome<T> {
  if (params.isBinary) {
    return { ok: false, code: hostedPolicyCloseCodes.invalidEnvelope, reason: "binary frames are not supported" };
  }
  const buffer = toBuffer(params.data);
  if (buffer.byteLength > params.limits.maxRecordBytes) {
    return { ok: false, code: hostedPolicyCloseCodes.budgetExceeded, reason: "RPC envelope exceeds maxRecordBytes" };
  }
  if (params.cumulativeBytes + buffer.byteLength > params.limits.maxCumulativeBytes) {
    return { ok: false, code: hostedPolicyCloseCodes.budgetExceeded, reason: "RPC envelopes exceed maxCumulativeBytes" };
  }

  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    return { ok: false, code: hostedPolicyCloseCodes.invalidEnvelope, reason: "message is not valid JSON" };
  }
  let parsed: z.ZodSafeParseResult<T>;
  try {
    parsed = params.schema.safeParse(value);
  } catch {
    return { ok: false, code: hostedPolicyCloseCodes.invalidEnvelope, reason: "message exceeds hosted RPC structural limits" };
  }
  if (!parsed.success) {
    return { ok: false, code: hostedPolicyCloseCodes.invalidEnvelope, reason: "message does not match the hosted RPC envelope schema" };
  }
  const envelope = parsed.data as HostedRpcEnvelope | HostedRpcClientEnvelope;
  if (envelope.direction !== params.direction) {
    return { ok: false, code: hostedPolicyCloseCodes.invalidEnvelope, reason: "envelope direction does not match this channel" };
  }
  if (envelope.hostedSessionId !== params.sessionId) {
    return { ok: false, code: hostedPolicyCloseCodes.crossSession, reason: "envelope belongs to a different hosted session" };
  }
  if (envelope.sequence !== params.expectedSequence + 1) {
    return { ok: false, code: hostedPolicyCloseCodes.sequenceGap, reason: "envelope sequence is not strictly contiguous" };
  }
  return { ok: true, envelope: parsed.data, bytes: buffer.byteLength };
}

function withinBudget(limits: HostedRuntimeLimits, additionalBytes: number, cumulativeBytes: number): boolean {
  return additionalBytes <= limits.maxRecordBytes && cumulativeBytes + additionalBytes <= limits.maxCumulativeBytes;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function closeIfOpen(socket: WebSocket | undefined, code: number, reason: string): void {
  if (socket && socket.readyState === websocketOpen) socket.close(code, reason);
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostedRuntimeClaimSchema, hostedRuntimeLaunchSchema, type HostedRuntimeClaim } from "@pi-cloud/contracts";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import {
  createHostedSessionSchema,
  createWorkspaceSchema,
  type HostedSession,
  type Principal,
  type Workspace,
} from "./domain.js";
import { ApiError, conflict, unauthorized } from "./errors.js";
import { HostedRpcRouter } from "./hostedRpcRouter.js";
import { newSessionDirectoryFor, workspaceRootFor } from "./hostedPaths.js";
import type { ControlPlaneStore } from "./store.js";

const idempotencyKeySchema = z.string().min(8).max(200);
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
const claimRequestSchema = z.object({ runnerId: z.string().min(1).max(200) }).strict();
const clientTicketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const clientTicketLifetimeMs = 60_000;

type ClientAttachmentTicket = {
  sessionId: string;
  expiresAt: Date;
  principal: Principal;
};

/** Coordinates authenticated hosted-workspace and hosted-session lifecycle over durable metadata. */
export class HostedControlPlane {
  readonly router: HostedRpcRouter;
  private readonly clientTickets = new Map<string, ClientAttachmentTicket>();

  constructor(
    private readonly config: ApiConfig,
    private readonly store: ControlPlaneStore,
    private readonly clock: () => Date = () => new Date(),
  ) {
    store.recoverHostedSessionsAfterControlPlaneRestart(this.clock());
    this.router = new HostedRpcRouter(store, clock);
  }

  createWorkspace(principal: Principal, input: unknown, idempotencyKey: unknown) {
    const parsed = createWorkspaceSchema.parse(input);
    const credentialReferences = parsed.credentialReferenceNames.map((name) => {
      const reference = this.config.hostedCredentialReferences.find((candidate) => candidate.name === name);
      if (!reference) throw new ApiError(400, "invalid_request", `Unknown credential reference: ${name}`);
      return reference;
    });
    const workspaceId = randomUUID();
    return this.store.createWorkspace(
      principal.id,
      parsed,
      workspaceRootFor(this.config.runtimeWorkspaceRoot, workspaceId),
      this.config.runtimeAgentDirectory,
      credentialReferences,
      idempotencyKeySchema.parse(idempotencyKey),
      this.clock(),
      workspaceId,
    );
  }

  listWorkspaces(principal: Principal, query: unknown) {
    const parsed = listQuerySchema.parse(query);
    const cursor = parsed.cursor ? decodeCursor(parsed.cursor) : undefined;
    return this.store.listWorkspaces(principal.id, parsed.limit, cursor?.createdAt, cursor?.id);
  }

  getWorkspace(principal: Principal, workspaceId: string): Workspace {
    return this.store.requireWorkspace(principal.id, workspaceId);
  }

  createHostedSession(principal: Principal, workspaceId: string, input: unknown, idempotencyKey: unknown) {
    createHostedSessionSchema.parse(input ?? {});
    const workspace = this.store.requireWorkspace(principal.id, workspaceId);
    return this.store.createHostedSession(
      principal.id,
      workspaceId,
      idempotencyKeySchema.parse(idempotencyKey),
      this.clock(),
      this.router.hasRuntimeForWorkspace(workspace.root),
    );
  }

  getHostedSession(principal: Principal, sessionId: string): HostedSession {
    return this.store.requireHostedSession(principal.id, sessionId);
  }

  startHostedSession(principal: Principal, sessionId: string): HostedSession {
    if (this.router.hasRuntime(sessionId)) {
      throw conflict("session_runtime_active", "Hosted session runtime is still stopping");
    }
    return this.store.startHostedSession(principal.id, sessionId, this.clock());
  }

  stopHostedSession(principal: Principal, sessionId: string): HostedSession {
    const session = this.store.stopHostedSession(principal.id, sessionId, this.clock());
    this.router.sendStopControl(sessionId);
    return session;
  }

  archiveHostedSession(principal: Principal, sessionId: string): HostedSession {
    if (this.router.hasRuntime(sessionId)) {
      throw conflict("session_runtime_active", "Hosted session runtime is still stopping");
    }
    return this.store.archiveHostedSession(principal.id, sessionId, this.clock());
  }

  /** Issues one short-lived, single-use browser attachment ticket for a running owned session. */
  issueClientTicket(principal: Principal, sessionId: string): { ticket: string; expiresAt: string } {
    this.authorizeClientConnection(principal, sessionId);
    this.sweepClientTickets();
    for (const [digest, issued] of this.clientTickets) {
      if (issued.sessionId === sessionId) this.clientTickets.delete(digest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock().getTime() + clientTicketLifetimeMs);
    this.clientTickets.set(tokenDigest(ticket), { sessionId, expiresAt, principal });
    return { ticket, expiresAt: expiresAt.toISOString() };
  }

  /** Consumes one browser attachment ticket and rechecks session state at WebSocket upgrade time. */
  authorizeClientTicket(sessionId: string, ticket: unknown): HostedSession {
    const parsedTicket = clientTicketSchema.safeParse(ticket);
    if (!parsedTicket.success) throw unauthorized();
    const digest = tokenDigest(parsedTicket.data);
    const issued = this.clientTickets.get(digest);
    if (!issued || issued.sessionId !== sessionId) throw unauthorized();
    this.clientTickets.delete(digest);
    if (issued.expiresAt.getTime() <= this.clock().getTime()) throw unauthorized();
    return this.authorizeClientConnection(issued.principal, sessionId);
  }

  private sweepClientTickets(): void {
    const now = this.clock().getTime();
    for (const [digest, ticket] of this.clientTickets) {
      if (ticket.expiresAt.getTime() <= now) this.clientTickets.delete(digest);
    }
  }

  /** Closes ephemeral routed sockets and discards attachment tickets before the durable store is shut down. */
  close(): void {
    this.clientTickets.clear();
    this.router.close();
  }

  /** Atomically claims the oldest queued session and returns only that workspace's credential values. */
  claimHostedRuntime(input: unknown): HostedRuntimeClaim | undefined {
    const { runnerId } = claimRequestSchema.parse(input);
    const assignmentId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const claim = this.store.claimHostedRuntime(runnerId, assignmentId, tokenDigest(token), this.clock());
    if (!claim) return undefined;

    const { session, workspace } = claim;
    const launch = hostedRuntimeLaunchSchema.parse({
      version: 1,
      hostedSessionId: session.id,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      repository: { repositoryUrl: workspace.repositoryUrl, revision: workspace.revision },
      nativeSession: session.nativeSessionFile
        ? { kind: "resume", sessionFile: session.nativeSessionFile }
        : { kind: "new", sessionDirectory: newSessionDirectoryFor(workspace.root, session.id) },
      piAgentDirectory: workspace.agentDirectory,
      credentialReferences: workspace.credentialReferences,
      limits: this.config.hostedLaunchLimits,
      projectTrust: workspace.projectTrust,
    });
    const credentials = workspace.credentialReferences.map((credential) => ({
      reference: credential.reference,
      value: this.config.hostedCredentialValues[credential.reference],
    }));
    return hostedRuntimeClaimSchema.parse({
      launch,
      credentials,
      tunnel: { url: tunnelUrl(this.config.publicBaseUrl, session.id), token },
    });
  }

  /** Authorizes an internal tunnel connection by the raw assignment token presented in its bearer header. */
  authorizeRuntimeAssignment(sessionId: string, token: string) {
    const authorized = this.store.authorizeRuntimeAssignment(sessionId, tokenDigest(token), this.clock());
    if (!authorized) throw new ApiError(401, "unauthorized", "Unauthorized");
    return authorized;
  }

  /** Authorizes a public client connection: the caller must own the session, which must have a connected runtime. */
  authorizeClientConnection(principal: Principal, sessionId: string): HostedSession {
    const session = this.store.requireHostedSession(principal.id, sessionId);
    if (this.router.hasActiveClient(sessionId)) {
      throw conflict("session_already_attached", "Hosted session already has an active client connection");
    }
    if (session.state !== "running" || !this.router.hasRuntime(sessionId)) {
      throw conflict("session_not_running", "Hosted session runtime is not connected");
    }
    return session;
  }
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tunnelUrl(publicBaseUrl: string, sessionId: string): string {
  const url = new URL(`/internal/v1/hosted-sessions/${sessionId}/tunnel`, publicBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("createdAt" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      throw new Error();
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw conflict("invalid_cursor", "Pagination cursor is invalid");
  }
}

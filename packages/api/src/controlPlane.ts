import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { issueTaskLease, verifyTaskLease } from "@pi-cloud/contracts";
import { z } from "zod";
import { tokenDigest } from "./auth.js";
import type { ApiConfig } from "./config.js";
import {
  createAgentSchema,
  createFollowUpSchema,
  checkoutProvenanceSchema,
  heartbeatSchema,
  ingestRunEventSchema,
  terminalRunStatuses,
  type Principal,
} from "./domain.js";
import { conflict } from "./errors.js";
import { ControlPlaneStore, decodeListCursor } from "./store.js";

const idempotencyKeySchema = z.string().min(8).max(200);
const identifierSchema = z.string().min(1).max(200);
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

/** Coordinates authenticated lifecycle, dispatch, events, and recovery over durable metadata. */
export class ControlPlane {
  static readonly eventBatchSize = 100;
  readonly store: ControlPlaneStore;
  private readonly privateKey;
  private readonly publicKey;

  constructor(
    private readonly config: ApiConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(config.taskLeasePrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    this.publicKey = createPublicKey(this.privateKey);
    this.store = new ControlPlaneStore(config.databasePath);
  }

  close(): void {
    this.store.close();
  }

  createAgent(principal: Principal, input: unknown, idempotencyKey: unknown) {
    return this.store.createAgent(
      principal,
      createAgentSchema.parse(input),
      idempotencyKeySchema.parse(idempotencyKey),
      this.clock(),
    );
  }

  listAgents(principal: Principal, query: unknown) {
    const parsed = listQuerySchema.parse(query);
    const cursor = parsed.cursor ? decodeListCursor(parsed.cursor) : undefined;
    return this.store.listAgents(principal.id, parsed.limit, cursor?.createdAt, cursor?.id);
  }

  getAgent(principal: Principal, agentId: string) {
    const agent = this.store.requireAgent(principal.id, agentId);
    return { ...agent, runs: this.store.listRunsForAgent(principal.id, agentId) };
  }

  createFollowUp(principal: Principal, agentId: string, input: unknown, idempotencyKey: unknown) {
    const parsed = createFollowUpSchema.parse(input);
    return this.store.createFollowUp(
      principal.id,
      agentId,
      parsed.prompt,
      parsed.budgets,
      idempotencyKeySchema.parse(idempotencyKey),
      this.clock(),
    );
  }

  listRuns(principal: Principal, query: unknown) {
    const parsed = listQuerySchema.parse(query);
    const cursor = parsed.cursor ? decodeListCursor(parsed.cursor) : undefined;
    return this.store.listRuns(principal.id, parsed.limit, cursor?.createdAt, cursor?.id);
  }

  getRun(principal: Principal, runId: string) {
    const run = this.store.requireRun(principal.id, runId);
    return { ...run, transitions: this.store.getTransitions(principal.id, runId) };
  }

  cancelRun(principal: Principal, runId: string) {
    return this.store.requestCancellation(principal.id, runId, this.clock());
  }

  archiveAgent(principal: Principal, agentId: string, archived: boolean) {
    return this.store.setArchived(principal.id, agentId, archived, this.clock());
  }

  deleteAgent(principal: Principal, agentId: string): void {
    this.store.deleteAgent(principal.id, agentId);
  }

  claimRun(input: unknown): string | undefined {
    const parsed = z.object({ audience: identifierSchema, runnerId: identifierSchema }).parse(input);
    const now = this.clock();
    this.store.recover(now);
    const leaseId = randomUUID();
    const expiresAt = new Date(now.getTime() + 300_000);
    return this.store.claimRun(
      parsed.audience,
      parsed.runnerId,
      leaseId,
      expiresAt,
      now,
      (task) =>
        issueTaskLease({
          leaseId,
          taskId: task.id,
          repositoryUrl: task.repositoryUrl,
          revision: task.revision,
          issuer: this.config.taskLeaseIssuer,
          audience: parsed.audience,
          privateKey: this.privateKey,
          ttlSeconds: 300,
          now,
        }),
      tokenDigest,
    );
  }

  redeemLease(token: string, input: unknown) {
    const parsed = z.object({ runnerId: identifierSchema }).parse(input);
    const now = this.clock();
    let claims;
    try {
      const leaseId = decodeLeaseId(token);
      const expectedAudience = this.store.getLeaseAudience(leaseId);
      if (!expectedAudience) throw new Error();
      claims = verifyTaskLease(token, {
        publicKey: this.publicKey,
        issuer: this.config.taskLeaseIssuer,
        audience: expectedAudience,
        now,
      });
    } catch {
      throw conflict("lease_rejected", "Lease is stale, invalid, or already redeemed");
    }
    return this.store.redeemLease(tokenDigest(token), claims, parsed.runnerId, now);
  }

  heartbeatLease(token: string, leaseId: string, input: unknown) {
    const parsed = heartbeatSchema.parse(input);
    return this.store.heartbeat(tokenDigest(token), leaseId, parsed.consumed, this.clock());
  }

  ingestEvent(token: string, runId: string, input: unknown) {
    return this.store.ingestEvent(tokenDigest(token), runId, ingestRunEventSchema.parse(input), this.clock());
  }

  reportCheckoutProvenance(token: string, runId: string, input: unknown) {
    return this.store.recordCheckoutProvenance(
      tokenDigest(token),
      runId,
      checkoutProvenanceSchema.parse(input),
      this.clock(),
    );
  }

  listEvents(principal: Principal, runId: string, cursor?: string) {
    return this.store.listEvents(principal.id, runId, ControlPlane.eventBatchSize, cursor);
  }

  recover() {
    return this.store.recover(this.clock());
  }

  isRunTerminal(principal: Principal, runId: string): boolean {
    return terminalRunStatuses.has(this.store.requireRun(principal.id, runId).status);
  }
}

function decodeLeaseId(token: string): string {
  try {
    const payload = token.split(".")[0];
    if (!payload) throw new Error();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof decoded !== "object" || decoded === null || !("leaseId" in decoded) || typeof decoded.leaseId !== "string") {
      throw new Error();
    }
    return z.uuid().parse(decoded.leaseId);
  } catch {
    throw conflict("lease_rejected", "Lease is stale, invalid, or already redeemed");
  }
}

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import {
  runBudgetsSchema,
  runStatusSchema,
  terminalRunStatuses,
  type Agent,
  type ConsumedBudget,
  type CreateAgent,
  type IngestRunEvent,
  type Principal,
  type Run,
  type RunBudgets,
  type RunEvent,
  type RunStatus,
} from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";

const migrations = [
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    creator_json TEXT NOT NULL,
    requester_json TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    revision TEXT NOT NULL,
    environment_target TEXT NOT NULL,
    runner_pool TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT;

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('initial', 'follow_up')),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','assigned','running','canceling','waiting','succeeded','failed','canceled')),
    budgets_json TEXT NOT NULL,
    consumed_json TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    last_heartbeat_at TEXT,
    terminal_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(agent_id, number)
  ) STRICT;

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued','assigned','running','canceling','waiting','succeeded','failed','canceled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE lifecycle_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('agent','run','task')),
    entity_id TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX transitions_entity ON lifecycle_transitions(entity_type, entity_id, id);

  CREATE TABLE leases (
    lease_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    audience TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    token_digest TEXT UNIQUE,
    expires_at TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    redeemed_at TEXT,
    last_heartbeat_at TEXT,
    revoked_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX one_live_lease_per_run ON leases(run_id) WHERE revoked_at IS NULL;

  CREATE TABLE run_events (
    cursor TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    runner_event_id TEXT NOT NULL,
    runner_sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('run.started','run.progress','run.waiting','run.warning','run.result')),
    payload_json TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, runner_event_id),
    UNIQUE(run_id, runner_sequence)
  ) STRICT;

  CREATE TABLE idempotency_keys (
    owner_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(owner_id, scope, key)
  ) STRICT;
  `,
];

type AgentRow = {
  id: string;
  creator_json: string;
  requester_json: string;
  origin_json: string;
  repository_url: string;
  revision: string;
  environment_target: string;
  runner_pool: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type RunRow = {
  id: string;
  agent_id: string;
  task_id: string;
  number: number;
  kind: "initial" | "follow_up";
  prompt: string;
  status: string;
  budgets_json: string;
  consumed_json: string;
  retry_count: number;
  cancel_requested_at: string | null;
  last_heartbeat_at: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type LeaseRow = {
  lease_id: string;
  task_id: string;
  run_id: string;
  audience: string;
  runner_id: string;
  token_digest: string | null;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
};

/** SQLite-backed control-plane metadata store with synchronous transactional state changes. */
export class ControlPlaneStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createAgent(
    principal: Principal,
    input: CreateAgent,
    idempotencyKey: string,
    now: Date,
  ): { agent: Agent; run: Run } {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const prior = this.database
        .prepare("SELECT entity_id FROM idempotency_keys WHERE owner_id = ? AND scope = 'create-agent' AND key = ?")
        .get(principal.id, idempotencyKey) as { entity_id: string } | undefined;
      if (prior) {
        const agent = this.getAgent(principal.id, prior.entity_id);
        if (!agent) throw conflict("idempotency_conflict", "Idempotent result is no longer available");
        const run = this.listRunsForAgent(principal.id, agent.id)[0];
        if (!run) throw conflict("idempotency_conflict", "Idempotent result is no longer available");
        return { agent, run };
      }

      const agentId = randomUUID();
      const runId = randomUUID();
      const taskId = randomUUID();
      const consumed = emptyConsumedBudget();
      this.database
        .prepare(
          `INSERT INTO agents
           (id, owner_id, creator_json, requester_json, origin_json, repository_url, revision,
            environment_target, runner_pool, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          agentId,
          principal.id,
          JSON.stringify(principal),
          JSON.stringify(principal),
          JSON.stringify(input.origin),
          input.repositoryUrl,
          input.revision,
          input.environmentTarget,
          input.runnerPool,
          timestamp,
          timestamp,
        );
      this.database
        .prepare(
          `INSERT INTO runs
           (id, agent_id, number, kind, prompt, status, budgets_json, consumed_json, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, 1, 'initial', ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(runId, agentId, input.prompt, JSON.stringify(input.budgets), JSON.stringify(consumed), timestamp, timestamp, timestamp);
      this.database
        .prepare("INSERT INTO tasks (id, run_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)")
        .run(taskId, runId, timestamp, timestamp);
      this.transition("agent", agentId, null, "active", "created", timestamp);
      this.transition("run", runId, null, "queued", "created", timestamp);
      this.transition("task", taskId, null, "queued", "created", timestamp);
      this.database
        .prepare("INSERT INTO idempotency_keys (owner_id, scope, key, entity_id, created_at) VALUES (?, 'create-agent', ?, ?, ?)")
        .run(principal.id, idempotencyKey, agentId, timestamp);

      return {
        agent: this.requireAgent(principal.id, agentId),
        run: this.requireRun(principal.id, runId),
      };
    });
  }

  createFollowUp(
    ownerId: string,
    agentId: string,
    prompt: string,
    budgets: RunBudgets,
    idempotencyKey: string,
    now: Date,
  ): Run {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      this.requireAgent(ownerId, agentId);
      const prior = this.database
        .prepare("SELECT entity_id FROM idempotency_keys WHERE owner_id = ? AND scope = ? AND key = ?")
        .get(ownerId, `follow-up:${agentId}`, idempotencyKey) as { entity_id: string } | undefined;
      if (prior) return this.requireRun(ownerId, prior.entity_id);

      const active = this.database
        .prepare(
          "SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','assigned','running','canceling','waiting') LIMIT 1",
        )
        .get(agentId);
      if (active) throw conflict("agent_busy", "Agent already has an active run");

      const next = this.database.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM runs WHERE agent_id = ?").get(agentId) as {
        number: number;
      };
      const runId = randomUUID();
      const taskId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO runs
           (id, agent_id, number, kind, prompt, status, budgets_json, consumed_json, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, 'follow_up', ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(runId, agentId, next.number, prompt, JSON.stringify(budgets), JSON.stringify(emptyConsumedBudget()), timestamp, timestamp, timestamp);
      this.database
        .prepare("INSERT INTO tasks (id, run_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)")
        .run(taskId, runId, timestamp, timestamp);
      this.transition("run", runId, null, "queued", "follow_up", timestamp);
      this.transition("task", taskId, null, "queued", "follow_up", timestamp);
      this.database
        .prepare("INSERT INTO idempotency_keys (owner_id, scope, key, entity_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(ownerId, `follow-up:${agentId}`, idempotencyKey, runId, timestamp);
      return this.requireRun(ownerId, runId);
    });
  }

  getAgent(ownerId: string, agentId: string): Agent | undefined {
    const row = this.database.prepare("SELECT * FROM agents WHERE id = ? AND owner_id = ?").get(agentId, ownerId) as
      | AgentRow
      | undefined;
    return row ? mapAgent(row) : undefined;
  }

  requireAgent(ownerId: string, agentId: string): Agent {
    const agent = this.getAgent(ownerId, agentId);
    if (!agent) throw notFound("Agent");
    return agent;
  }

  listAgents(ownerId: string, limit: number, afterCreatedAt?: string, afterId?: string): { items: Agent[]; nextCursor: string | null } {
    const rows = (afterCreatedAt && afterId
      ? this.database
          .prepare(
            `SELECT * FROM agents WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(ownerId, afterCreatedAt, afterCreatedAt, afterId, limit + 1)
      : this.database
          .prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
          .all(ownerId, limit + 1)) as unknown as AgentRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapAgent);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeListCursor(last.createdAt, last.id) : null };
  }

  listRunsForAgent(ownerId: string, agentId: string): Run[] {
    this.requireAgent(ownerId, agentId);
    const rows = this.database
      .prepare(
        `SELECT runs.*, tasks.id AS task_id FROM runs JOIN tasks ON tasks.run_id = runs.id
         WHERE runs.agent_id = ? ORDER BY runs.number ASC`,
      )
      .all(agentId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  listRuns(ownerId: string, limit: number, afterCreatedAt?: string, afterId?: string): { items: Run[]; nextCursor: string | null } {
    const rows = (afterCreatedAt && afterId
      ? this.database
          .prepare(
            `SELECT runs.*, tasks.id AS task_id FROM runs
             JOIN tasks ON tasks.run_id = runs.id JOIN agents ON agents.id = runs.agent_id
             WHERE agents.owner_id = ? AND (runs.created_at < ? OR (runs.created_at = ? AND runs.id < ?))
             ORDER BY runs.created_at DESC, runs.id DESC LIMIT ?`,
          )
          .all(ownerId, afterCreatedAt, afterCreatedAt, afterId, limit + 1)
      : this.database
          .prepare(
            `SELECT runs.*, tasks.id AS task_id FROM runs
             JOIN tasks ON tasks.run_id = runs.id JOIN agents ON agents.id = runs.agent_id
             WHERE agents.owner_id = ? ORDER BY runs.created_at DESC, runs.id DESC LIMIT ?`,
          )
          .all(ownerId, limit + 1)) as unknown as RunRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapRun);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeListCursor(last.createdAt, last.id) : null };
  }

  getRun(ownerId: string, runId: string): Run | undefined {
    const row = this.database
      .prepare(
        `SELECT runs.*, tasks.id AS task_id FROM runs
         JOIN tasks ON tasks.run_id = runs.id JOIN agents ON agents.id = runs.agent_id
         WHERE runs.id = ? AND agents.owner_id = ?`,
      )
      .get(runId, ownerId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  requireRun(ownerId: string, runId: string): Run {
    const run = this.getRun(ownerId, runId);
    if (!run) throw notFound("Run");
    return run;
  }

  setArchived(ownerId: string, agentId: string, archived: boolean, now: Date): Agent {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const agent = this.requireAgent(ownerId, agentId);
      const next = archived ? "archived" : "active";
      if (agent.status === next) return agent;
      this.database
        .prepare("UPDATE agents SET status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .run(next, archived ? timestamp : null, timestamp, agentId, ownerId);
      this.transition("agent", agentId, agent.status, next, archived ? "archived" : "unarchived", timestamp);
      return this.requireAgent(ownerId, agentId);
    });
  }

  deleteAgent(ownerId: string, agentId: string): void {
    this.transaction(() => {
      this.requireAgent(ownerId, agentId);
      const active = this.database
        .prepare("SELECT 1 FROM runs WHERE agent_id = ? AND status IN ('queued','assigned','running','canceling','waiting')")
        .get(agentId);
      if (active) throw conflict("agent_busy", "Active agents cannot be permanently deleted");
      this.database.prepare("DELETE FROM agents WHERE id = ? AND owner_id = ?").run(agentId, ownerId);
    });
  }

  requestCancellation(ownerId: string, runId: string, now: Date): Run {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const run = this.requireRun(ownerId, runId);
      if (terminalRunStatuses.has(run.status) || run.status === "canceling") return run;
      const next: RunStatus = run.status === "queued" || run.status === "assigned" ? "canceled" : "canceling";
      this.setRunAndTaskStatus(run.id, run.taskId, run.status, next, "user_canceled", timestamp, {
        cancelRequestedAt: timestamp,
        terminalReason: "user_canceled",
      });
      if (next === "canceled") this.revokeRunLease(run.id, timestamp);
      return this.requireRun(ownerId, runId);
    });
  }

  claimRun(
    audience: string,
    runnerId: string,
    leaseId: string,
    expiresAt: Date,
    now: Date,
    sign: (task: { id: string; repositoryUrl: string; revision: string }) => string,
    digest: (token: string) => string,
  ): string | undefined {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT tasks.id AS task_id, runs.id AS run_id, runs.status, agents.repository_url, agents.revision
           FROM tasks JOIN runs ON runs.id = tasks.run_id JOIN agents ON agents.id = runs.agent_id
           WHERE tasks.status = 'queued' AND runs.status = 'queued' AND runs.next_attempt_at <= ?
             AND agents.runner_pool = ?
           ORDER BY runs.created_at ASC LIMIT 1`,
        )
        .get(timestamp, audience) as
        | { task_id: string; run_id: string; status: RunStatus; repository_url: string; revision: string }
        | undefined;
      if (!row) return undefined;

      const runChange = this.database
        .prepare("UPDATE runs SET status = 'assigned', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(timestamp, row.run_id);
      const taskChange = this.database
        .prepare("UPDATE tasks SET status = 'assigned', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(timestamp, row.task_id);
      assertChanged(runChange, "Run was claimed concurrently");
      assertChanged(taskChange, "Task was claimed concurrently");

      const token = sign({ id: row.task_id, repositoryUrl: row.repository_url, revision: row.revision });
      this.database
        .prepare(
          `INSERT INTO leases
           (lease_id, task_id, run_id, audience, runner_id, token_digest, expires_at, assigned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(leaseId, row.task_id, row.run_id, audience, runnerId, digest(token), expiresAt.toISOString(), timestamp);
      this.transition("run", row.run_id, "queued", "assigned", "runner_assigned", timestamp);
      this.transition("task", row.task_id, "queued", "assigned", "runner_assigned", timestamp);
      return token;
    });
  }

  redeemLease(
    tokenDigest: string,
    claims: { leaseId: string; taskId: string; audience: string },
    runnerId: string,
    now: Date,
  ): { taskId: string; runId: string; budgets: RunBudgets; cancelRequested: boolean } {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const lease = this.database
        .prepare("SELECT * FROM leases WHERE lease_id = ? AND token_digest = ?")
        .get(claims.leaseId, tokenDigest) as LeaseRow | undefined;
      if (
        !lease ||
        lease.task_id !== claims.taskId ||
        lease.audience !== claims.audience ||
        lease.runner_id !== runnerId ||
        lease.revoked_at ||
        lease.redeemed_at ||
        lease.expires_at <= timestamp
      ) {
        throw conflict("lease_rejected", "Lease is stale, invalid, or already redeemed");
      }
      assertChanged(
        this.database
          .prepare("UPDATE leases SET redeemed_at = ?, last_heartbeat_at = ? WHERE lease_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL")
          .run(timestamp, timestamp, lease.lease_id),
        "Lease was redeemed concurrently",
      );
      const run = this.internalRun(lease.run_id);
      this.setRunAndTaskStatus(run.id, run.taskId, run.status, "running", "lease_redeemed", timestamp, {
        lastHeartbeatAt: timestamp,
        startedAt: timestamp,
      });
      const current = this.internalRun(run.id);
      return { taskId: current.taskId, runId: current.id, budgets: current.budgets, cancelRequested: false };
    });
  }

  heartbeat(tokenDigest: string, leaseId: string, consumed: ConsumedBudget, now: Date): { cancelRequested: boolean; run: Run } {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const lease = this.requireRedeemedLease(tokenDigest, leaseId);
      const run = this.internalRun(lease.run_id);
      if (terminalRunStatuses.has(run.status)) return { cancelRequested: true, run };
      const nextConsumed = mergeConsumed(run.consumed, consumed);
      const budgetReason = exceededBudget(run, nextConsumed, now);
      const nextStatus = budgetReason && run.status !== "canceling" ? "canceling" : run.status;
      this.database
        .prepare("UPDATE leases SET last_heartbeat_at = ? WHERE lease_id = ? AND revoked_at IS NULL")
        .run(timestamp, leaseId);
      this.database
        .prepare(
          `UPDATE runs SET consumed_json = ?, last_heartbeat_at = ?, updated_at = ?,
           status = ?, cancel_requested_at = CASE WHEN ? IS NOT NULL THEN COALESCE(cancel_requested_at, ?) ELSE cancel_requested_at END,
           terminal_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE terminal_reason END
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(nextConsumed),
          timestamp,
          timestamp,
          nextStatus,
          budgetReason ?? null,
          timestamp,
          budgetReason ?? null,
          budgetReason ?? null,
          run.id,
        );
      if (nextStatus !== run.status) {
        this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(nextStatus, timestamp, run.taskId);
        this.transition("run", run.id, run.status, nextStatus, budgetReason ?? null, timestamp);
        this.transition("task", run.taskId, run.status, nextStatus, budgetReason ?? null, timestamp);
      }
      const current = this.internalRun(run.id);
      return { cancelRequested: Boolean(current.cancelRequestedAt), run: current };
    });
  }

  ingestEvent(tokenDigest: string, runId: string, event: IngestRunEvent, now: Date): RunEvent {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const payloadJson = JSON.stringify(event.payload);
      const duplicate = this.database
        .prepare(
          `SELECT run_events.* FROM run_events
           JOIN leases ON leases.run_id = run_events.run_id
           WHERE run_events.run_id = ? AND run_events.runner_event_id = ? AND leases.token_digest = ?
             AND (leases.revoked_at IS NULL OR run_events.kind = 'run.result')`,
        )
        .get(runId, event.runnerEventId, tokenDigest) as EventRow | undefined;
      if (duplicate) {
        if (
          duplicate.runner_sequence !== event.runnerSequence ||
          duplicate.kind !== event.kind ||
          duplicate.payload_json !== payloadJson
        ) {
          throw conflict("event_id_conflict", "Runner event ID was reused with different content");
        }
        return mapEvent(duplicate);
      }

      const lease = this.requireRedeemedLeaseForRun(tokenDigest, runId);
      const run = this.internalRun(runId);
      if (terminalRunStatuses.has(run.status)) throw conflict("run_terminal", "Run is already terminal");

      const byteSize = Buffer.byteLength(payloadJson, "utf8");
      if (byteSize > run.budgets.eventPayloadBytes) throw conflict("event_too_large", "Event payload exceeds the per-event budget");

      const tail = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence, COALESCE(MAX(runner_sequence), 0) AS runner_sequence FROM run_events WHERE run_id = ?")
        .get(runId) as { sequence: number; runner_sequence: number };
      if (event.runnerSequence !== tail.runner_sequence + 1) {
        throw conflict("event_out_of_order", "Runner event sequence is not contiguous");
      }
      if (
        run.consumed.eventCount + 1 > run.budgets.eventCount ||
        run.consumed.eventBytes + byteSize > run.budgets.eventBytes
      ) {
        throw conflict("event_budget_exceeded", "Run event budget is exhausted");
      }

      const cursor = randomUUID();
      this.database
        .prepare(
          `INSERT INTO run_events
           (cursor, run_id, sequence, runner_event_id, runner_sequence, timestamp, kind, payload_json, byte_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cursor, runId, tail.sequence + 1, event.runnerEventId, event.runnerSequence, timestamp, event.kind, payloadJson, byteSize);
      const nextConsumed = {
        ...run.consumed,
        eventCount: run.consumed.eventCount + 1,
        eventBytes: run.consumed.eventBytes + byteSize,
      };
      this.database
        .prepare("UPDATE runs SET consumed_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(nextConsumed), timestamp, runId);
      this.database.prepare("UPDATE leases SET last_heartbeat_at = ? WHERE lease_id = ?").run(timestamp, lease.lease_id);

      if (event.kind === "run.waiting" && run.status === "running") {
        this.setRunAndTaskStatus(run.id, run.taskId, "running", "waiting", "runner_waiting", timestamp);
      } else if ((event.kind === "run.progress" || event.kind === "run.started") && run.status === "waiting") {
        this.setRunAndTaskStatus(run.id, run.taskId, "waiting", "running", "runner_resumed", timestamp);
      } else if (event.kind === "run.result") {
        const result = event.payload as { outcome: "succeeded" | "failed" | "canceled"; terminalReason?: string };
        const terminalReason = run.terminalReason ?? result.terminalReason ?? `runner_${result.outcome}`;
        this.setRunAndTaskStatus(
          run.id,
          run.taskId,
          run.status,
          result.outcome,
          terminalReason,
          timestamp,
          { terminalReason },
        );
        this.revokeRunLease(run.id, timestamp);
      }

      return {
        cursor,
        runId,
        sequence: tail.sequence + 1,
        runnerEventId: event.runnerEventId,
        runnerSequence: event.runnerSequence,
        timestamp,
        kind: event.kind,
        payload: event.payload,
      };
    });
  }

  listEvents(ownerId: string, runId: string, afterCursor?: string): RunEvent[] {
    this.requireRun(ownerId, runId);
    let afterSequence = 0;
    if (afterCursor) {
      const cursor = this.database.prepare("SELECT run_id, sequence FROM run_events WHERE cursor = ?").get(afterCursor) as
        | { run_id: string; sequence: number }
        | undefined;
      if (!cursor) throw conflict("cursor_expired", "Event cursor is unavailable; reload the terminal run state");
      if (cursor.run_id !== runId) throw conflict("cursor_run_mismatch", "Event cursor belongs to another run");
      afterSequence = cursor.sequence;
    }
    const rows = this.database
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC")
      .all(runId, afterSequence) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  recover(now: Date): { requeued: number; failed: number; canceled: number } {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      let requeued = 0;
      let failed = 0;
      let canceled = 0;
      const rows = this.database
        .prepare(
          `SELECT runs.*, tasks.id AS task_id, leases.lease_id, leases.expires_at, leases.redeemed_at,
                  COALESCE(leases.last_heartbeat_at, runs.last_heartbeat_at) AS effective_heartbeat
           FROM runs JOIN tasks ON tasks.run_id = runs.id
           LEFT JOIN leases ON leases.run_id = runs.id AND leases.revoked_at IS NULL
           WHERE runs.status IN ('assigned','running','waiting','canceling')`,
        )
        .all() as unknown as Array<RunRow & { lease_id: string | null; expires_at: string | null; redeemed_at: string | null; effective_heartbeat: string | null }>;

      for (const row of rows) {
        const run = mapRun(row);
        const budgets = run.budgets;
        const assignedExpired = run.status === "assigned" && row.expires_at !== null && row.expires_at <= timestamp;
        const heartbeatAt = row.effective_heartbeat ? new Date(row.effective_heartbeat).getTime() : new Date(run.createdAt).getTime();
        const runnerLost = run.status !== "assigned" && now.getTime() - heartbeatAt > budgets.idleTimeSeconds * 1_000;
        const wallExceeded = now.getTime() - new Date(run.startedAt ?? run.createdAt).getTime() > budgets.wallTimeSeconds * 1_000;
        if (!assignedExpired && !runnerLost && !wallExceeded) continue;

        this.revokeRunLease(run.id, timestamp);
        if (wallExceeded && run.status !== "canceling") {
          this.setRunAndTaskStatus(run.id, run.taskId, run.status, "failed", "budget_exceeded:wall_time", timestamp, {
            terminalReason: "budget_exceeded:wall_time",
          });
          failed += 1;
        } else if (run.status === "canceling") {
          this.setRunAndTaskStatus(run.id, run.taskId, run.status, "canceled", run.terminalReason ?? "cancellation_recovered", timestamp, {
            terminalReason: run.terminalReason ?? "cancellation_recovered",
          });
          canceled += 1;
        } else if (run.retryCount < budgets.maxRetries) {
          const delaySeconds = Math.min(60, 5 * 2 ** run.retryCount);
          this.database
            .prepare(
              `UPDATE runs SET status = 'queued', retry_count = retry_count + 1, next_attempt_at = ?,
               last_heartbeat_at = NULL, updated_at = ?, started_at = NULL WHERE id = ? AND status = ?`,
            )
            .run(new Date(now.getTime() + delaySeconds * 1_000).toISOString(), timestamp, run.id, run.status);
          this.database.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?").run(timestamp, run.taskId);
          this.transition("run", run.id, run.status, "queued", "infrastructure_recovery", timestamp);
          this.transition("task", run.taskId, run.status, "queued", "infrastructure_recovery", timestamp);
          requeued += 1;
        } else {
          this.setRunAndTaskStatus(run.id, run.taskId, run.status, "failed", "infrastructure_retries_exhausted", timestamp, {
            terminalReason: "infrastructure_retries_exhausted",
          });
          failed += 1;
        }
      }
      return { requeued, failed, canceled };
    });
  }

  getTransitions(ownerId: string, runId: string): Array<Record<string, unknown>> {
    const run = this.requireRun(ownerId, runId);
    return this.database
      .prepare(
        `SELECT entity_type AS entityType, entity_id AS entityId, from_state AS fromState,
                to_state AS toState, reason, created_at AS createdAt
         FROM lifecycle_transitions WHERE entity_id IN (?, ?) ORDER BY id`,
      )
      .all(runId, run.taskId) as unknown as Array<Record<string, unknown>>;
  }

  private migrate(): void {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;",
    );
    const applied = new Set(
      (this.database.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );
    migrations.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.transaction(() => {
        this.database.exec(sql);
        this.database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
      });
    });
  }

  private internalRun(runId: string): Run {
    const row = this.database
      .prepare("SELECT runs.*, tasks.id AS task_id FROM runs JOIN tasks ON tasks.run_id = runs.id WHERE runs.id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) throw notFound("Run");
    return mapRun(row);
  }

  private requireRedeemedLease(tokenDigestValue: string, leaseId: string): LeaseRow {
    const lease = this.database
      .prepare("SELECT * FROM leases WHERE lease_id = ? AND token_digest = ?")
      .get(leaseId, tokenDigestValue) as LeaseRow | undefined;
    if (!lease || !lease.redeemed_at || lease.revoked_at) throw forbidden();
    return lease;
  }

  private requireRedeemedLeaseForRun(tokenDigestValue: string, runId: string): LeaseRow {
    const lease = this.database
      .prepare("SELECT * FROM leases WHERE run_id = ? AND token_digest = ? AND redeemed_at IS NOT NULL AND revoked_at IS NULL")
      .get(runId, tokenDigestValue) as LeaseRow | undefined;
    if (!lease) throw forbidden();
    return lease;
  }

  private setRunAndTaskStatus(
    runId: string,
    taskId: string,
    from: RunStatus,
    to: RunStatus,
    reason: string,
    timestamp: string,
    fields: { cancelRequestedAt?: string; terminalReason?: string | null; lastHeartbeatAt?: string; startedAt?: string } = {},
  ): void {
    assertLegalTransition(from, to);
    const terminal = terminalRunStatuses.has(to);
    assertChanged(
      this.database
        .prepare(
          `UPDATE runs SET status = ?, updated_at = ?,
           cancel_requested_at = COALESCE(?, cancel_requested_at),
           terminal_reason = COALESCE(?, terminal_reason),
           last_heartbeat_at = COALESCE(?, last_heartbeat_at),
           started_at = COALESCE(?, started_at),
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END
           WHERE id = ? AND status = ?`,
        )
        .run(
          to,
          timestamp,
          fields.cancelRequestedAt ?? null,
          fields.terminalReason ?? null,
          fields.lastHeartbeatAt ?? null,
          fields.startedAt ?? null,
          terminal ? 1 : 0,
          timestamp,
          runId,
          from,
        ),
      "Run transition was stale",
    );
    assertChanged(
      this.database.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, timestamp, taskId, from),
      "Task transition was stale",
    );
    this.transition("run", runId, from, to, reason, timestamp);
    this.transition("task", taskId, from, to, reason, timestamp);
  }

  private transition(
    entityType: "agent" | "run" | "task",
    entityId: string,
    from: string | null,
    to: string,
    reason: string | null,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO lifecycle_transitions (entity_type, entity_id, from_state, to_state, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entityType, entityId, from, to, reason, timestamp);
  }

  private revokeRunLease(runId: string, timestamp: string): void {
    this.database.prepare("UPDATE leases SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL").run(timestamp, runId);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

type EventRow = {
  cursor: string;
  run_id: string;
  sequence: number;
  runner_event_id: string;
  runner_sequence: number;
  timestamp: string;
  kind: IngestRunEvent["kind"];
  payload_json: string;
};

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    creator: JSON.parse(row.creator_json) as Principal,
    requester: JSON.parse(row.requester_json) as Principal,
    origin: JSON.parse(row.origin_json) as Agent["origin"],
    repositoryUrl: row.repository_url,
    revision: row.revision,
    environmentTarget: row.environment_target,
    runnerPool: row.runner_pool,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapRun(row: RunRow): Run {
  const consumed = JSON.parse(row.consumed_json) as Run["consumed"];
  return {
    id: row.id,
    agentId: row.agent_id,
    taskId: row.task_id,
    number: row.number,
    kind: row.kind,
    prompt: row.prompt,
    status: runStatusSchema.parse(row.status),
    budgets: runBudgetsSchema.parse(JSON.parse(row.budgets_json)),
    consumed,
    retryCount: row.retry_count,
    cancelRequestedAt: row.cancel_requested_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapEvent(row: EventRow): RunEvent {
  return {
    cursor: row.cursor,
    runId: row.run_id,
    sequence: row.sequence,
    runnerEventId: row.runner_event_id,
    runnerSequence: row.runner_sequence,
    timestamp: row.timestamp,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function emptyConsumedBudget(): Run["consumed"] {
  return { cpuSeconds: 0, memoryPeakMb: 0, artifactBytes: 0, eventCount: 0, eventBytes: 0 };
}

function mergeConsumed(current: Run["consumed"], reported: ConsumedBudget): Run["consumed"] {
  if (
    reported.cpuSeconds < current.cpuSeconds ||
    reported.memoryPeakMb < current.memoryPeakMb ||
    reported.artifactBytes < current.artifactBytes ||
    (reported.providerUsage !== undefined &&
      current.providerUsage !== undefined &&
      reported.providerUsage < current.providerUsage)
  ) {
    throw conflict("budget_regression", "Consumed budget counters must be monotonic");
  }
  return { ...current, ...reported };
}

function exceededBudget(run: Run, consumed: Run["consumed"], now: Date): string | undefined {
  const budgets = run.budgets;
  if (consumed.cpuSeconds > budgets.cpuSeconds) return "budget_exceeded:cpu_seconds";
  if (consumed.memoryPeakMb > budgets.memoryMb) return "budget_exceeded:memory_mb";
  if (consumed.artifactBytes > budgets.artifactBytes) return "budget_exceeded:artifact_bytes";
  if (budgets.providerUsage !== undefined && (consumed.providerUsage ?? 0) > budgets.providerUsage) {
    return "budget_exceeded:provider_usage";
  }
  if (now.getTime() - new Date(run.startedAt ?? run.createdAt).getTime() > budgets.wallTimeSeconds * 1_000) {
    return "budget_exceeded:wall_time";
  }
  return undefined;
}

const legalTransitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["assigned", "canceled"]),
  assigned: new Set(["running", "queued", "canceling", "failed", "canceled"]),
  running: new Set(["waiting", "canceling", "queued", "succeeded", "failed", "canceled"]),
  waiting: new Set(["running", "canceling", "queued", "succeeded", "failed", "canceled"]),
  canceling: new Set(["canceled"]),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set(),
};

function assertLegalTransition(from: RunStatus, to: RunStatus): void {
  if (!legalTransitions[from].has(to)) throw conflict("invalid_transition", `Cannot transition run from ${from} to ${to}`);
}

function assertChanged(result: StatementResultingChanges, message: string): void {
  if (result.changes !== 1) throw conflict("stale_transition", message);
}

/** Decodes a client-owned pagination cursor and rejects malformed values. */
export function decodeListCursor(cursor: string): { createdAt: string; id: string } {
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

function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

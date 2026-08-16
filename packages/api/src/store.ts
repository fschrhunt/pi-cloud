import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import type { CheckoutProvenance, HostedCredentialReference } from "@pi-cloud/contracts";
import {
  hostedSessionStateSchema,
  runBudgetsSchema,
  runStatusSchema,
  terminalRunStatuses,
  type Agent,
  type ConsumedBudget,
  type CreateAgent,
  type CreateWorkspace,
  type HostedSession,
  type HostedSessionState,
  type IngestRunEvent,
  type Principal,
  type Run,
  type RunBudgets,
  type RunEvent,
  type RunStatus,
  type Workspace,
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
    lease_id TEXT NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    runner_event_id TEXT NOT NULL,
    runner_sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('run.started','run.progress','run.waiting','run.warning','run.result')),
    payload_json TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, runner_event_id),
    UNIQUE(lease_id, runner_sequence)
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
  `
  CREATE TABLE checkout_provenance (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
    repository_url TEXT NOT NULL,
    revision TEXT NOT NULL,
    resolved_commit TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('https','local-fixture')),
    credential_source TEXT NOT NULL CHECK (credential_source IN ('anonymous','short-lived-repository-token','local-fixture')),
    credential_scrubbed INTEGER NOT NULL CHECK (credential_scrubbed = 1),
    submodules_initialized INTEGER NOT NULL CHECK (submodules_initialized = 0),
    hooks_disabled INTEGER NOT NULL CHECK (hooks_disabled = 1),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  ) STRICT;
  `,
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    repository_url TEXT NOT NULL,
    revision TEXT NOT NULL,
    root TEXT NOT NULL UNIQUE,
    project_trust TEXT NOT NULL CHECK (project_trust IN ('trusted','untrusted')),
    agent_directory TEXT NOT NULL,
    credential_references_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX workspaces_owner ON workspaces(owner_id, created_at, id);

  CREATE TABLE hosted_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','starting','running','stopped','archived')),
    native_session_id TEXT,
    native_session_file TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    archived_at TEXT
  ) STRICT;
  CREATE INDEX hosted_sessions_owner ON hosted_sessions(owner_id, created_at, id);
  CREATE INDEX hosted_sessions_queue ON hosted_sessions(state, created_at);

  CREATE TABLE runtime_assignments (
    id TEXT PRIMARY KEY,
    hosted_session_id TEXT NOT NULL REFERENCES hosted_sessions(id) ON DELETE CASCADE,
    runner_id TEXT NOT NULL,
    token_digest TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    stopped_at TEXT,
    last_heartbeat_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX one_active_assignment_per_session ON runtime_assignments(hosted_session_id) WHERE stopped_at IS NULL;
  `,
  `
  CREATE UNIQUE INDEX one_active_session_per_workspace
    ON hosted_sessions(workspace_id)
    WHERE state IN ('queued','starting','running');
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

type CheckoutProvenanceRow = {
  run_id: string;
  lease_id: string;
  repository_url: string;
  revision: string;
  resolved_commit: string;
  transport: "https" | "local-fixture";
  credential_source: "anonymous" | "short-lived-repository-token" | "local-fixture";
  credential_scrubbed: 1;
  submodules_initialized: 0;
  hooks_disabled: 1;
  started_at: string;
  completed_at: string;
};

type WorkspaceRow = {
  id: string;
  owner_id: string;
  repository_url: string;
  revision: string;
  root: string;
  project_trust: "trusted" | "untrusted";
  agent_directory: string;
  credential_references_json: string;
  status: "active";
  created_at: string;
  updated_at: string;
};

type HostedSessionRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  state: HostedSessionState;
  native_session_id: string | null;
  native_session_file: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  stopped_at: string | null;
  archived_at: string | null;
};

type RuntimeAssignmentRow = {
  id: string;
  hosted_session_id: string;
  runner_id: string;
  token_digest: string;
  started_at: string;
  expires_at: string;
  stopped_at: string | null;
  last_heartbeat_at: string | null;
};

const legalHostedSessionTransitions: Record<HostedSessionState, ReadonlySet<HostedSessionState>> = {
  queued: new Set(["starting", "stopped"]),
  starting: new Set(["running", "stopped"]),
  running: new Set(["stopped"]),
  stopped: new Set(["queued", "archived"]),
  archived: new Set([]),
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
    return rows.map((row) => ({ ...mapRun(row), checkoutProvenance: this.getCheckoutProvenance(row.id) }));
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
    const items = rows
      .slice(0, limit)
      .map((row) => ({ ...mapRun(row), checkoutProvenance: this.getCheckoutProvenance(row.id) }));
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
    return row ? { ...mapRun(row), checkoutProvenance: this.getCheckoutProvenance(runId) } : undefined;
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

  getLeaseAudience(leaseId: string): string | undefined {
    const row = this.database.prepare("SELECT audience FROM leases WHERE lease_id = ?").get(leaseId) as { audience: string } | undefined;
    return row?.audience;
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

  recordCheckoutProvenance(
    tokenDigest: string,
    runId: string,
    provenance: CheckoutProvenance,
    now: Date,
  ): CheckoutProvenance {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const lease = this.requireRedeemedLeaseForRun(tokenDigest, runId);
      const run = this.internalRun(runId);
      if (terminalRunStatuses.has(run.status)) throw conflict("run_terminal", "Run is already terminal");
      const authorized = this.database
        .prepare(
          `SELECT agents.repository_url, agents.revision FROM runs
           JOIN agents ON agents.id = runs.agent_id WHERE runs.id = ?`,
        )
        .get(runId) as { repository_url: string; revision: string } | undefined;
      if (
        !authorized ||
        provenance.transport !== "https" ||
        provenance.repositoryUrl !== authorized.repository_url ||
        provenance.revision !== authorized.revision ||
        provenance.resolvedCommit !== authorized.revision
      ) {
        throw conflict(
          "checkout_provenance_mismatch",
          "Checkout provenance does not match the run's authorized repository revision",
        );
      }

      const existing = this.database
        .prepare("SELECT * FROM checkout_provenance WHERE run_id = ?")
        .get(runId) as CheckoutProvenanceRow | undefined;
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO checkout_provenance
             (run_id, lease_id, repository_url, revision, resolved_commit, transport, credential_source,
              credential_scrubbed, submodules_initialized, hooks_disabled, started_at, completed_at, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?)`,
          )
          .run(
            runId,
            lease.lease_id,
            provenance.repositoryUrl,
            provenance.revision,
            provenance.resolvedCommit,
            provenance.transport,
            provenance.credentialSource,
            provenance.startedAt,
            provenance.completedAt,
            timestamp,
          );
        return provenance;
      }

      if (existing.lease_id === lease.lease_id) {
        const recorded = mapCheckoutProvenance(existing);
        if (JSON.stringify(recorded) !== JSON.stringify(provenance)) {
          throw conflict("checkout_provenance_conflict", "Checkout provenance was already recorded for this assignment");
        }
        return recorded;
      }

      this.database
        .prepare(
          `UPDATE checkout_provenance SET lease_id = ?, repository_url = ?, revision = ?, resolved_commit = ?,
           transport = ?, credential_source = ?, started_at = ?, completed_at = ?, recorded_at = ? WHERE run_id = ?`,
        )
        .run(
          lease.lease_id,
          provenance.repositoryUrl,
          provenance.revision,
          provenance.resolvedCommit,
          provenance.transport,
          provenance.credentialSource,
          provenance.startedAt,
          provenance.completedAt,
          timestamp,
          runId,
        );
      return provenance;
    });
  }

  ingestEvent(tokenDigest: string, runId: string, event: IngestRunEvent, now: Date): RunEvent {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const payloadJson = JSON.stringify(event.payload);
      const duplicate = this.database
        .prepare(
          `SELECT run_events.*, leases.token_digest AS lease_token_digest, leases.revoked_at AS lease_revoked_at
           FROM run_events JOIN leases ON leases.lease_id = run_events.lease_id
           WHERE run_events.run_id = ? AND run_events.runner_event_id = ?`,
        )
        .get(runId, event.runnerEventId) as DuplicateEventRow | undefined;
      if (duplicate) {
        if (
          duplicate.lease_token_digest === tokenDigest &&
          (duplicate.lease_revoked_at === null || duplicate.kind === "run.result")
        ) {
          if (
            duplicate.runner_sequence !== event.runnerSequence ||
            duplicate.kind !== event.kind ||
            duplicate.payload_json !== payloadJson
          ) {
            throw conflict("event_id_conflict", "Runner event ID was reused with different content");
          }
          return mapEvent(duplicate);
        }

        this.requireRedeemedLeaseForRun(tokenDigest, runId);
        throw conflict("event_id_conflict", "Runner event ID was already used by another assignment");
      }

      const lease = this.requireRedeemedLeaseForRun(tokenDigest, runId);
      const run = this.internalRun(runId);
      if (terminalRunStatuses.has(run.status)) throw conflict("run_terminal", "Run is already terminal");

      const byteSize = Buffer.byteLength(payloadJson, "utf8");
      if (byteSize > run.budgets.eventPayloadBytes) throw conflict("event_too_large", "Event payload exceeds the per-event budget");

      const tail = this.database
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) AS sequence,
                  COALESCE((SELECT MAX(runner_sequence) FROM run_events WHERE lease_id = ?), 0) AS runner_sequence
           FROM run_events WHERE run_id = ?`,
        )
        .get(lease.lease_id, runId) as { sequence: number; runner_sequence: number };
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
           (cursor, run_id, lease_id, sequence, runner_event_id, runner_sequence, timestamp, kind, payload_json, byte_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          cursor,
          runId,
          lease.lease_id,
          tail.sequence + 1,
          event.runnerEventId,
          event.runnerSequence,
          timestamp,
          event.kind,
          payloadJson,
          byteSize,
        );
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

  listEvents(ownerId: string, runId: string, limit: number, afterCursor?: string): RunEvent[] {
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
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(runId, afterSequence, limit) as unknown as EventRow[];
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
        const wallExceeded =
          run.startedAt !== null && now.getTime() - new Date(run.startedAt).getTime() > budgets.wallTimeSeconds * 1_000;
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

  createWorkspace(
    ownerId: string,
    input: CreateWorkspace,
    root: string,
    agentDirectory: string,
    credentialReferences: HostedCredentialReference[],
    idempotencyKey: string,
    now: Date,
    workspaceId: string,
  ): Workspace {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const prior = this.database
        .prepare("SELECT entity_id FROM idempotency_keys WHERE owner_id = ? AND scope = 'create-workspace' AND key = ?")
        .get(ownerId, idempotencyKey) as { entity_id: string } | undefined;
      if (prior) return this.requireWorkspace(ownerId, prior.entity_id);

      this.database
        .prepare(
          `INSERT INTO workspaces
           (id, owner_id, repository_url, revision, root, project_trust, agent_directory, credential_references_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          workspaceId,
          ownerId,
          input.repositoryUrl,
          input.revision,
          root,
          input.projectTrust,
          agentDirectory,
          JSON.stringify(credentialReferences),
          timestamp,
          timestamp,
        );
      this.database
        .prepare("INSERT INTO idempotency_keys (owner_id, scope, key, entity_id, created_at) VALUES (?, 'create-workspace', ?, ?, ?)")
        .run(ownerId, idempotencyKey, workspaceId, timestamp);
      return this.requireWorkspace(ownerId, workspaceId);
    });
  }

  getWorkspace(ownerId: string, workspaceId: string): Workspace | undefined {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ? AND owner_id = ?").get(workspaceId, ownerId) as
      | WorkspaceRow
      | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  requireWorkspace(ownerId: string, workspaceId: string): Workspace {
    const workspace = this.getWorkspace(ownerId, workspaceId);
    if (!workspace) throw notFound("Workspace");
    return workspace;
  }

  listWorkspaces(ownerId: string, limit: number, afterCreatedAt?: string, afterId?: string): { items: Workspace[]; nextCursor: string | null } {
    const rows = (afterCreatedAt && afterId
      ? this.database
          .prepare(
            `SELECT * FROM workspaces WHERE owner_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(ownerId, afterCreatedAt, afterCreatedAt, afterId, limit + 1)
      : this.database
          .prepare("SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
          .all(ownerId, limit + 1)) as unknown as WorkspaceRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapWorkspace);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeListCursor(last.createdAt, last.id) : null };
  }

  createHostedSession(
    ownerId: string,
    workspaceId: string,
    idempotencyKey: string,
    now: Date,
    workspaceRuntimeActive = false,
  ): HostedSession {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      this.requireWorkspace(ownerId, workspaceId);
      const prior = this.database
        .prepare("SELECT entity_id FROM idempotency_keys WHERE owner_id = ? AND scope = ? AND key = ?")
        .get(ownerId, `create-session:${workspaceId}`, idempotencyKey) as { entity_id: string } | undefined;
      if (prior) return this.requireHostedSession(ownerId, prior.entity_id);
      if (workspaceRuntimeActive) {
        throw conflict("workspace_runtime_active", "Workspace runtime is still stopping");
      }
      const active = this.database
        .prepare("SELECT id FROM hosted_sessions WHERE workspace_id = ? AND state IN ('queued','starting','running') LIMIT 1")
        .get(workspaceId);
      if (active) throw conflict("workspace_session_active", "Workspace already has an active hosted session");

      const sessionId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO hosted_sessions (id, workspace_id, owner_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(sessionId, workspaceId, ownerId, timestamp, timestamp);
      this.database
        .prepare("INSERT INTO idempotency_keys (owner_id, scope, key, entity_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(ownerId, `create-session:${workspaceId}`, idempotencyKey, sessionId, timestamp);
      return this.requireHostedSession(ownerId, sessionId);
    });
  }

  getHostedSession(ownerId: string, sessionId: string): HostedSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM hosted_sessions WHERE id = ? AND owner_id = ?")
      .get(sessionId, ownerId) as HostedSessionRow | undefined;
    return row ? mapHostedSession(row) : undefined;
  }

  requireHostedSession(ownerId: string, sessionId: string): HostedSession {
    const session = this.getHostedSession(ownerId, sessionId);
    if (!session) throw notFound("Hosted session");
    return session;
  }

  listHostedSessionsForWorkspace(ownerId: string, workspaceId: string): HostedSession[] {
    this.requireWorkspace(ownerId, workspaceId);
    const rows = this.database
      .prepare("SELECT * FROM hosted_sessions WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(workspaceId) as unknown as HostedSessionRow[];
    return rows.map(mapHostedSession);
  }

  /** Restarts a fully disconnected stopped session; every runtime teardown in its workspace must complete first. */
  startHostedSession(ownerId: string, sessionId: string, now: Date, workspaceRuntimeActive = false): HostedSession {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const session = this.requireHostedSession(ownerId, sessionId);
      if (session.state === "queued" || session.state === "starting" || session.state === "running") return session;
      const assignment = this.database
        .prepare("SELECT 1 FROM runtime_assignments WHERE hosted_session_id = ? AND stopped_at IS NULL")
        .get(sessionId);
      if (assignment) throw conflict("session_runtime_active", "Hosted session runtime is still stopping");
      if (workspaceRuntimeActive) {
        throw conflict("workspace_runtime_active", "Workspace runtime is still stopping");
      }
      const active = this.database
        .prepare(
          "SELECT id FROM hosted_sessions WHERE workspace_id = ? AND id <> ? AND state IN ('queued','starting','running') LIMIT 1",
        )
        .get(session.workspaceId, sessionId);
      if (active) throw conflict("workspace_session_active", "Workspace already has an active hosted session");
      this.transitionHostedSession(sessionId, session.state, "queued", "start_requested", timestamp);
      this.database.prepare("UPDATE hosted_sessions SET stopped_at = NULL WHERE id = ?").run(sessionId);
      return this.requireHostedSession(ownerId, sessionId);
    });
  }

  /** Idempotently marks a session stopped; used by an explicit stop request and by runtime disconnects alike. */
  stopHostedSession(ownerId: string, sessionId: string, now: Date): HostedSession {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const session = this.requireHostedSession(ownerId, sessionId);
      if (session.state === "stopped" || session.state === "archived") return session;
      this.transitionHostedSession(sessionId, session.state, "stopped", "stop_requested", timestamp, { stoppedAt: timestamp });
      this.database
        .prepare("UPDATE runtime_assignments SET stopped_at = ? WHERE hosted_session_id = ? AND stopped_at IS NULL")
        .run(timestamp, sessionId);
      return this.requireHostedSession(ownerId, sessionId);
    });
  }

  /** Same idempotent transition as {@link stopHostedSession} without an owner check, for runtime-driven disconnects. */
  markHostedSessionStoppedByRuntime(sessionId: string, now: Date): void {
    const timestamp = now.toISOString();
    this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM hosted_sessions WHERE id = ?").get(sessionId) as HostedSessionRow | undefined;
      if (!row) return;
      const session = mapHostedSession(row);
      if (session.state !== "stopped" && session.state !== "archived") {
        this.transitionHostedSession(sessionId, session.state, "stopped", "runtime_disconnected", timestamp, { stoppedAt: timestamp });
      }
      this.database
        .prepare("UPDATE runtime_assignments SET stopped_at = ? WHERE hosted_session_id = ? AND stopped_at IS NULL")
        .run(timestamp, sessionId);
    });
  }

  archiveHostedSession(ownerId: string, sessionId: string, now: Date): HostedSession {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const session = this.requireHostedSession(ownerId, sessionId);
      if (session.state === "archived") return session;
      if (session.state !== "stopped") throw conflict("session_not_stopped", "Hosted session must be stopped before it is archived");
      this.transitionHostedSession(sessionId, session.state, "archived", "archive_requested", timestamp, { archivedAt: timestamp });
      return this.requireHostedSession(ownerId, sessionId);
    });
  }

  /** Stops sessions whose ephemeral sockets were lost when this single API process restarted. */
  recoverHostedSessionsAfterControlPlaneRestart(now: Date): number {
    const timestamp = now.toISOString();
    return this.transaction(() => {
      const sessions = this.database
        .prepare("SELECT id FROM hosted_sessions WHERE state IN ('starting','running')")
        .all() as unknown as Array<{ id: string }>;
      for (const session of sessions) {
        this.database
          .prepare("UPDATE runtime_assignments SET stopped_at = ? WHERE hosted_session_id = ? AND stopped_at IS NULL")
          .run(timestamp, session.id);
        this.database
          .prepare("UPDATE hosted_sessions SET state = 'stopped', updated_at = ?, stopped_at = ? WHERE id = ?")
          .run(timestamp, timestamp, session.id);
      }
      return sessions.length;
    });
  }

  /** Atomically claims the oldest queued session for one runner and mints its scoped assignment token digest. */
  claimHostedRuntime(
    runnerId: string,
    assignmentId: string,
    tokenDigestValue: string,
    now: Date,
    assignmentTtlSeconds = 60,
  ): { session: HostedSession; workspace: Workspace } | undefined {
    const timestamp = now.toISOString();
    const expiresAt = new Date(now.getTime() + assignmentTtlSeconds * 1_000).toISOString();
    const staleHeartbeatAt = new Date(now.getTime() - assignmentTtlSeconds * 1_000).toISOString();
    return this.transaction(() => {
      const expired = this.database
        .prepare(
          `SELECT runtime_assignments.id, runtime_assignments.hosted_session_id
           FROM runtime_assignments
           JOIN hosted_sessions ON hosted_sessions.id = runtime_assignments.hosted_session_id
           WHERE runtime_assignments.stopped_at IS NULL
             AND runtime_assignments.expires_at <= ?
             AND (runtime_assignments.last_heartbeat_at IS NULL OR runtime_assignments.last_heartbeat_at <= ?)
             AND hosted_sessions.state = 'starting'`,
        )
        .all(timestamp, staleHeartbeatAt) as unknown as Array<{ id: string; hosted_session_id: string }>;
      for (const assignment of expired) {
        this.database.prepare("UPDATE runtime_assignments SET stopped_at = ? WHERE id = ?").run(timestamp, assignment.id);
        this.database
          .prepare("UPDATE hosted_sessions SET state = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND state = 'starting'")
          .run(timestamp, timestamp, assignment.hosted_session_id);
      }
      const row = this.database
        .prepare("SELECT * FROM hosted_sessions WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get() as HostedSessionRow | undefined;
      if (!row) return undefined;

      assertChanged(
        this.database
          .prepare("UPDATE hosted_sessions SET state = 'starting', updated_at = ? WHERE id = ? AND state = 'queued'")
          .run(timestamp, row.id),
        "Hosted session was claimed concurrently",
      );
      this.database
        .prepare(
          "INSERT INTO runtime_assignments (id, hosted_session_id, runner_id, token_digest, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(assignmentId, row.id, runnerId, tokenDigestValue, timestamp, expiresAt);

      const session = this.requireHostedSessionInternal(row.id);
      const workspace = this.requireWorkspaceInternal(session.workspaceId);
      return { session, workspace };
    });
  }

  /** Atomically consumes the assignment token that opens a hosted session's single internal tunnel. */
  authorizeRuntimeAssignment(sessionId: string, tokenDigestValue: string, now: Date): { assignmentId: string; session: HostedSession; workspace: Workspace } | undefined {
    return this.transaction(() => {
      const sessionRow = this.database.prepare("SELECT * FROM hosted_sessions WHERE id = ?").get(sessionId) as HostedSessionRow | undefined;
      if (!sessionRow || sessionRow.state !== "starting") return undefined;
      const session = mapHostedSession(sessionRow);
      const timestamp = now.toISOString();
      const consumed = this.database
        .prepare(
          `UPDATE runtime_assignments
           SET last_heartbeat_at = ?
           WHERE hosted_session_id = ? AND token_digest = ? AND stopped_at IS NULL
             AND last_heartbeat_at IS NULL AND expires_at > ?`,
        )
        .run(timestamp, sessionId, tokenDigestValue, timestamp);
      if (Number(consumed.changes) !== 1) return undefined;
      const row = this.database
        .prepare("SELECT * FROM runtime_assignments WHERE hosted_session_id = ? AND token_digest = ?")
        .get(sessionId, tokenDigestValue) as RuntimeAssignmentRow;
      const workspace = this.requireWorkspaceInternal(session.workspaceId);
      return { assignmentId: row.id, session, workspace };
    });
  }

  markHostedSessionRunning(sessionId: string, now: Date): void {
    const timestamp = now.toISOString();
    this.transaction(() => {
      const session = this.requireHostedSessionInternal(sessionId);
      if (session.state !== "starting") return;
      this.transitionHostedSession(sessionId, "starting", "running", "runtime_connected", timestamp, { startedAt: timestamp });
    });
  }

  /** Persists opaque native Pi session metadata reported once at runtime startup. */
  recordNativeSessionMetadata(sessionId: string, nativeSessionId: string, nativeSessionFile: string, now: Date): boolean {
    const timestamp = now.toISOString();
    const result = this.database
      .prepare(
        `UPDATE hosted_sessions
         SET native_session_id = ?, native_session_file = ?, updated_at = ?
         WHERE id = ?
           AND (native_session_id IS NULL OR native_session_id = ?)
           AND (native_session_file IS NULL OR native_session_file = ?)`,
      )
      .run(nativeSessionId, nativeSessionFile, timestamp, sessionId, nativeSessionId, nativeSessionFile);
    return result.changes === 1;
  }

  touchAssignmentHeartbeat(assignmentId: string, now: Date): void {
    this.database
      .prepare("UPDATE runtime_assignments SET last_heartbeat_at = ? WHERE id = ? AND stopped_at IS NULL")
      .run(now.toISOString(), assignmentId);
  }

  /** Rechecks durable authority after WebSocket upgrade hooks and lifecycle requests race. */
  isHostedRuntimeAssignmentAttachable(assignmentId: string, sessionId: string): boolean {
    return this.database
      .prepare(
        `SELECT 1 FROM runtime_assignments
         JOIN hosted_sessions ON hosted_sessions.id = runtime_assignments.hosted_session_id
         WHERE runtime_assignments.id = ? AND runtime_assignments.hosted_session_id = ?
           AND runtime_assignments.stopped_at IS NULL AND hosted_sessions.state = 'starting'`,
      )
      .get(assignmentId, sessionId) !== undefined;
  }

  /** Rechecks the durable session state before an upgraded public socket starts routing commands. */
  isHostedSessionRunning(sessionId: string): boolean {
    return this.database.prepare("SELECT 1 FROM hosted_sessions WHERE id = ? AND state = 'running'").get(sessionId) !== undefined;
  }

  private requireHostedSessionInternal(sessionId: string): HostedSession {
    const row = this.database.prepare("SELECT * FROM hosted_sessions WHERE id = ?").get(sessionId) as HostedSessionRow | undefined;
    if (!row) throw notFound("Hosted session");
    return mapHostedSession(row);
  }

  private requireWorkspaceInternal(workspaceId: string): Workspace {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as WorkspaceRow | undefined;
    if (!row) throw notFound("Workspace");
    return mapWorkspace(row);
  }

  private transitionHostedSession(
    sessionId: string,
    from: HostedSessionState,
    to: HostedSessionState,
    reason: string,
    timestamp: string,
    fields: { startedAt?: string; stoppedAt?: string; archivedAt?: string } = {},
  ): void {
    if (!legalHostedSessionTransitions[from].has(to)) {
      throw conflict("invalid_transition", `Cannot transition hosted session from ${from} to ${to}`);
    }
    assertChanged(
      this.database
        .prepare(
          `UPDATE hosted_sessions SET state = ?, updated_at = ?,
           started_at = COALESCE(?, started_at), stopped_at = COALESCE(?, stopped_at), archived_at = COALESCE(?, archived_at)
           WHERE id = ? AND state = ?`,
        )
        .run(to, timestamp, fields.startedAt ?? null, fields.stoppedAt ?? null, fields.archivedAt ?? null, sessionId, from),
      `Hosted session transition (${reason}) was stale`,
    );
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

  private getCheckoutProvenance(runId: string): CheckoutProvenance | null {
    const row = this.database.prepare("SELECT * FROM checkout_provenance WHERE run_id = ?").get(runId) as
      | CheckoutProvenanceRow
      | undefined;
    return row ? mapCheckoutProvenance(row) : null;
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

type DuplicateEventRow = EventRow & {
  lease_token_digest: string;
  lease_revoked_at: string | null;
};

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
    checkoutProvenance: null,
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

function mapCheckoutProvenance(row: CheckoutProvenanceRow): CheckoutProvenance {
  return {
    repositoryUrl: row.repository_url,
    revision: row.revision,
    resolvedCommit: row.resolved_commit,
    transport: row.transport,
    credentialSource: row.credential_source,
    credentialScrubbed: true,
    submodulesInitialized: false,
    hooksDisabled: true,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    ownerId: row.owner_id,
    repositoryUrl: row.repository_url,
    revision: row.revision,
    root: row.root,
    projectTrust: row.project_trust,
    agentDirectory: row.agent_directory,
    credentialReferences: JSON.parse(row.credential_references_json) as HostedCredentialReference[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHostedSession(row: HostedSessionRow): HostedSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    state: hostedSessionStateSchema.parse(row.state),
    nativeSessionId: row.native_session_id,
    nativeSessionFile: row.native_session_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    archivedAt: row.archived_at,
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
  if (run.startedAt !== null && now.getTime() - new Date(run.startedAt).getTime() > budgets.wallTimeSeconds * 1_000) {
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

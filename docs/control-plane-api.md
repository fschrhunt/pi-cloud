# Durable control-plane API

Pi Cloud's first durable control-plane contract stores metadata in SQLite and keeps all repository execution in disposable runners. SQLite is the concrete pre-alpha requirement: one API process needs restart-safe transactional state without an external service. It is not the future multi-node queue; moving to Postgres will require preserving the transaction boundaries described below.

`node:sqlite` requires Node 22.5 or newer. Migrations run transactionally when the API opens the configured `PI_CLOUD_DATABASE_PATH`. File databases use WAL, foreign keys, a busy timeout, and synchronous state transitions. Tests use the same migrations against in-memory or temporary file databases.

## Authentication

`PI_CLOUD_API_CREDENTIALS` is a JSON array of bootstrap user/service bearer identities. Public `/v1` routes require one of those tokens and constrain every agent, run, event stream, archive, cancellation, and delete operation to its subject. Tokens are hashed before lookup and are never returned.

`PI_CLOUD_DISPATCHER_TOKEN` protects claim and recovery operations. A claimed runner receives a signed lease once. Redemption verifies its signature, expiry, audience, task, and assigned runner, then atomically marks it consumed. Later runner requests prove possession against the stored token hash, so heartbeats can extend assignment liveness without changing the signed lease's five-minute redemption lifetime.

## Public lifecycle

Create operations require an `Idempotency-Key` header (8–200 characters).

- `POST /v1/agents` creates one durable agent, initial run, and dispatch task.
- `GET /v1/agents` and `GET /v1/runs` return cursor-paginated owned records.
- `GET /v1/agents/:agentId` returns the agent and its finite runs.
- `GET /v1/runs/:runId` returns status, configured/consumed budgets, terminal reason, and transition history.
- `POST /v1/agents/:agentId/runs` adds a follow-up only when no mutating run is active.
- `POST /v1/runs/:runId/cancel` persists cooperative cancellation intent.
- `POST /v1/agents/:agentId/archive` and `/unarchive` change visibility without deleting evidence.
- `DELETE /v1/agents/:agentId` permanently removes an agent only after all runs are terminal.

Agent creation records the authenticated creator/requester, API origin, exact repository revision, environment target, runner pool, and timestamps. The API stores metadata only; it never clones or loads repository content.

## Dispatch and recovery

- `POST /internal/v1/runs/claim` atomically assigns the oldest eligible queued task to one runner and returns its signed lease.
- `POST /internal/v1/leases/redeem` consumes that lease exactly once before execution.
- `POST /internal/v1/leases/:leaseId/heartbeat` records monotonic usage and returns cancellation intent.
- `POST /internal/v1/recovery` reaps expired unredeemed assignments and lost runners.

Recovery first revokes the old assignment. It then applies bounded exponential backoff or records `infrastructure_retries_exhausted`; it never leaves two active leases for one run. Cancellation wins recovery races and becomes terminal. Heartbeats report CPU seconds, peak memory, artifact bytes, and provider usage when available. Wall time starts at lease redemption, while idle time follows runner heartbeats. Runs also bound events and retries.

## Durable events

`POST /internal/v1/runs/:runId/events` accepts only the versioned allowlist:

- `run.started`
- `run.progress`
- `run.waiting`
- `run.warning`
- `run.result`

Each event has a runner UUID, an assignment-local contiguous runner sequence, bounded typed payload, server timestamp, per-run monotonic sequence, and opaque cursor. A replacement runner starts its assignment-local sequence at one while the durable per-run sequence continues across attempts. Runner UUID retries are idempotent; changed duplicates, gaps, unknown kinds, extra payload fields, per-event overflow, and cumulative event-budget overflow fail closed. Raw tool inputs/outputs are not fields in this contract; runners must sanitize the short allowlisted messages before ingestion.

`GET /v1/runs/:runId/events` streams stored events as SSE in bounded database batches. Reconnect with the last opaque SSE ID through `Last-Event-ID` or `?cursor=`. The server replays only later events, emits heartbeat comments while following, and ends after a terminal run. `?follow=false` drains the available replay without holding the full tail in memory. Unknown or cross-run cursors fail closed; a cursor removed by retention tells the client to reload terminal run state.

# Durable control-plane API

Pi Cloud's first durable control-plane contract stores metadata in SQLite and keeps repository execution in the local Pi host rather than the network-facing API. SQLite is the intended single-server baseline: one API process needs restart-safe transactional state without an external service. If a concrete self-hosted use case later requires another database, it must preserve the transaction boundaries described below.

This document retains the original agent/run dispatch contract. The M2 workspace, hosted-session, and native Pi RPC transport are documented in [hosted-runtime.md](hosted-runtime.md). Both surfaces share authentication and the API/runtime execution boundary.

Pi Cloud requires Node 22.19 or newer, which also satisfies `node:sqlite`. Migrations run transactionally when the API opens the configured `PI_CLOUD_DATABASE_PATH`. File databases use WAL, foreign keys, a busy timeout, and synchronous state transitions. Tests use the same migrations against in-memory or temporary file databases.

## Authentication

`PI_CLOUD_API_CREDENTIALS` is a JSON array of bootstrap user/service bearer identities. Public `/v1` HTTP routes other than the safe `GET /v1/capabilities` document require one of those tokens and constrain every agent, run, workspace, hosted session, RPC attachment, archive, cancellation, and delete operation to its subject. Tokens are hashed before lookup and are never returned. Non-browser RPC clients may authenticate the WebSocket upgrade with the same bearer; browser clients exchange it over authenticated HTTP for a 60-second, single-use, session-scoped attachment ticket carried in the WebSocket subprotocol header. Issuing a new ticket revokes any older outstanding ticket for that hosted session.

`PI_CLOUD_DISPATCHER_TOKEN` protects claim and recovery operations. A claimed runner receives a signed lease once. Redemption verifies its signature, expiry, audience, task, and assigned runner, then atomically marks it consumed. Later runner requests prove possession against the stored token hash, so heartbeats can extend assignment liveness without changing the signed lease's five-minute redemption lifetime.

## Public lifecycle

Create operations require an `Idempotency-Key` header (8–200 characters).

- `POST /v1/agents` creates one durable agent, initial run, and dispatch task.
- `GET /v1/agents` and `GET /v1/runs` return cursor-paginated owned records.
- `GET /v1/agents/:agentId` returns the agent and its finite runs.
- `GET /v1/runs/:runId` returns status, configured/consumed budgets, terminal reason, checkout provenance, and transition history.
- `POST /v1/agents/:agentId/runs` adds a follow-up only when no mutating run is active.
- `POST /v1/runs/:runId/cancel` persists cooperative cancellation intent.
- `POST /v1/agents/:agentId/archive` and `/unarchive` change visibility without deleting evidence.
- `DELETE /v1/agents/:agentId` permanently removes an agent only after all runs are terminal.

Agent creation records the authenticated creator/requester, API origin, exact repository revision, environment target, runner pool, and timestamps. The API stores metadata only; it never clones or loads repository content.

## Hosted workspace and session lifecycle

`GET /v1/capabilities` is an unauthenticated, versioned compatibility preflight for the Mac extension. It exposes only service and protocol versions plus supported hosted-session features.

Hosted workspace and session metadata is owner-scoped and durable, while runtime and client WebSockets remain disposable:

- `POST /v1/workspaces`, `GET /v1/workspaces`, and `GET /v1/workspaces/:workspaceId` create and read owned workspace metadata.
- `GET /v1/workspaces/:workspaceId/sessions` lists the owned workspace's hosted sessions for terminal resume.
- `POST /v1/workspaces/:workspaceId/sessions` creates one queued hosted session. A workspace cannot have another queued, starting, or running session, and cannot create a replacement while its stopped runtime tunnel is still closing.
- `GET /v1/hosted-sessions/:sessionId` reads owned session state.
- `POST /v1/hosted-sessions/:sessionId/start`, `/stop`, and `/archive` enforce the queued, starting, running, stopped, and archived lifecycle. Stop immediately closes the mutating client and asks the runtime to shut down; restart and archive wait for its tunnel to close.
- `GET /v1/hosted-sessions/:sessionId/rpc` attaches one authenticated client to a running session. Non-browser clients may use the normal bearer header.
- `POST /v1/hosted-sessions/:sessionId/rpc-ticket` returns a non-cacheable, 60-second, single-use browser attachment ticket. The browser offers `pi-cloud-ticket.<ticket>` and `pi-cloud-rpc` in `Sec-WebSocket-Protocol`; the server selects only `pi-cloud-rpc`. Issuing a newer ticket revokes the prior unused ticket for that session.

The internal dispatcher claims the oldest queued session through `POST /internal/v1/hosted-runtimes/claim`. The claim contains a 60-second, single-use tunnel token and only the credential values granted to that workspace; SQLite stores token digests and credential references, never those values. `GET /internal/v1/hosted-sessions/:sessionId/tunnel` consumes the token and rechecks its assignment after the WebSocket upgrade so a concurrent stop cannot restore stale runtime authority.

Both WebSocket directions accept complete text JSON envelopes, validate their schemas, session IDs, direction, and contiguous sequence, and enforce configured record and cumulative byte limits. A policy failure detaches the offending connection before processing any queued frames. Runtime heartbeat expiry durably stops the session, while API restart recovery stops sessions whose ephemeral tunnels were lost. The API stores only opaque native Pi session identity and file metadata; it does not persist transcript records.

## Dispatch and recovery

- `POST /internal/v1/runs/claim` atomically assigns the oldest eligible queued task to one runner and returns its signed lease.
- `POST /internal/v1/leases/redeem` consumes that lease exactly once before execution.
- `POST /internal/v1/runs/:runId/checkout-provenance` stores the hardened checkout evidence for the redeemed assignment.
- `POST /internal/v1/leases/:leaseId/heartbeat` records monotonic usage and returns cancellation intent.
- `POST /internal/v1/recovery` reaps expired unredeemed assignments and lost runners.

Recovery first revokes the old assignment. It then applies bounded exponential backoff or records `infrastructure_retries_exhausted`; it never leaves two active leases for one run. Cancellation wins recovery races and becomes terminal. Heartbeats report CPU seconds, peak memory, artifact bytes, and provider usage when available. Wall time starts at lease redemption, while idle time follows runner heartbeats. Runs also bound events and retries. Checkout provenance is written only by the authenticated redeemed runner and is replaced only by a later redeemed assignment for the same run.

## Durable events

`POST /internal/v1/runs/:runId/events` accepts only the versioned allowlist:

- `run.started`
- `run.progress`
- `run.waiting`
- `run.warning`
- `run.result`

Each event has a runner UUID, an assignment-local contiguous runner sequence, bounded typed payload, server timestamp, per-run monotonic sequence, and opaque cursor. A replacement runner starts its assignment-local sequence at one while the durable per-run sequence continues across attempts. Runner UUID retries are idempotent; changed duplicates, gaps, unknown kinds, extra payload fields, per-event overflow, and cumulative event-budget overflow fail closed. Raw tool inputs/outputs are not fields in this contract; runners must sanitize the short allowlisted messages before ingestion.

`GET /v1/runs/:runId/events` streams stored events as SSE in bounded database batches. Reconnect with the last opaque SSE ID through `Last-Event-ID` or `?cursor=`. The server replays only later events, emits heartbeat comments while following, and ends after a terminal run. `?follow=false` drains the available replay without holding the full tail in memory. Unknown or cross-run cursors fail closed; a cursor removed by retention tells the client to reload terminal run state.

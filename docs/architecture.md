# Architecture

## Purpose

Pi Cloud separates **orchestration** from **code execution**. The control plane coordinates identity, task state, policy, and durable records. A disposable runner is the only component allowed to clone repositories or invoke Pi.

## Components

### Control plane (`apps/api`)

Owns authenticated agents, finite runs, dispatch tasks, lifecycle history, budgets, task leases, and the public event API. Metadata is durably stored in a transactional SQLite database for the single-process pre-alpha control plane. It must not mount a task workspace, run shell commands supplied by a repository, or receive long-lived model credentials from a runner.

### Runner (`apps/runner`)

Receives one signed, time-limited task lease. It creates an isolated workspace, checks out exactly the lease's repository revision, starts Pi with `pi --mode rpc`, and forwards a structured allowlisted event stream. The runner publishes a patch and selected artifacts, then destroys the workspace and its credentials.

### Sandbox provider

Abstracts VM/container lifecycle only. The local implementation is Docker, configured with a non-root user, read-only filesystem, dropped capabilities, resource limits, and no network. This is a developer smoke-test environment—not an adequate hosted multi-tenant boundary. Production should use one disposable microVM per task; the runner protocol must remain suitable for customer-hosted runners.

## Current vertical slice

The authenticated `/v1/agents` API creates a durable conversation, initial finite run, and queued dispatch task for an exact repository revision. SQLite transactions record legal lifecycle transitions, idempotency, one active mutating run per agent, budgets, cancellation, atomic assignment, single-use lease redemption, checkout provenance, bounded recovery, and append-only events. User/service credentials authorize public records; a separate dispatcher credential claims work. Reconnectable SSE replays events by opaque cursor across API restarts.

This slice now includes exact-revision checkout and durable checkout provenance, but it still stops before Pi process startup. The runner redeems one assignment, materializes the detached repository revision under hardened Git policy, and reports that evidence before later milestones invoke Pi.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Browser → control plane | Authenticate every request; authorize by repository installation and task membership. |
| Control plane → runner | Use signed, single-task leases with expiry and audience. Add durable single-use consumption before repository execution. |
| Runner → repository | Treat checkout hooks, dependencies, and project-local Pi extensions as untrusted code. |
| Runner → external network | Deny by default; allow only required Git, package, model, and task endpoints. |
| Runner → control plane | Redact configured secrets; accept an allowlisted event schema and bounded artifact sizes. |

## Task leases

The control plane signs a versioned, five-minute Ed25519 lease that binds one lease ID, task ID, HTTPS repository URL, immutable revision, issuer, and runner-pool audience. Atomic dispatch persists the assignment and token digest; redemption verifies the signed claims and assigned runner exactly once before repository execution. Heartbeats maintain the redeemed assignment without extending the cryptographic redemption lifetime. The runner also identifies itself explicitly so durable provenance can be tied to the redeemed assignment before checkout. See [task-leases.md](task-leases.md) and [control-plane-api.md](control-plane-api.md).

## Pi integration

The runner starts the installed Pi CLI in RPC mode and communicates using LF-delimited JSONL. Pi's local session file remains inside the task sandbox. Pi Cloud may retain a sanitized transcript and task metadata, but must not assume Pi's internal session format is a stable database schema.

## Deliberate non-goals for the first slice

- Browser-based IDE
- Multi-agent scheduling
- Persistent development VMs
- Broad, unrestricted network access
- Storing users' long-lived model provider tokens in runner images

The first end-to-end vertical slice is: create task → lease disposable runner → clone one repository → start Pi RPC → stream events → retain patch → destroy runner.

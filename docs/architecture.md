# Architecture

## Purpose

Pi Cloud is an open-source, self-hosted server that keeps Pi available remotely on operator-owned infrastructure. It separates the network-facing control plane from the local Pi host: the control plane coordinates identity and durable records, while the Pi host owns repository workspaces and embeds Pi through its supported SDK.

## Components

### Control plane (`apps/api`)

Owns authentication, repository and session metadata, lifecycle history, scheduling, and the public event API. Metadata is durably stored in transactional SQLite for the single-server architecture. It does not mount workspaces or run repository commands.

### Local Pi host (`apps/runner`)

Runs as part of the same self-hosted installation. It owns persistent repository workspaces and creates Pi `AgentSession` runtimes with `@earendil-works/pi-coding-agent`. It streams supported Pi events to the control plane and accepts prompts, steering, follow-ups, cancellation, and session replacement commands. Pi's `DefaultResourceLoader` remains the source of extensions, skills, prompt templates, themes, providers, packages, settings, and project trust behavior.

The existing signed task lease remains an internal authorization boundary between the API and Pi host. It must not turn the product into a proprietary external runner service.

### Optional execution isolation

The operator chooses the execution boundary. A trusted personal server may use a persistent local workspace. Untrusted or unattended repositories should run the Pi host in a container, VM, micro-VM, or policy-controlled sandbox. Docker Compose is the default deployment shape; multi-tenant infrastructure and a managed microVM fleet are not baseline requirements.

## Current vertical slice

The authenticated `/v1/agents` API creates a durable conversation, initial finite run, and queued dispatch task for an exact repository revision. SQLite transactions record legal lifecycle transitions, idempotency, one active mutating run per agent, budgets, cancellation, atomic assignment, single-use lease redemption, checkout provenance, bounded recovery, and append-only events. User/service credentials authorize public records; a separate dispatcher credential claims work. Reconnectable SSE replays events by opaque cursor across API restarts.

This slice includes exact-revision checkout and durable checkout provenance, but it stops before Pi process startup. The current runner redeems one assignment, materializes the detached repository revision under hardened Git policy, and reports that evidence to the control plane.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Browser → control plane | Authenticate every request and apply the self-hosted instance's repository/session access policy. |
| Control plane → Pi host | Use authenticated internal commands; the existing signed lease provides single-use authorization for work starts. |
| Pi host → repository | Treat dependencies and project-local Pi resources as executable code; honor Pi project trust and operator policy. |
| Pi host → external network | Make effective Git, package, model, and extension access visible and configurable by the operator. |
| Pi host → control plane | Redact configured secrets; accept an allowlisted event schema and bounded artifact sizes. |

## Task leases

The control plane signs a versioned, five-minute Ed25519 lease that binds one lease ID, task ID, HTTPS repository URL, immutable revision, issuer, and runner-pool audience. Atomic dispatch persists the assignment and token digest; redemption verifies the signed claims and assigned runner exactly once before repository execution. Heartbeats maintain the redeemed assignment without extending the cryptographic redemption lifetime. The runner also identifies itself explicitly so durable provenance can be tied to the redeemed assignment before checkout. See [task-leases.md](task-leases.md) and [control-plane-api.md](control-plane-api.md).

## Pi integration

The local Pi host embeds `@earendil-works/pi-coding-agent` and creates `AgentSessionRuntime` instances through the supported SDK. This gives Pi Cloud typed session replacement, event streaming, model control, tools, settings, and resource loading without reimplementing Pi or parsing its internal session files.

Pi Cloud must preserve Pi's extension contract. Global and project extensions, skills, prompt templates, themes, providers, and packages load through Pi's resource APIs with their normal provenance and project-trust rules. Web clients should bridge supported extension dialogs, notifications, status, and widgets; terminal-only UI may degrade explicitly rather than being silently treated as available.

## Deliberate non-goals

- A proprietary hosted control plane or paid runner fleet
- Enterprise multi-tenant infrastructure
- Browser-based IDE
- Reimplementing Pi sessions, tools, providers, or extension APIs
- Requiring microVMs for trusted single-user installations

The first target vertical slice is: connect to a self-hosted server → open a repository workspace → create an embedded Pi session → stream and steer it remotely → reconnect to the durable session → review its result.

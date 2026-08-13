<p align="center">
  <img src="./assets/logo.svg" width="220" alt="Pi Cloud logo">
</p>

> An open-source, self-hosted, always-on home for Pi.

# Pi Cloud

Run Pi on your own always-on server, connect from a browser or API, and keep durable coding sessions close to your repositories and infrastructure.

> [!WARNING]
> Pi Cloud is **pre-alpha**. The repository contains an early control-plane slice, not a ready-to-deploy self-hosted server. Do not use it with untrusted repositories or real credentials yet.

Pi Cloud is not a hosted coding-agent service, a browser clone of [Pi](https://pi.dev), or an IDE. **Pi is the agent runtime inside Pi Cloud.** Pi Cloud provides durable remote access, repository workspaces, scheduling, and web/API surfaces around Pi on infrastructure the operator controls.

## Why Pi Cloud

| Principle | What it means |
| --- | --- |
| **Open source** | Keep the complete server, web client, and Pi integration available to inspect, modify, and run without a proprietary control plane. |
| **Self-hosted first** | Make one always-on Linux server and Docker Compose the primary production shape, not a fallback for a hosted service. |
| **Pi-native** | Embed Pi through its supported SDK and preserve its session, model, tool, and event behavior instead of recreating an agent. |
| **Extensible by design** | Load Pi extensions, skills, prompt templates, themes, providers, and packages with their normal global and project scopes. |
| **Operator-controlled** | Keep repositories, credentials, retention, network policy, and optional sandboxing under the server operator's control. |
| **Human-steered** | Stream agent events, support follow-ups and cancellation, and make consequential actions reviewable. |

## Architecture

```text
browser / API / automation
          │
          ▼
 Pi Cloud server (apps/api) ─── users, repositories, durable session index
          │
          ▼
 local Pi host (apps/runner) ─── @earendil-works/pi-coding-agent SDK
          │                      ├── persistent repository workspaces
          │                      ├── Pi sessions and resource discovery
          │                      └── extensions, skills, prompts, themes, packages
          ▼
 live events, review, scheduling, Git delivery ─── client
```

A standard installation runs both services on one operator-owned server. The API does not execute repository code; the local Pi host does. Operators may place the Pi host in a container, VM, or another sandbox, but Pi Cloud does not require a proprietary runner service or multi-tenant infrastructure.

Read [`docs/architecture.md`](docs/architecture.md) for component responsibilities, trust boundaries, and deliberate non-goals.

## What works today

- Authenticated, SQLite-backed durable agents, finite runs, tasks, and lifecycle history
- Cursor-paginated lifecycle API with idempotent create, follow-up, cancellation, archive, and delete contracts
- Atomic runner dispatch and single-use, task-bound Ed25519 lease redemption
- Persisted run budgets, heartbeats, bounded retry/recovery, and terminal reasons
- Append-only allowlisted events with opaque-cursor SSE reconnect
- Pi host boot configuration and lease verification
- Restrictive local Docker execution baseline
- TypeScript workspace checks, builds, and focused restart/concurrency/reconnect tests

The current slice deliberately stops before repository checkout and an embedded Pi session. See [`docs/control-plane-api.md`](docs/control-plane-api.md) and [`docs/task-leases.md`](docs/task-leases.md).

## Quick start

### Requirements

- Node.js 22.5+ (`node:sqlite`)
- npm 11+
- Docker for the local runner smoke test
- A Pi-supported model credential once RPC execution is connected

### Run the control plane

```bash
npm install
eval "$(node scripts/create-development-keys.mjs)" # Inspect the script before evaluating.
export PI_CLOUD_DISPATCHER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_USER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_API_CREDENTIALS="[{\"token\":\"$PI_CLOUD_USER_TOKEN\",\"subjectId\":\"local-user\",\"type\":\"user\",\"displayName\":\"Local User\"}]"
npm run dev:api
```

In another terminal, check the service:

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok","service":"pi-cloud-api"}
```

Create a durable agent and initial run:

```bash
curl -X POST http://localhost:3000/v1/agents \
  -H "authorization: Bearer $PI_CLOUD_USER_TOKEN" \
  -H 'idempotency-key: local-agent-0001' \
  -H 'content-type: application/json' \
  -d '{
    "repositoryUrl": "https://github.com/pi-cloud/example",
    "revision": "4f3c2d1",
    "prompt": "Inspect the repository."
  }'
```

The default database is `./data/pi-cloud.sqlite`. See the [durable control-plane API](docs/control-plane-api.md) for lifecycle, dispatch, event, and recovery endpoints.

### Smoke-test the Pi host

The current Compose service only verifies the execution host's boot boundary: non-root user, read-only filesystem, dropped Linux capabilities, resource limits, and no network. Generate a development key pair, then mint a five-minute lease for a task UUID and exact revision:

```bash
eval "$(node scripts/create-development-keys.mjs)" # Inspect the script before evaluating.
npm run build --workspace=@pi-cloud/contracts
export PI_CLOUD_TASK_LEASE="$(node scripts/create-development-lease.mjs \
  a0d701e3-bae6-427a-bc22-35d885915da3 \
  https://github.com/pi-cloud/example \
  4f3c2d1)"
docker compose run --rm runner
```

`PI_CLOUD_TASK_LEASE_PRIVATE_KEY` and `PI_CLOUD_TASK_LEASE_PUBLIC_KEY` must contain the generated pair. This validates boot configuration only; it is not yet the self-hosted Pi runtime.

## Repository map

```text
apps/
  api/       Fastify control plane, durable lifecycle API, dispatch, and events
  runner/    Local Pi execution host, configuration, and Docker image
packages/
  contracts/ Shared runner/control-plane wire contracts
assets/      Project identity assets
docs/        Architecture and operating decisions
scripts/     Local development key and lease helpers
compose.yaml Local runner smoke test
```

## Development

Run the complete validation suite before handing off a change:

```bash
npm run check
npm run build
npm test
```

| Dependency | Role |
| --- | --- |
| [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | Pi CLI and RPC mode, executed inside a runner |
| Node `node:sqlite` | Transactional pre-alpha control-plane metadata and migrations |
| [Fastify](https://fastify.dev/) + `@fastify/cors` | Typed control-plane HTTP API |
| [Zod](https://zod.dev/) | Validation for untrusted API, lease, and runner inputs |
| TypeScript + `tsx` | Type checking and local TypeScript execution |

Postgres, multi-node dispatch, object storage, and managed runner infrastructure are not product requirements. Add infrastructure only when a concrete self-hosted use case cannot be met by the single-server architecture.

## Roadmap

Milestones are ordered around a useful open-source server:

1. **Complete — Durable server foundation:** durable records, authenticated lifecycle APIs, event replay, cancellation, and recovery.
2. **Pi as the server runtime:** embed Pi's SDK in the local execution host and support durable sessions, native events, steering, and repository workspaces.
3. **Self-hosted single-server release:** provide a documented Docker Compose installation with local credentials, workspace lifecycle, upgrades, backup, and restore.
4. **Remote web workspace:** start, reconnect to, steer, cancel, and review Pi sessions from a focused browser interface.
5. **Pi-native extensibility:** preserve Pi extensions, skills, prompts, themes, providers, packages, project trust, and extension interactions through the hosted runtime.
6. **Git workflows and automation:** add reviewable branch/PR delivery plus optional API, webhook, schedule, GitHub, Linear, and Slack entry points.
7. **Reliable always-on operation:** make long-running self-hosted use observable, bounded, recoverable, and maintainable without enterprise infrastructure.

## Security baseline

Treat every repository and Pi package as executable code. Pi extensions run with the Pi host's permissions, so only install trusted packages and make project trust explicit. A self-hosted operator may choose persistent trusted workspaces or stronger container/VM isolation for untrusted work.

Keep credentials scoped, redact them from remote events, and never expose the Pi host directly to unauthenticated clients. Pi Cloud should use Pi's supported SDK and resource APIs rather than depending on its internal session-file format.

## Contributing

Prefer small vertical slices that preserve the control-plane/runner boundary. Do not add a dependency merely to anticipate a future feature; document the concrete requirement first.

## License

[MIT](LICENSE)

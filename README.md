<p align="center">
  <img src="./assets/logo.svg" width="220" alt="Pi Cloud logo">
</p>

> Secure, ephemeral coding environments for Pi.

# Pi Cloud

Connect a repository, launch an isolated runner, steer Pi in real time, and turn the resulting patch into a pull request.

> [!WARNING]
> Pi Cloud is **pre-alpha**. The repository contains a local vertical slice, not a production-ready sandbox. Do not use it to process untrusted repositories or real credentials yet.

Pi Cloud is not a browser clone of [Pi](https://pi.dev), and it is not an IDE. **Pi remains the agent.** Pi Cloud provides the control plane, isolation boundary, live event transport, and delivery workflow around it.

## Why Pi Cloud

| Principle | What it means |
| --- | --- |
| **Pi-native** | Run the existing Pi CLI in RPC mode instead of recreating its session or tool model. |
| **Ephemeral by default** | Give each repository task one isolated workspace with a bounded lifetime. |
| **Human-steered** | Stream agent events, expose diffs and logs, and require approval for consequential actions. |
| **Provider-independent** | Start with bring-your-own provider credentials rather than a proprietary model gateway. |
| **Portable isolation** | Keep the runner protocol suitable for managed infrastructure and customer VPCs. |

## Architecture

```text
GitHub App / web client
          │
          ▼
  Control plane (apps/api) ─── tasks, users, audit records
          │
          │ signed, short-lived task lease
          ▼
  Runner (apps/runner) ─── disposable VM or container
          │                    ├── cloned repository
          │                    ├── scoped secrets
          │                    └── pi --mode rpc
          ▼
 event stream, patch, artifacts ─── control plane ─── client / GitHub PR
```

The **control plane never executes repository code**. Disposable runners do, with an explicit network policy, CPU/memory/time budgets, scoped credentials, and cleanup after every task.

Read [`docs/architecture.md`](docs/architecture.md) for component responsibilities, trust boundaries, and deliberate non-goals.

## What works today

- Fastify control-plane service with a health endpoint
- Validated, in-memory task creation and lookup API
- Signed, short-lived, task-bound Ed25519 runner leases
- Runner boot configuration and lease verification
- Restrictive local Docker runner baseline
- TypeScript workspace checks, builds, and focused tests

The current slice deliberately stops before user authentication, durable storage, task dispatch, repository checkout, and Pi process startup. Lease consumption is not replay-safe until dispatch state is durable; see [`docs/task-leases.md`](docs/task-leases.md).

## Quick start

### Requirements

- Node.js 22+
- npm 11+
- Docker for the local runner smoke test
- A Pi-supported model credential once RPC execution is connected

### Run the control plane

```bash
npm install
eval "$(node scripts/create-development-keys.mjs)" # Inspect the script before evaluating.
export PI_CLOUD_DISPATCHER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
npm run dev:api
```

In another terminal, check the service:

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok","service":"pi-cloud-api"}
```

Create an in-memory task:

```bash
curl -X POST http://localhost:3000/v1/tasks \
  -H 'content-type: application/json' \
  -d '{
    "repositoryUrl": "https://github.com/pi-cloud/example",
    "revision": "4f3c2d1",
    "prompt": "Inspect the repository."
  }'
```

### Smoke-test the runner

The Compose service boots as a non-root user with a read-only filesystem, dropped Linux capabilities, resource limits, and no network. Generate a development key pair, then mint a five-minute lease for a task UUID and exact revision:

```bash
eval "$(node scripts/create-development-keys.mjs)" # Inspect the script before evaluating.
npm run build --workspace=@pi-cloud/contracts
export PI_CLOUD_TASK_LEASE="$(node scripts/create-development-lease.mjs \
  a0d701e3-bae6-427a-bc22-35d885915da3 \
  https://github.com/pi-cloud/example \
  4f3c2d1)"
docker compose run --rm runner
```

`PI_CLOUD_TASK_LEASE_PRIVATE_KEY` and `PI_CLOUD_TASK_LEASE_PUBLIC_KEY` must contain the generated pair. This validates boot configuration only. Docker is a local-development provider—not an adequate hosted multi-tenant boundary.

## Repository map

```text
apps/
  api/       Fastify control plane and in-memory task API
  runner/    Pi RPC runner entry point, configuration, and Docker image
contracts/    Shared runner/control-plane wire contracts
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
| [Fastify](https://fastify.dev/) + `@fastify/cors` | Typed control-plane HTTP API |
| [Zod](https://zod.dev/) | Validation for untrusted API, lease, and runner inputs |
| TypeScript + `tsx` | Type checking and local TypeScript execution |

Postgres, a durable queue, object storage, a GitHub App SDK, and browser automation are intentional next dependencies—not install-time assumptions. Each should follow a concrete requirement in the task and runner protocol.

## Roadmap

1. Add durable single-use lease dispatch and a runner-to-control-plane event protocol.
2. Provision a disposable local runner with non-root execution, limits, and cleanup.
3. Start Pi with `--mode rpc`, persist event streams, and support reconnecting to a task.
4. Add GitHub App installation, scoped tokens, patch review, and pull-request creation.
5. Move execution behind a self-hostable runner protocol before adding enterprise features.

## Security baseline

Treat every repository and Pi package as executable, untrusted input. The MVP requires per-task filesystem isolation, non-root execution, egress allowlisting, short-lived credentials, resource budgets, secret redaction, an audit trail, and automatic destruction.

Never attach a runner to a developer machine or expose broad cloud credentials. Pi Cloud retains only sanitized task output and must not depend on Pi's internal session-file format.

## Contributing

Prefer small vertical slices that preserve the control-plane/runner boundary. Do not add a dependency merely to anticipate a future feature; document the concrete requirement first.

## License

[MIT](LICENSE)

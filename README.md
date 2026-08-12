# Pi Cloud

> **Secure, ephemeral coding environments for Pi.**

Pi Cloud gives [Pi](https://pi.dev) a safe remote workspace: connect a repository, launch an isolated runner, steer the agent in real time, and turn the resulting patch into a pull request. It is deliberately **not** a browser clone of Pi or an IDE. Pi remains the agent; Pi Cloud provides the control plane, sandbox, and delivery workflow around it.

## Status

**Pre-alpha — foundation in progress.** This repository contains the initial monorepo, a health-checked control-plane service, and a runner contract. Nothing here should be used to process production repositories or credentials yet.

## Product principles

- **Pi-native, not Pi-shaped.** Run the existing Pi CLI in RPC mode rather than reimplementing its session or tool model.
- **Ephemeral by default.** One repository task gets one isolated workspace with a bounded lifetime.
- **Human steering, not black-box automation.** Stream agent events, show diffs and logs, and require explicit approval for consequential actions.
- **Provider freedom.** Start with bring-your-own provider credentials; do not make a proprietary model gateway the product.
- **Portable trust boundary.** A managed control plane should be able to dispatch jobs to runners in a customer VPC.

## Initial architecture

```text
GitHub App / web client
          │
          ▼
  Control plane (apps/api) ─── Postgres: tasks, users, audit records
          │
          │ signed, short-lived task lease
          ▼
  Runner (apps/runner) ─── isolated VM or container
          │                    ├── cloned repository
          │                    ├── scoped secrets
          │                    └── `pi --mode rpc`
          ▼
 event stream, patch, artifacts ─── control plane ─── client / GitHub PR
```

The control plane never executes repository code. Runners do, inside a sandbox with an explicit network policy, CPU/memory/time quotas, and cleanup after every task.

See [docs/architecture.md](docs/architecture.md) for component responsibilities and security boundaries.

## Repository layout

```text
apps/
  api/       Fastify control-plane API; currently exposes health metadata.
  runner/    Pi RPC runner entry point and sandbox-facing configuration.
docs/        Architecture and operating decisions.
```

## Prerequisites

- Node.js 22+
- npm 11+
- Docker or a VM-provider account will be required once sandbox provisioning lands
- A Pi-supported model credential for local runner development

## Quick start

```bash
npm install
cp .env.example .env
npm run dev:api
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","service":"pi-cloud-api"}
```

To validate the workspace:

```bash
npm run check
npm run build
npm test
```

## Dependencies

| Dependency | Role |
| --- | --- |
| [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | Pi CLI and its RPC mode, executed inside a runner. |
| [Fastify](https://fastify.dev/) + `@fastify/cors` | Small, typed control-plane HTTP API. |
| [Zod](https://zod.dev/) | Validate task leases, runner configuration, and untrusted webhook/API input. |
| TypeScript + `tsx` | Type-checking and fast local TypeScript execution. |

Postgres, a durable queue, object storage, a GitHub App SDK, and a browser automation service are intentional **next** dependencies—not install-time assumptions. We should choose each after the task and runner protocol are stable.

## Near-term milestones

1. Define authenticated task leases and a runner-to-control-plane event protocol.
2. Provision a disposable local Docker runner with a non-root user, limits, and cleanup.
3. Start Pi with `--mode rpc`, persist event streams, and support reconnecting to a task.
4. Add GitHub App repository installation, scoped tokens, patch review, and pull-request creation.
5. Move runner execution behind a self-hostable runner protocol before adding enterprise features.

## Security baseline

Treat every repository and Pi package as executable, untrusted input. The MVP must have per-task filesystem isolation, non-root execution, egress allowlisting, short-lived credentials, resource budgets, secret redaction in logs, an audit trail, and automatic destruction. Do not attach a runner to a developer machine or expose broad cloud credentials.

## Contributing

This is early-stage by design. Prefer small, vertical slices that preserve the control-plane/runner boundary. Do not add a dependency merely to anticipate a future feature; document the concrete requirement first.

## License

MIT — see [LICENSE](LICENSE).

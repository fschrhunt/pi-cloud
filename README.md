<p align="center">
  <img src="./assets/logo.svg" width="220" alt="Pi Cloud logo">
</p>

> A self-hosted remote runtime for Pi.

# Pi Cloud

Run an unmodified Pi session on an always-available server, then attach from a browser, CLI, or local Pi extension on any device.

> [!WARNING]
> Pi Cloud is **pre-alpha**. Use local fixtures and development credentials while the remote runtime and production isolation are under construction.

**Pi remains the agent.** Pi Cloud provides authentication, remote transport, workspace and process lifecycle, isolation, and scoped credentials around normal `pi --mode rpc`.

Read [`docs/product-scope.md`](docs/product-scope.md) for the canonical product contract and [`docs/architecture.md`](docs/architecture.md) for implementation boundaries.

## Principles

| Principle | Meaning |
| --- | --- |
| **Unmodified Pi** | Run the installed Pi CLI through its RPC/JSONL contract. |
| **Pi owns the session** | Pi remains authoritative for conversations, tools, compaction, models, and native session persistence. |
| **Available from any device** | Authenticated clients can attach, prompt, steer, cancel, disconnect, and reconnect. |
| **Persistent workspace, disposable process** | Repository and native Pi session data survive while idle Pi processes may stop and restart. |
| **Pi-native customization** | Use normal extensions, skills, prompts, providers, settings, and packages. |
| **Host-enforced security** | The host enforces authentication, isolation, credential scope, network policy, and resource limits. |
| **Self-hosted first** | The first supported deployment is one operator-owned Linux server. |

## Target architecture

```text
browser / CLI / local Pi extension
                 │
      authenticated HTTP + stream
                 ▼
        Pi Cloud API and router
                 │
        scoped runtime authority
                 ▼
        isolated runtime worker
          ├── persistent repository workspace
          ├── opaque native Pi sessions
          ├── operator Pi configuration
          ├── scoped credentials
          └── pi --mode rpc
```

The runtime worker exclusively owns repository workspaces, Pi execution, and repository tools. The API authenticates and routes clients.

## Target experience

```text
install Pi Cloud on a server
→ open an approved repository workspace
→ start a hosted Pi session
→ connect from another device
→ prompt, steer, follow up, cancel, and reconnect
→ customize it with normal Pi resources
```

Logical session availability continues while Pi Cloud stops idle processes and later resumes the same native Pi session in its persistent workspace.

## Pi-native cloud customization

Pi Cloud ships one small trusted Pi package for hosted capabilities beyond the RPC protocol. It uses Pi's public extension API and a narrow per-session capability channel.

Users customize hosted Pi through the same mechanisms as local Pi:

- global and project extensions;
- skills and prompt templates;
- settings and providers;
- Pi packages;
- project trust.

An operator-authorized administrative session updates persistent instance Pi configuration. Repository sessions receive the instance resources and capabilities selected by the operator.

## What works today

The implemented pre-alpha foundation includes:

- authenticated, SQLite-backed durable agents, runs, tasks, and lifecycle history;
- atomic dispatch and single-use Ed25519 task leases;
- budgets, heartbeats, bounded retry/recovery, and terminal reasons;
- append-only bounded summary events with SSE reconnect;
- hardened exact-revision checkout and provenance reporting;
- a restrictive local Docker runner baseline.

The next vertical slice starts Pi through RPC and attaches an authenticated remote client. See [`docs/control-plane-api.md`](docs/control-plane-api.md) and [`docs/task-leases.md`](docs/task-leases.md) for the implemented foundation.

## Roadmap

1. **Complete:** durable control-plane, secure dispatch, bounded events, and exact checkout foundation.
2. Start unmodified `pi --mode rpc` in one workspace and remotely prompt, stream, cancel, disconnect, and reconnect to the same native session.
3. Persist isolated workspaces and operator Pi configuration; add scoped credentials, process cleanup, resource limits, and a documented single-server installation.
4. Provide a minimal browser client and local Pi extension over the same authenticated API.
5. Prove native Pi extensions, skills, packages, providers, project trust, and one thin cloud capability extension work end to end.

## Quick start for the current foundation

### Requirements

- Node.js 22.5+ (`node:sqlite`)
- npm 11+
- Docker for the local runner smoke test

```bash
npm install

eval "$(node scripts/create-development-keys.mjs)" # Inspect the script first.
export PI_CLOUD_DISPATCHER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_USER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_API_CREDENTIALS="[{\"token\":\"$PI_CLOUD_USER_TOKEN\",\"subjectId\":\"local-user\",\"type\":\"user\",\"displayName\":\"Local User\"}]"
npm run dev:api
```

In another terminal:

```bash
curl http://localhost:3000/health
```

The current database defaults to `./data/pi-cloud.sqlite`. Docker supports local development and single-operator packaging; multi-tenant deployments require a stronger isolation boundary.

## Repository map

```text
packages/
  api/       Authentication, metadata, lifecycle, dispatch, and event transport
  runner/    Isolated repository and Pi runtime worker
  contracts/ Shared API/runtime wire contracts
assets/      Project identity assets
docs/        Product, architecture, and implemented-contract documentation
scripts/     Local development helpers
compose.yaml Local runner smoke test
```

## Development

```bash
npm run check
npm run build
npm test
```

Use Node.js 22+, npm workspaces, strict TypeScript, ESM, Fastify, and Zod. Prefer small vertical slices and add infrastructure only for a demonstrated requirement.

## Security baseline

Treat every repository, dependency, hook, and project Pi resource as executable untrusted input. Keep the API/runtime boundary, isolate every workspace, inject scoped credentials only when needed, bound and redact outbound records, enforce resource and network policy outside Pi, and guarantee explicit archive/delete cleanup.

Keep host sockets, broad cloud credentials, and long-lived secrets outside Pi and repository code. Store Pi native session files as opaque runtime data.

## License

[MIT](LICENSE)

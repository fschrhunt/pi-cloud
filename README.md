<p align="center">
  <a href="https://pi.dev">
    <img src="./assets/logo.svg" width="220" alt="Pi Cloud">
  </a>
</p>

# Pi Cloud

A self-hosted remote runtime for [Pi](https://pi.dev).

Run Pi on an always-available server and connect from a browser, CLI, or local Pi extension on any device. Your repository workspace and native Pi session stay available across client disconnects and runtime restarts.

Pi Cloud starts the installed CLI with `pi --mode rpc`. Pi owns the conversation, tools, models, compaction, and session data. Pi Cloud provides authenticated remote access, workspace and process lifecycle, isolation, and scoped credentials.

> [!WARNING]
> Pi Cloud is pre-alpha and currently targets single-operator deployments. Hosted Pi RPC execution, reconnect, and native session resume now work end-to-end; production isolation, pooling, and multi-tenant hardening are still under construction.

## Experience

```text
install Pi Cloud on your server
→ open a repository workspace
→ start a Pi session
→ connect from another device
→ prompt, steer, follow up, cancel, and reconnect
→ continue in the same session and workspace
```

A hosted session remains available while its Pi process is disposable. Pi Cloud can stop an idle process and later resume the native session in its persistent workspace.

## How it works

```text
browser / CLI / local Pi extension
                 │
   authenticated HTTP + WebSocket
                 ▼
        Pi Cloud API and router
                 │
        scoped runtime authority
                 ▼
        isolated runtime worker
          ├── persistent repository workspace
          ├── opaque native Pi session data
          ├── operator Pi configuration
          ├── scoped credentials
          └── pi --mode rpc
```

The API authenticates clients, manages lifecycle metadata, and routes connections. It does not mount repository workspaces. The runtime worker owns the workspace, starts Pi, and relays Pi's native JSONL RPC records.

Workspace files and native Pi session data persist independently from runtime processes and injected credentials. Clients reconnect through Pi's own session state.

## Customize Pi normally

Hosted Pi uses the same resources as local Pi:

- extensions;
- skills and prompt templates;
- settings and providers;
- Pi packages;
- project trust.

A small trusted Pi package supplies hosted capabilities that are not part of the RPC protocol. It uses Pi's public extension API and a capability channel scoped to one hosted session.

## Project status

The current pre-alpha slice includes:

- authenticated, SQLite-backed workspace, hosted-session, agent, run, and lifecycle metadata;
- atomic dispatch, single-use leases, and authenticated public and internal hosted-runtime WebSockets;
- exact-revision checkout, persistent workspaces, native Pi session resume, and scoped credential references;
- bounded hosted RPC envelopes, LF JSONL Pi supervision, reconnect, stop, restart, and redaction of configured secrets;
- a local single-operator Docker baseline and a hosted runtime smoke command.

Not yet included: multi-tenant isolation, pooling, horizontal scaling, and production hardening.

See [docs/hosted-runtime.md](docs/hosted-runtime.md) for the operator contract. Follow broader progress through the [GitHub milestones](https://github.com/fschrhunt/pi-cloud/milestones).

## Development

### Requirements

- Node.js 22.5 or newer
- npm 11 or newer
- Docker for the runner image and local smoke test

Install dependencies:

```bash
npm install
```

Start the current control plane:

```bash
eval "$(node scripts/create-development-keys.mjs)"
export PI_CLOUD_DISPATCHER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_USER_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CLOUD_API_CREDENTIALS="[{\"token\":\"$PI_CLOUD_USER_TOKEN\",\"subjectId\":\"local-user\",\"type\":\"user\",\"displayName\":\"Local User\"}]"
npm run dev:api
```

Check it from another terminal:

```bash
curl http://localhost:3000/health
```

The development database defaults to `./data/pi-cloud.sqlite`.

Run the repository checks:

```bash
npm run check
npm run build
npm test
```

Run the hosted runtime smoke flow against an already-running local API and a real HTTPS repository revision:

```bash
npm run smoke:hosted
```

It requires the operator-facing hosted runtime variables from [.env.example](.env.example), a built runner (`npm run build`), a reachable `pi` executable, and valid Pi model credentials/settings.

## Repository

```text
packages/
  api/       Authentication, lifecycle, dispatch, and remote transport
  contracts/ Shared API and runtime wire contracts
  runner/    Isolated repository and Pi runtime worker
assets/      Project identity assets
docs/        Product, architecture, and protocol documentation
scripts/     Development helpers
compose.yaml Local single-operator hosted runtime worker example
```

All workspaces use strict TypeScript and ESM on Node.js 22 or newer.

## Documentation

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Hosted runtime](docs/hosted-runtime.md)
- [Control-plane API](docs/control-plane-api.md)
- [Task leases](docs/task-leases.md)

## Security

Repository code, dependencies, hooks, and project Pi resources execute inside the runtime isolation boundary. The host enforces authentication, filesystem and process isolation, credential scope, network policy, resource limits, and cleanup.

The API stays separate from repository execution. Credentials enter only the operation that needs them, and public records are validated, bounded, and redacted.

## License

[MIT](LICENSE)

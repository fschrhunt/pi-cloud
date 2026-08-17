# Product scope

Pi Cloud is a self-hosted remote runtime for unmodified Pi. It keeps Pi, its repository workspace, and its native session on an available Linux server while the operator attaches from upstream Pi on a Mac with `pi --cloud`.

Pi remains the agent. Pi Cloud supplies authentication, remote transport, workspace and process lifecycle, isolation, scoped credentials, and a small bridge for cloud-specific capabilities.

## Primary experience

```text
run the Pi Cloud Compose stack on an operator-owned Linux server
→ install the Pi Cloud extension into upstream Pi on a Mac
→ run `pi --cloud` from a local Git repository
→ the server starts `pi --mode rpc`
→ prompt, steer, follow up, cancel, and reconnect
→ continue using the same native Pi session and remote workspace
```

A hosted session is logically available while its Pi process may stop when idle and resume later.

## Responsibilities

| Concern | Owner |
| --- | --- |
| Conversation, turns, tool calls, compaction, branching, model selection | Pi |
| Native session persistence and replacement semantics | Pi |
| Local terminal rendering and `--cloud` activation | Pi Cloud Mac extension |
| Authentication and authorization | Pi Cloud |
| Remote attachment and reconnect routing | Pi Cloud |
| Repository workspace and process lifecycle | Pi Cloud |
| Isolation, network enforcement, resource limits, and scoped credentials | Pi Cloud |
| Agent behavior, tools, prompts, providers, packages, and workflows | Pi extensions and packages |

A hosted session maps to one native Pi session in one workspace. Runtime restarts remain infrastructure events within that session.

## Pi integration

The runtime worker starts the installed Pi CLI with `pi --mode rpc`. Pi's LF-delimited JSONL RPC protocol carries commands, responses, events, state, and extension interactions. Pi reads and writes its native session files.

## Persistence

Pi Cloud persists:

- workspace identity, ownership, location, and lifecycle state;
- repository workspace data;
- the operator-owned Pi agent directory;
- Pi's native session files as opaque data;
- metadata required to authenticate, attach, recover, archive, and delete a hosted session.

The native Pi session is the canonical conversation. Clients reconnect through Pi RPC state and entry cursors.

## Public API

The Mac extension uses authenticated HTTP for workspace and hosted-session lifecycle operations. An authenticated bidirectional stream carries Pi commands, responses, events, and extension interactions.

The stream uses a small versioned envelope containing hosted-session identity, direction, sequence, and one Pi RPC record. The public boundary validates, bounds, and redacts records while preserving Pi semantics.

## Pi-native customization

Server-side Pi uses its normal resource system:

- global and project extensions;
- skills and prompt templates;
- settings and custom providers;
- Pi packages;
- project trust.

A trusted Pi package exposes cloud capabilities required by the hosted runtime through Pi's public extension API and a narrow per-session capability channel.

The persistent instance agent directory is operator-owned. An administrative Pi session can update it so Pi can customize future hosted sessions. Repository sessions receive a reviewed resource-only view selected by the operator; persisted provider authentication is excluded and credentials arrive through scoped claims. Project resources execute under Pi project trust inside the workspace boundary.

## Repository support

A workspace originates from an operator-approved local path or Git remote. Provider-specific workflows integrate through the hosted-session API and Pi packages.

## Deployment

The first deployment is one operator-owned Linux server. The API and runtime worker run as separate Compose services on that server, which invokes only `pi --mode rpc`. The `@pi-cloud/extension` package and `pi --cloud` run only on an Apple Silicon Mac client.

## Security invariants

- The API process authenticates and routes requests without mounting repository workspaces.
- The runtime worker owns repository access and Pi execution.
- Repository content, hooks, dependencies, and project Pi resources execute inside the runtime isolation boundary.
- Instance Pi resources are operator-approved and execute inside the same runtime boundary.
- Credentials come from operator-controlled storage and enter only the operation that needs them.
- Public records are schema-validated, size-bounded, and redacted.
- Authentication, isolation, credential scope, network policy, and resource enforcement remain host capabilities.

## Core capabilities

- self-hosted Compose deployment;
- a simple Mac Pi extension activated only by `pi --cloud`;
- authenticated workspace and hosted-session lifecycle;
- persistent isolated workspaces;
- Pi RPC process supervision and remote attachment;
- reconnect, cancellation, archive, and deletion;
- scoped credentials and resource limits;
- native Pi customization;
- a thin cloud capability extension when an RPC gap demonstrates the need.

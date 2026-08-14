# Product scope

Pi Cloud is a self-hosted remote runtime for unmodified Pi. It keeps Pi, its repository workspace, and its native session on an available server so a person can attach from a browser, CLI, or local Pi extension on any device.

Pi remains the agent. Pi Cloud supplies authentication, remote transport, workspace and process lifecycle, isolation, scoped credentials, and a small bridge for cloud-specific capabilities.

## Primary experience

```text
install Pi Cloud on an operator-owned server
→ open a repository workspace
→ start `pi --mode rpc`
→ attach from another device
→ prompt, steer, follow up, cancel, and reconnect
→ continue using the same native Pi session and workspace
```

A hosted session is logically available while its Pi process may stop when idle and resume later.

## Responsibilities

| Concern | Owner |
| --- | --- |
| Conversation, turns, tool calls, compaction, branching, model selection | Pi |
| Native session persistence and replacement semantics | Pi |
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

Authenticated HTTP handles server, workspace, and hosted-session lifecycle operations. An authenticated bidirectional stream carries Pi commands, responses, events, and extension interactions.

The stream uses a small versioned envelope containing hosted-session identity, direction, sequence, and one Pi RPC record. The public boundary validates, bounds, and redacts records while preserving Pi semantics.

## Pi-native customization

Server-side Pi uses its normal resource system:

- global and project extensions;
- skills and prompt templates;
- settings and custom providers;
- Pi packages;
- project trust.

A trusted Pi package exposes cloud capabilities required by the hosted runtime through Pi's public extension API and a narrow per-session capability channel.

The persistent instance agent directory is operator-owned. An administrative Pi session can update it so Pi can customize future hosted sessions. Repository sessions receive the instance resources selected by the operator, and project resources execute under Pi project trust inside the workspace boundary.

## Repository support

A workspace originates from an operator-approved local path or Git remote. Provider-specific workflows integrate through the hosted-session API and Pi packages.

## Deployment

The first deployment is one operator-owned Linux server. The API and runtime worker run as separate processes on that server. Docker packages the single-operator deployment and supports local development.

## Security invariants

- The API process authenticates and routes requests without mounting repository workspaces.
- The runtime worker owns repository access and Pi execution.
- Repository content, hooks, dependencies, and project Pi resources execute inside the runtime isolation boundary.
- Instance Pi resources are operator-approved and execute inside the same runtime boundary.
- Credentials come from operator-controlled storage and enter only the operation that needs them.
- Public records are schema-validated, size-bounded, and redacted.
- Authentication, isolation, credential scope, network policy, and resource enforcement remain host capabilities.

## Core capabilities

- self-hosted installation;
- authenticated workspace and hosted-session lifecycle;
- persistent isolated workspaces;
- Pi RPC process supervision and remote attachment;
- reconnect, cancellation, archive, and deletion;
- scoped credentials and resource limits;
- native Pi customization;
- a thin cloud capability extension.

# Architecture

Read [product-scope.md](product-scope.md) for the product contract and [hosted-runtime.md](hosted-runtime.md) for the operator-facing M2 wire contract.

## Purpose

Pi Cloud makes an unmodified Pi session available from another device. It separates remote orchestration from repository execution while preserving Pi's native sessions and customization model.

## Topology

```text
browser / CLI / local Pi extension
                 │
   authenticated HTTP + WebSocket
                 ▼
       API and session router (`packages/api`)
                 │
       scoped runtime capability
                 ▼
        runtime worker (`packages/runner`)
          ├── persistent workspace
          ├── opaque Pi session files
          ├── operator Pi agent directory
          ├── scoped operation credentials
          └── `pi --mode rpc`
```

The first deployment runs the API and runtime worker on one operator-owned Linux server as separate processes.

## API and session router

`packages/api` authenticates clients, authorizes workspace and hosted-session access, stores lifecycle metadata, starts or attaches runtime workers, and routes the public bidirectional stream.

HTTP handles create, list, get, start, stop, and archive operations. Authenticated public and internal WebSockets carry a versioned envelope around Pi RPC commands, responses, events, and extension interactions.

## Runtime worker

`packages/runner` opens one authorized workspace, receives only that workspace's API-resolved credentials in its claim, starts the installed Pi CLI in RPC mode, and relays LF-delimited JSONL records.

The trusted worker supervisor is disposable. It retains dispatcher authority, assigns each workspace a distinct operating-system UID, and starts untrusted Pi under that identity. Workspace storage roots are mode `0700`, so Pi cannot inspect the supervisor or sibling repositories and native sessions. A replacement worker derives the same UID and resumes the native session through Pi's CLI and RPC operations. Operator Pi resources are a reviewed, read-only, non-secret view; persisted provider authentication stays outside that view and arrives only through scoped claims. Each hosted session gets separate writable home and temporary directories beside its native session data.

## Workspace

A workspace has a stable identity, owner, repository origin, root directory, Pi agent-directory reference, active native session reference, and lifecycle state. Repository and session data survive client disconnects and idle runtime shutdown.

Workspace isolation applies to filesystem access, process execution, network policy, and credentials. Archive stops active execution while retaining data. M2 intentionally omits metadata-only deletion because persistent data must not be orphaned; the local provider supports explicit volume-wide cleanup.

## Pi process

The worker launches the installed Pi CLI with `pi --mode rpc`. Pi owns prompts, steering, follow-ups, cancellation, turns, tools, compaction, model selection, session replacement, and session persistence.

## Pi Cloud runtime extension

A trusted global Pi package adds hosted capabilities required beyond the RPC protocol, such as reading safe session metadata or publishing a cloud-specific result. It uses Pi's public extension API and a local capability endpoint authorized for one hosted session.

Users customize the runtime with ordinary Pi extensions, skills, prompts, providers, settings, packages, and project trust.

## Lifecycle

```text
client creates or opens workspace
→ API authorizes access
→ worker opens the isolated workspace
→ worker injects operation-scoped credentials
→ worker starts `pi --mode rpc`
→ client and Pi exchange RPC through the authenticated stream
→ client disconnects while Pi may continue
→ idle Pi process may stop
→ later attachment restarts Pi and resumes its native session
→ archive retains data, or an operator reset removes the local provider volume
```

A hosted session maps one-to-one to a native Pi session. Worker restarts remain infrastructure attempts within that session.

## Public transport

The public stream preserves Pi RPC records in an envelope containing protocol version, hosted-session ID, sequence, direction, and payload.

The runtime boundary:

- validates command and envelope schemas;
- enforces record and cumulative size limits;
- redacts configured secrets from outbound records;
- applies explicit field policy;
- preserves finalized Pi messages and settled state as authoritative.

Reconnect uses Pi RPC state and entry cursors. Cloud metadata records connection and process state while Pi remains the canonical transcript.

## Trust boundaries

| Boundary | Contract |
| --- | --- |
| Client → API | Authenticate the request and authorize its workspace and hosted session. |
| API → runtime worker | Grant authority scoped to one workspace, hosted session, operation, and lifetime. |
| Runtime → repository | Execute repository code and project Pi resources inside the workspace boundary. |
| Runtime → instance resources | Load operator-approved Pi resources inside the runtime boundary. |
| Runtime → network | Apply the operator network policy outside Pi. |
| Runtime → API/client | Validate envelopes, bound records, and redact scoped credentials. |
| Pi extension → cloud bridge | Expose allowlisted capabilities scoped to the hosted session. |

## Persistence

Persistent data includes workspace files, Git metadata, operator Pi resources, opaque native Pi sessions, and lifecycle metadata. Runtime processes, temporary files, and injected operation credentials have bounded lifetimes.

## Current vertical slice

```text
open one workspace
→ claim one hosted runtime
→ start unmodified Pi RPC in the runner
→ attach an authenticated client
→ prompt and stream native Pi events
→ disconnect and reconnect
→ stop and restart the runtime
→ resume the same native Pi session in the same workspace
```

This slice now works end-to-end for one operator-owned server. It remains pre-alpha and does not yet provide multi-tenant hardening or production pooling.

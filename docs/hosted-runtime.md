# Hosted runtime

This document describes the operator-facing M2 contract between `packages/api`, `packages/runner`, and any public client attached to a hosted Pi session.

## Minimal configuration

API:

- `PI_CLOUD_PUBLIC_BASE_URL`
- `PI_CLOUD_RUNTIME_WORKSPACE_ROOT`
- `PI_CLOUD_RUNTIME_AGENT_DIRECTORY`
- `PI_CLOUD_HOSTED_LAUNCH_LIMITS`
- `PI_CLOUD_HOSTED_CREDENTIAL_REFERENCES`
- `PI_CLOUD_HOSTED_CREDENTIALS`
- normal API auth, dispatcher, and lease keys

Hosted runner:

- `PI_CLOUD_HOSTED_DISPATCHER_URL`
- `PI_CLOUD_HOSTED_DISPATCHER_TOKEN`
- `PI_CLOUD_RUNNER_ID`
- `PI_CLOUD_HOSTED_WORKSPACE_ROOTS`
- `PI_CLOUD_HOSTED_SESSION_ROOTS`
- `PI_CLOUD_HOSTED_AGENT_ROOTS`
- `PI_CLOUD_HOSTED_PROCESS_ISOLATION` (`workspace_uid` for untrusted execution)
- optional `PI_CLOUD_PI_EXECUTABLE`

See [../.env.example](../.env.example) for a local single-operator example.

## Lifecycle endpoints

Workspaces:

- `POST /v1/workspaces` create `{ repositoryUrl, revision, projectTrust?, credentialReferenceNames? }`
- `GET /v1/workspaces`
- `GET /v1/workspaces/:workspaceId`
- `POST /v1/workspaces/:workspaceId/sessions`

Hosted sessions:

- `GET /v1/hosted-sessions/:sessionId`
- `POST /v1/hosted-sessions/:sessionId/start`
- `POST /v1/hosted-sessions/:sessionId/stop`
- `POST /v1/hosted-sessions/:sessionId/archive`
- `DELETE /v1/hosted-sessions/:sessionId`
- `GET /v1/hosted-sessions/:sessionId/rpc` public authenticated WebSocket

Internal worker endpoints:

- `POST /internal/v1/hosted-runtimes/claim`
- `GET /internal/v1/hosted-sessions/:sessionId/tunnel` authenticated internal WebSocket

A new hosted session starts in `queued`. Claiming it moves the durable state to `starting`; the worker then connects the internal tunnel, sends `pi_cloud_runtime_ready`, and the API marks it `running`. `stop` durably marks the session stopped, revokes the assignment, and sends an out-of-band `pi_cloud_stop` control. A replacement cannot start until the old runtime tunnel closes. `start` then re-queues the stopped session for another claim.

## Version 1 launch contract

Each internal claim returns:

```json
{
  "launch": {
    "version": 1,
    "hostedSessionId": "uuid",
    "workspaceId": "uuid",
    "workspaceRoot": "/srv/pi-cloud/workspaces/<workspace-id>/repository",
    "repository": {
      "repositoryUrl": "https://github.com/org/repo",
      "revision": "<full-commit-sha>"
    },
    "nativeSession": {
      "kind": "new",
      "sessionDirectory": "/srv/pi-cloud/workspaces/<workspace-id>/native-sessions/<session-id>"
    },
    "piAgentDirectory": "/srv/pi-cloud/agent",
    "credentialReferences": [
      {
        "name": "provider",
        "reference": "vault://provider/key",
        "environmentVariable": "ANTHROPIC_API_KEY"
      }
    ],
    "limits": {
      "wallTimeSeconds": 3600,
      "idleTimeSeconds": 300,
      "terminationGraceSeconds": 5,
      "maxRecordBytes": 65536,
      "maxCumulativeBytes": 10000000
    },
    "projectTrust": "untrusted"
  },
  "tunnel": {
    "url": "wss://pi-cloud.example.com/internal/v1/hosted-sessions/<session-id>/tunnel",
    "token": "short-lived-scoped-assignment-token"
  }
}
```

`nativeSession.kind` is `new` for the first launch and `resume` with `sessionFile` after the runtime records Pi's startup `get_state` response.

## Public and internal WebSockets

Public client:

- endpoint: `GET /v1/hosted-sessions/:sessionId/rpc`
- auth: normal API bearer token
- policy: one active client per hosted session

Internal runtime tunnel:

- endpoint: `GET /internal/v1/hosted-sessions/:sessionId/tunnel`
- auth: the claim's tunnel bearer token only
- policy: one active runtime per hosted session

The API validates both channels against the same versioned envelope, enforces strict per-channel sequencing, and rejects cross-session traffic.

## Envelope format

Every WebSocket text frame is one complete JSON object:

```json
{
  "version": 1,
  "hostedSessionId": "uuid",
  "direction": "client_to_pi",
  "sequence": 1,
  "record": { "type": "prompt", "id": "req-1", "message": "hello" }
}
```

- `direction` is `client_to_pi` on the public socket and `pi_to_client` on the runtime tunnel.
- `sequence` is strictly contiguous per channel.
- binary frames are rejected.
- public and internal transports preserve Pi RPC records unchanged apart from re-sequencing.

## Supported client commands

The hosted boundary accepts these initial Pi commands:

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `get_entries`
- `extension_ui_response`

`prompt`, `steer`, and `follow_up` preserve Pi's native message fields. `extension_ui_response` must contain exactly one of `value`, `confirmed`, or `cancelled: true`.

## Strict LF JSONL to Pi

The runner talks to the installed Pi CLI through stdin/stdout only:

- `pi --mode rpc`
- one UTF-8 JSON object per line
- LF (`\n`) delimiters only
- no binary records
- malformed or partial output fails the runtime

On first startup the runner sends its reserved `get_state` probe (`id = "pi-cloud-internal-startup-state"`). The API intercepts only that success response to persist `nativeSessionId` and `nativeSessionFile`; it is never forwarded to the public client.

## Reconnect and resume

Client disconnects do not stop the runtime. Reconnect with a new public WebSocket and then ask Pi for state with `get_state` or transcript entries with `get_entries`.

- the new public client starts its own inbound sequence at `1`
- the runtime tunnel sequence continues across public reconnects
- the API does not persist transcript events; Pi's native session remains canonical

When a stopped session starts again, the next launch switches to `nativeSession.kind = "resume"`, and the runner starts Pi with `--session <nativeSessionFile>` in the recorded session directory.

## Trust and path roots

`projectTrust` controls the Pi argv:

- `trusted` → `--approve`
- `untrusted` → `--no-approve`

The API only computes path strings. The runner independently authorizes real paths against its configured roots:

- `workspaceRoot` must stay under `PI_CLOUD_HOSTED_WORKSPACE_ROOTS`
- `sessionDirectory` or `sessionFile` must stay under `PI_CLOUD_HOSTED_SESSION_ROOTS`
- `piAgentDirectory` must stay under `PI_CLOUD_HOSTED_AGENT_ROOTS`

Symlink escapes fail closed.

## Credential references and redaction

The database stores credential references, not values. The trusted API holds the operator's `PI_CLOUD_HOSTED_CREDENTIALS` map. A workspace requests references by name, and an authenticated claim returns only the values granted to that workspace. The long-lived runner container never receives the complete provider credential map in its startup environment.

Credential values are:

- sent only in the short-lived authenticated claim response, never through the public or RPC WebSocket;
- mapped to the launch's allowlisted environment-variable names immediately before Pi starts;
- scrubbed from claim and runner objects after use;
- redacted from outbound Pi records and bounded stderr diagnostics.

## Limits and failure behavior

`limits` apply to both Pi supervision and WebSocket routing:

- `wallTimeSeconds`
- `idleTimeSeconds`
- `terminationGraceSeconds`
- `maxRecordBytes`
- `maxCumulativeBytes`

Stable policy close codes:

- `4400` invalid JSON, schema, direction, or binary frame
- `4404` cross-session envelope
- `4409` sequence gap or duplicate attachment
- `4410` runtime disconnected
- `4413` per-record or cumulative byte limit exceeded

Other important failures:

- missing credential values fail the worker before Pi starts;
- repository or path mismatches fail the runtime attempt; unconnected assignment authority expires after 60 seconds;
- a `resume` launch without the persistent repository fails closed;
- API restarts drop live sockets, revoke stale runtime assignments, and stop affected sessions; after an explicit restart, a replacement worker resumes Pi before clients reconnect through Pi state;
- `archive` and `delete` require the session to be stopped first.

## Local Compose worker

The Compose worker reaches a host-run API through `host.docker.internal`. For that local-only setup, start the API with `PI_CLOUD_PUBLIC_BASE_URL=http://host.docker.internal:3000`, set `PI_CLOUD_HOSTED_CONTAINER_DISPATCHER_URL` if the API uses another container-facing address, and set `PI_CLOUD_HOSTED_DISPATCHER_TOKEN` to the same value as the API's `PI_CLOUD_DISPATCHER_TOKEN`. Compose intentionally ignores the host-only loopback `PI_CLOUD_HOSTED_DISPATCHER_URL`.

Compose uses fixed `/var/lib/pi-cloud/workspaces` and `/var/lib/pi-cloud/agent` mount targets; the generic runner root overrides are intentionally not applied to this provider. The shared operator Pi agent directory is mounted read-only.

The trusted root supervisor keeps dispatcher authority and the full workspace volume. Before starting Pi, it assigns a stable high-numbered UID to the claimed workspace, makes that workspace's storage root mode `0700`, checks for UID collisions, and drops the Pi child to that UID. Sibling workspace repositories and native sessions are therefore inaccessible, and Pi cannot read the root supervisor's dispatcher token through `/proc`. Pi receives writable `HOME`, `TMPDIR`, `TMP`, and `TEMP` directories under its own hosted session directory.

Compose retains workspace data until the operator explicitly removes the local provider volume. After deleting or archiving any metadata that must be retained, run `docker compose down --volumes` to remove all local checkouts and native session files. Per-workspace physical deletion is not part of this M2 Docker provider.

Cleartext HTTP and WebSocket transport is accepted only for loopback and the Docker host alias; use HTTPS/WSS elsewhere.

## Smoke test

`npm run smoke:hosted` starts a dedicated temporary API and exercises the public flow with a real built runner and Pi executable. It requires a real HTTPS repository URL and full commit SHA, operator-configured Pi model access, and matching hosted credential-reference values when the workspace requests them. The flow verifies native transcript entries after worker replacement, deletes the stopped hosted session through the public API, then removes its temporary database, repository checkout, and native session files on every exit.

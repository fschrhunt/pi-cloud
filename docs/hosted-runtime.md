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
- optional container-internal `PI_CLOUD_PI_EXECUTABLE` as a PATH command name or absolute trusted image path (the bundled image provides `pi`)

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
- `POST /v1/hosted-sessions/:sessionId/rpc-ticket` mint a browser-compatible attachment ticket
- `GET /v1/hosted-sessions/:sessionId/rpc` public authenticated WebSocket

Internal worker endpoints:

- `POST /internal/v1/hosted-runtimes/claim`
- `GET /internal/v1/hosted-sessions/:sessionId/tunnel` authenticated internal WebSocket

A new hosted session starts in `queued`. Claiming it moves the durable state to `starting`; the worker then connects the internal tunnel, sends `pi_cloud_runtime_ready`, and the API marks it `running`. `stop` durably marks the session stopped, revokes the assignment, and sends an out-of-band `pi_cloud_stop` control. A replacement cannot start anywhere in the workspace until the old runtime tunnel closes; a tunnel that outstays `terminationGraceSeconds` plus the heartbeat window after `stop` is force-closed. `start` then re-queues the stopped session for another claim.

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
- non-browser auth: normal API bearer token in `Authorization`
- browser auth: mint a ticket with an authenticated `POST /v1/hosted-sessions/:sessionId/rpc-ticket`, then open the WebSocket with subprotocols `pi-cloud-rpc` and `pi-cloud-ticket.<ticket>`
- ticket policy: random, single-use, valid for 60 seconds, scoped to one hosted session, and one outstanding ticket per session
- policy: one active client per hosted session

The browser flow keeps bearer credentials out of WebSocket URLs and works with the native browser `WebSocket` API:

```js
const response = await fetch(`/v1/hosted-sessions/${sessionId}/rpc-ticket`, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiToken}` },
});
const { ticket } = await response.json();
const socket = new WebSocket(
  `/v1/hosted-sessions/${sessionId}/rpc`,
  ["pi-cloud-rpc", `pi-cloud-ticket.${ticket}`],
);
```

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

- a public client sends `client_to_pi` and receives `pi_to_client`;
- a runtime tunnel receives `client_to_pi` and sends `pi_to_client`;
- `sequence` is strictly contiguous for each sender connection;
- binary frames are rejected;
- native Pi RPC record structure is preserved, but configured secret values are replaced by `[REDACTED]` before any `pi_to_client` envelope crosses the runtime boundary.

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
- `4408` duplicate runtime or client attachment
- `4409` sequence gap
- `4410` runtime disconnected or heartbeat expired
- `4413` cumulative or routed-record byte limit exceeded
- `1009` frame rejected by the WebSocket server before routing because it exceeds `maxRecordBytes`

Other important failures:

- missing credential values fail the worker before Pi starts;
- repository or path mismatches fail the runtime attempt; unconnected assignment authority expires after 60 seconds;
- connected workers send 15-second heartbeat controls, and the API stops a runtime after 60 seconds without authenticated activity;
- a `resume` launch without the persistent repository fails closed;
- API restarts drop live sockets, revoke stale runtime assignments, and stop affected sessions; after an explicit restart, a replacement worker resumes Pi before clients reconnect through Pi state;
- `archive` requires the session to be stopped and its runtime tunnel to be fully closed first;
- metadata-only session deletion is intentionally unavailable because it would orphan persistent native data.

## Local Compose worker

The Compose worker reaches a host-run API through `host.docker.internal`. For that local-only setup, start the API with `PI_CLOUD_PUBLIC_BASE_URL=http://host.docker.internal:3000`, set `PI_CLOUD_HOSTED_CONTAINER_DISPATCHER_URL` if the API uses another container-facing address, and set `PI_CLOUD_HOSTED_DISPATCHER_TOKEN` to the same value as the API's `PI_CLOUD_DISPATCHER_TOKEN`. Compose intentionally ignores the host-only loopback `PI_CLOUD_HOSTED_DISPATCHER_URL`.

Compose uses fixed `/var/lib/pi-cloud/workspaces` and `/var/lib/pi-cloud/agent` mount targets; the generic runner root overrides are intentionally not applied to this provider. `PI_CLOUD_HOST_AGENT_DIRECTORY` must point to a reviewed, resource-only Pi directory. Compose bind-mounts it read-only, and startup rejects `auth.json`, native `sessions`, symbolic links, or paths that isolated workspace UIDs cannot read and traverse.

Do not mount or copy a complete `~/.pi/agent`: it can contain persisted provider tokens in `auth.json` and other operator-only state. Build a sanitized directory from only the resources that hosted repositories should receive, then review any `settings.json` or `models.json` separately and use environment references for scoped credentials rather than literal values:

```bash
source_agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p data/pi-agent
for resource in AGENTS.md SYSTEM.md APPEND_SYSTEM.md extensions skills prompts themes; do
  test ! -e "$source_agent/$resource" || cp -R "$source_agent/$resource" data/pi-agent/
done
chmod -R go+rX data/pi-agent
```

The default bind source is `./data/pi-agent`. A fresh deployment must prepare it before starting the worker. The container has writable `/run` storage for firewall locks and only the capabilities needed to configure networking, manage per-workspace ownership and modes, drop identities, and terminate workspace processes.

The trusted root supervisor keeps dispatcher authority and the full workspace volume. Its firewall permits public Git/provider egress but rejects host, link-local, carrier-grade NAT, and RFC1918 destinations for every non-root Pi UID. Before starting Pi, it assigns a stable high-numbered UID to the claimed workspace, makes that workspace's storage root mode `0700`, checks for UID collisions, and drops the Pi child to that UID. Sibling workspace repositories and native sessions are therefore inaccessible, and Pi cannot read the root supervisor's dispatcher token through `/proc`. Pi receives writable `HOME`, `TMPDIR`, `TMP`, and `TEMP` directories under its own hosted session directory.

Compose retains workspace data until the operator explicitly removes the local provider volume. After deleting or archiving any metadata that must be retained, run `docker compose down --volumes` to remove all local checkouts and native session files. Per-workspace physical deletion is not part of this M2 Docker provider.

Cleartext HTTP and WebSocket transport is accepted only for loopback and the Docker host alias; use HTTPS/WSS elsewhere.

## Smoke test

`npm run smoke:hosted` loads `.env` when present, starts a dedicated temporary API on a container-reachable interface while keeping its public client URL on loopback, builds the runner image, and runs each smoke worker inside the same container isolation boundary as Compose. It uses `PI_CLOUD_SMOKE_AGENT_DIRECTORY`, then `PI_CLOUD_HOST_AGENT_DIRECTORY`, then `./data/pi-agent`; that directory must satisfy the same sanitized, readable resource contract described above. `PI_CLOUD_SMOKE_PI_EXECUTABLE` names a PATH command or absolute trusted executable already installed inside the Linux runner image; otherwise smoke workers use the image's bundled `pi`. Host executables are intentionally not mounted because macOS binaries and host-only launchers cannot run inside the container.

The smoke flow requires a real HTTPS repository URL and full commit SHA, operator-configured Pi model access, and matching hosted credential-reference values when the workspace requests them. A root helper inside the container boundary verifies the sealed checkout and native session without granting the host account access to workspace-UID data. The flow verifies native transcript entries after worker replacement, archives the stopped hosted session through the public API, and handles normal completion, failures, `SIGINT`, and `SIGTERM` by removing its Compose resources, temporary database, checkout, and native session files.

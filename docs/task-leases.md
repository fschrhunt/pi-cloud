# Task leases

A task lease is Pi Cloud's short-lived authorization for the local Pi host to start one immutable repository operation. The control plane signs leases with Ed25519; the Pi host receives only the public verification key and cannot mint authority.

## Wire contract

A lease is `<payload>.<signature>`, where both parts use unpadded base64url. The payload is versioned JSON with:

- `version`, currently `1`;
- unique `leaseId` and `taskId` UUIDs;
- HTTPS `repositoryUrl` and immutable Git `revision`;
- `issuer` and runner-pool `audience`;
- integer `issuedAt` and `expiresAt` Unix timestamps.

An internal dispatcher authenticates with `PI_CLOUD_DISPATCHER_TOKEN` and atomically claims the oldest eligible task through `POST /internal/v1/runs/claim`. The control plane issues at most five-minute leases. Before repository execution, the assigned runner sends the lease and its explicit `runnerId` to `POST /internal/v1/leases/redeem`; the control plane verifies its Ed25519 signature, schema, version, issuer, audience, issue time, expiry, task, and runner assignment. Tokens and keys must never be logged.

## Development keys

Generate shell exports for a base64 DER key pair without writing unencrypted PEM files:

```bash
eval "$(node scripts/create-development-keys.mjs)"
```

Inspect scripts before evaluating their output. Store the private key only with the control-plane configuration. Mount only the public key into the Pi host. `scripts/create-development-lease.mjs` can mint a local test lease after building `@pi-cloud/contracts`; do not use these development helpers for a production self-hosted installation.

## Replay boundary

Assignment, expiry, audience, runner identity, token digest, redemption, heartbeat, and revocation are durable. Dispatch commits one assignment before returning authority; redemption changes one unconsumed row and rejects replay, stale assignment, expiry, task mismatch, audience mismatch, and wrong runner. Raw tokens are never persisted.

After redemption, runner requests prove possession against the stored digest. This permits checkout provenance writes and heartbeat-based liveness beyond the five-minute redemption window without reissuing or extending the signed lease. Recovery revokes an old assignment before requeueing, so a lost runner cannot continue after another runner claims the task.

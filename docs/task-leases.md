# Task leases

A task lease is Pi Cloud's short-lived authorization for one runner to execute one immutable repository task. The control plane signs leases with Ed25519; runners receive only the public verification key and cannot mint authority.

## Wire contract

A lease is `<payload>.<signature>`, where both parts use unpadded base64url. The payload is versioned JSON with:

- `version`, currently `1`;
- unique `leaseId` and `taskId` UUIDs;
- HTTPS `repositoryUrl` and immutable Git `revision`;
- `issuer` and runner-pool `audience`;
- integer `issuedAt` and `expiresAt` Unix timestamps.

An internal dispatcher authenticates with `PI_CLOUD_DISPATCHER_TOKEN` and requests a lease for an existing queued task through `POST /internal/v1/tasks/:taskId/lease`. The control plane issues at most five-minute leases. The runner verifies the Ed25519 signature, schema, version, issuer, audience, issue time, and expiry before repository execution can begin. Tokens and keys must never be logged.

## Development keys

Generate shell exports for a base64 DER key pair without writing unencrypted PEM files:

```bash
eval "$(node scripts/create-development-keys.mjs)"
```

Inspect scripts before evaluating their output. Store the private key only in the control-plane secret store. Mount only the public key into a runner. For the local Compose smoke test, build `@pi-cloud/contracts` and use `scripts/create-development-lease.mjs` as shown in the README; do not use these helpers as a hosted key-management or dispatch mechanism.

## Replay boundary

A unique lease ID makes replay detectable, but the current in-memory vertical slice does not persist lease consumption. Until durable dispatch state exists, a valid unexpired token can be replayed against the same runner audience. Short expiry limits exposure but does not provide single-use enforcement.

Before runners clone repositories, dispatch must atomically mark each `leaseId` consumed and reject subsequent claims. That state belongs in the control plane, not in a process-local runner cache.

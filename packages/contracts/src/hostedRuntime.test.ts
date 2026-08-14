import assert from "node:assert/strict";
import test from "node:test";
import {
  hostedRpcClientEnvelopeSchema,
  hostedRuntimeLaunchSchema,
  parseBoundedHostedRpcEnvelope,
} from "./index.js";

const hostedSessionId = "a0d701e3-bae6-427a-bc22-35d885915da3";

test("hosted runtime launch requires immutable, absolute, explicitly trusted inputs", () => {
  const launch = hostedRuntimeLaunchSchema.parse({
    version: 1,
    hostedSessionId,
    workspaceId: "66f9b7c1-6e3e-40d2-bdcf-dc5c3b6c91d9",
    workspaceRoot: "/srv/pi-cloud/workspaces/example",
    repository: {
      repositoryUrl: "https://github.com/pi-cloud/example",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    nativeSession: { kind: "new", sessionDirectory: "/srv/pi-cloud/sessions/example" },
    piAgentDirectory: "/srv/pi-cloud/agent",
    credentialReferences: [
      { name: "provider", reference: "vault://provider/key", environmentVariable: "ANTHROPIC_API_KEY" },
    ],
    limits: {
      wallTimeSeconds: 3_600,
      idleTimeSeconds: 300,
      terminationGraceSeconds: 5,
      maxRecordBytes: 16_384,
      maxCumulativeBytes: 1_000_000,
    },
    projectTrust: "untrusted",
  });
  assert.equal(launch.projectTrust, "untrusted");
  assert.throws(() => hostedRuntimeLaunchSchema.parse({ ...launch, workspaceRoot: "relative/path" }));
  assert.throws(() => hostedRuntimeLaunchSchema.parse({ ...launch, repository: { ...launch.repository, revision: "main" } }));
  assert.throws(() => hostedRuntimeLaunchSchema.parse({
    ...launch,
    credentialReferences: [...launch.credentialReferences, ...launch.credentialReferences],
  }));
});

test("client RPC validation preserves request ids and additional native JSON payload", () => {
  const envelope = hostedRpcClientEnvelopeSchema.parse({
    version: 1,
    hostedSessionId,
    direction: "client_to_pi",
    sequence: 1,
    record: { id: "request-7", type: "prompt", message: "hello", nativeAddition: { enabled: true } },
  });
  assert.equal(envelope.record.id, "request-7");
  assert.deepEqual(envelope.record.nativeAddition, { enabled: true });
  assert.throws(() =>
    hostedRpcClientEnvelopeSchema.parse({
      ...envelope,
      record: { type: "prompt", message: 42 },
    }),
  );
  assert.throws(() =>
    hostedRpcClientEnvelopeSchema.parse({
      ...envelope,
      record: { type: "get_state", id: "pi-cloud-internal-startup-state" },
    }),
  );
});

test("bounded envelope parsing accounts for UTF-8 bytes cumulatively", () => {
  const value = {
    version: 1,
    hostedSessionId,
    direction: "pi_to_client" as const,
    sequence: 1,
    record: { type: "event", text: "é" },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.equal(
    parseBoundedHostedRpcEnvelope(value, { maxRecordBytes: bytes, maxCumulativeBytes: bytes }).cumulativeBytes,
    bytes,
  );
  assert.throws(
    () => parseBoundedHostedRpcEnvelope(value, { maxRecordBytes: bytes - 1, maxCumulativeBytes: bytes }),
    /maxRecordBytes/,
  );
});
